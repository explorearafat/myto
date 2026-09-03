import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/**
 * Structured long-term memory (Phase 5) — the durable, file-per-fact store behind
 * Sylor's global user profile, mirroring the way this assistant keeps its own
 * memory: one Markdown file per fact (with YAML-ish frontmatter) plus a
 * human-readable `MEMORY.md` index, all under a single directory.
 *
 * Why files instead of the old flat `{ notes: [] }` JSON:
 *  - inspectable — a person can open `~/…/memory/` and read/prune what Sylor knows;
 *  - each fact carries metadata (a slug, an insertion ordinal, a created date);
 *  - it supports {@link MemoryStore.recall} — scoring facts against the current
 *    turn so a large memory injects only what's relevant, not all of it.
 *
 * The class is deliberately pure and Electron-free: it takes a base directory, so
 * a test drives it against a temp dir with the real filesystem, and the main
 * process wires it to `<userData>/memory` (see settings.ts). Everything is
 * best-effort — a garbage or unreadable file is skipped, never thrown — so a
 * corrupt entry can't take down a run.
 */

/** One remembered fact, parsed from its on-disk `NNNN-slug.md` file. */
export interface MemoryFact {
  /** Insertion ordinal, encoded as the filename's zero-padded prefix (ascending). */
  seq: number
  /** Kebab-case slug — the filename stem after the `seq-` prefix. */
  slug: string
  /** The fact text, whitespace-normalized (single spaces, trimmed). */
  text: string
  /** ISO-8601 timestamp the fact was first recorded (frontmatter `created`). */
  created: string
}

/** Result of a {@link MemoryStore.remember} call. */
export interface RememberResult {
  /** True when the fact was newly written (false for a blank or duplicate). */
  added: boolean
  /** The stored fact, present when `added` is true. */
  fact?: MemoryFact
}

/** Most facts kept before the oldest are pruned — bounds the on-disk + prompt cost. */
const DEFAULT_MAX_FACTS = 80

/** Filename shape: a zero-padded ordinal, a dash, the slug, then `.md`. */
const FACT_FILE_RE = /^(\d+)-(.+)\.md$/i

/** The human-readable index file written alongside the per-fact files. */
const INDEX_FILE = 'MEMORY.md'

/** Common words that carry no signal for relevance scoring. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'your',
  'with',
  'that',
  'this',
  'how',
  'are',
  'was',
  'but',
  'not',
  'can',
  'will',
  'has',
  'have',
  'from',
  'about',
  'into',
  'they',
  'them',
  'when',
  'what',
  'which',
  'their',
  'would',
  'should',
  'could'
])

/** Normalize a fact to a single-spaced, trimmed line (the canonical form). */
function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** Lowercased, de-duped content tokens (≥3 chars, no stopwords) for scoring. */
function tokenize(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of query.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const tok = m[0]
    if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  return out
}

/** A kebab-case slug from a fact's opening words (bounded, never empty). */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
  return slug || 'note'
}

/**
 * Parse one fact file's contents into `{ created, text }`. Tolerates a missing or
 * malformed frontmatter block: with no leading `---` the whole file is the text,
 * so even a hand-edited entry survives. Returns null only for an empty body.
 */
function parseFactFile(raw: string): { created: string; text: string } | null {
  let created = ''
  let bodyStart = 0
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    let i = 1
    for (; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        i++
        break
      }
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(lines[i])
      if (m && m[1].toLowerCase() === 'created') created = m[2].trim()
    }
    bodyStart = i
  }
  const text = normalizeText(lines.slice(bodyStart).join('\n'))
  if (!text) return null
  return { created, text }
}

/**
 * A directory of remembered facts. Loads lazily (once), caches in memory, and
 * keeps the cache in sync on every write so reads never re-hit the disk.
 */
export class MemoryStore {
  private readonly dir: string
  private readonly maxFacts: number
  private facts: MemoryFact[] | null = null

  constructor(baseDir: string, opts: { maxFacts?: number } = {}) {
    this.dir = baseDir
    this.maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS
  }

  /** Load + parse every `NNNN-slug.md` once, sorted by seq (insertion order). */
  private load(): MemoryFact[] {
    if (this.facts) return this.facts
    const facts: MemoryFact[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      names = [] // missing dir — an empty store
    }
    for (const name of names) {
      const m = FACT_FILE_RE.exec(name)
      if (!m) continue
      let raw: string
      try {
        raw = readFileSync(join(this.dir, name), 'utf-8')
      } catch {
        continue // unreadable — skip
      }
      const parsed = parseFactFile(raw)
      if (!parsed) continue
      facts.push({ seq: Number.parseInt(m[1], 10), slug: m[2], text: parsed.text, created: parsed.created })
    }
    facts.sort((a, b) => a.seq - b.seq)
    this.facts = facts
    return facts
  }

  /** All facts in insertion order (a shallow copy — safe to iterate/mutate). */
  list(): MemoryFact[] {
    return [...this.load()]
  }

  /** Whether a fact with this (normalized, case-folded) text already exists. */
  has(text: string): boolean {
    const norm = normalizeText(text).toLowerCase()
    return this.load().some((f) => f.text.toLowerCase() === norm)
  }

  /** The facts as prompt-ready bullets in insertion order, or '' when empty. */
  asBullets(): string {
    const facts = this.load()
    return facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : ''
  }

  /**
   * Record one durable fact. Returns `{ added: false }` for a blank or an
   * exact (case-insensitive) duplicate; otherwise writes a new `NNNN-slug.md`,
   * refreshes the index, prunes past the cap, and returns the stored fact.
   * Best-effort: a write failure leaves the in-memory cache untouched.
   */
  remember(raw: string, nowIso: string): RememberResult {
    const text = normalizeText(raw)
    if (!text) return { added: false }
    const facts = this.load()
    if (facts.some((f) => f.text.toLowerCase() === text.toLowerCase())) return { added: false }

    const seq = (facts.length ? facts[facts.length - 1].seq : 0) + 1
    const slug = this.uniqueSlug(slugify(text), facts)
    const fact: MemoryFact = { seq, slug, text, created: nowIso }

    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.factPath(fact), this.serializeFact(fact), 'utf-8')
    } catch {
      return { added: false } // couldn't persist — don't pretend we did
    }
    facts.push(fact)
    this.enforceCap(facts)
    this.writeIndex(facts)
    return { added: true, fact }
  }

  /**
   * The facts most relevant to `query`, best first, capped at `limit`. Scores by
   * how many distinct query tokens appear in a fact, breaking ties toward the
   * newer fact. When fewer than `limit` facts match (or the query has no usable
   * tokens) the remainder is filled with the most-recent facts, so recall never
   * returns less context than a plain "most recent N" would.
   */
  recall(query: string, limit: number): MemoryFact[] {
    const facts = this.load()
    if (limit <= 0 || facts.length === 0) return []
    const toks = tokenize(query)
    if (toks.length === 0) return facts.slice(-limit)

    const hits = facts
      .map((f) => {
        const lc = f.text.toLowerCase()
        let score = 0
        for (const t of toks) if (lc.includes(t)) score++
        return { f, score }
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.seq - a.f.seq)

    const picked = hits.slice(0, limit).map((s) => s.f)
    if (picked.length < limit) {
      const chosen = new Set(picked.map((f) => f.seq))
      for (let i = facts.length - 1; i >= 0 && picked.length < limit; i--) {
        if (!chosen.has(facts[i].seq)) {
          picked.push(facts[i])
          chosen.add(facts[i].seq)
        }
      }
    }
    return picked
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private factPath(fact: MemoryFact): string {
    return join(this.dir, `${String(fact.seq).padStart(4, '0')}-${fact.slug}.md`)
  }

  private serializeFact(fact: MemoryFact): string {
    return `---\nname: ${fact.slug}\ncreated: ${fact.created}\n---\n${fact.text}\n`
  }

  /** Disambiguate a slug that already exists among `facts` (append -2, -3, …). */
  private uniqueSlug(base: string, facts: MemoryFact[]): string {
    const taken = new Set(facts.map((f) => f.slug))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`
      if (!taken.has(candidate)) return candidate
    }
  }

  /** Drop the oldest facts (and their files) until at most `maxFacts` remain. */
  private enforceCap(facts: MemoryFact[]): void {
    while (facts.length > this.maxFacts) {
      const oldest = facts.shift()
      if (!oldest) break
      try {
        rmSync(this.factPath(oldest), { force: true })
      } catch {
        // best-effort — a leftover file is harmless (it just won't re-parse)
      }
    }
  }

  /** Rewrite the human-readable `MEMORY.md` index (best-effort, never throws). */
  private writeIndex(facts: MemoryFact[]): void {
    const header =
      '# Sylor long-term memory\n\n' +
      `${facts.length} fact${facts.length === 1 ? '' : 's'} remembered about this user — ` +
      'one Markdown file per fact. Edit or delete a file to change what Sylor knows.\n'
    const body = facts
      .map((f) => `- [${f.text}](${String(f.seq).padStart(4, '0')}-${f.slug}.md)`)
      .join('\n')
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, INDEX_FILE), facts.length ? `${header}\n${body}\n` : header, 'utf-8')
    } catch {
      // best-effort — the per-fact files remain the source of truth
    }
  }
}
