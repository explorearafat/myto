import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * The persistent project file-index (Problem 1: "read each essential file once,
 * cache a compact summary under `.sylor/`, and pull details from there later").
 *
 * The index is a token-light structural map of the files the agent has actually
 * opened — exports/imports for code, headings for markdown, top-level keys for
 * JSON. It is *not* a substitute for reading a file; its job is to stop the model
 * re-reading, blind, files it (or a past run) has already seen: {@link ContextManager}
 * injects the summaries into every run's overview, so a fresh run starts already
 * knowing what the essentials contain instead of rediscovering them from scratch.
 *
 * Summaries are extracted with cheap, deterministic string parsing — deliberately
 * NO model calls (offline-first, and it respects the credit constraint). The
 * extraction is best-effort: a summary it can't derive degrades to the file's
 * first non-empty line, never an error.
 */

/** Bumped when the on-disk shape changes; an older/newer file loads as empty. */
export const INDEX_VERSION = 1

/** Longest prefix of a file we read to summarise it (a 5 MB bundle stays cheap). */
const HEAD_BYTES = 64 * 1024

/** Bounds so a single summary — and the whole injected index — stays token-light. */
const MAX_SUMMARY_CHARS = 240
const MAX_SYMBOLS = 12
const MAX_IMPORTS = 8
const MAX_HEADINGS = 6

/** One indexed file: enough to detect staleness (size+mtime) plus its summary. */
export interface FileIndexEntry {
  /** Byte size at index time — half of the freshness check. */
  size: number
  /** `mtimeMs` at index time — the other half; a change forces a re-summarise. */
  mtime: number
  /** The compact human/structural one-liner shown in the overview. */
  summary: string
  /** Notable symbol names (exports / headings / JSON keys), for a richer overview. */
  symbols?: string[]
  /** Wall-clock ms the entry was last (re)computed — diagnostics only. */
  indexedAt: number
}

/** The whole per-project index, persisted at `<root>/.sylor/index.json`. */
export interface ProjectIndex {
  version: number
  /** The root this index describes (sanity-checked on load; rewritten on save). */
  root: string
  /** Entries keyed by POSIX project-relative path. */
  files: Record<string, FileIndexEntry>
}

/** A fresh, empty index for `root`. */
export function emptyIndex(root: string): ProjectIndex {
  return { version: INDEX_VERSION, root, files: {} }
}

/** Absolute path of the index file for a project root. */
export function indexPath(root: string): string {
  return join(root, '.sylor', 'index.json')
}

/**
 * Reads a bounded prefix of a file as UTF-8. Uses a positional read so a huge
 * file (a minified bundle, a big JSON) never loads fully into memory just to be
 * summarised. Throws the underlying fs error when the file is missing/unreadable;
 * callers treat that as "nothing to index".
 */
export function readHead(abs: string, maxBytes: number = HEAD_BYTES): string {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Loads the index for `root`, tolerating every failure: a missing file, corrupt
 * JSON, or a version/shape mismatch all yield a fresh empty index rather than
 * throwing. The caller then prunes stale entries and refills from live reads.
 */
export function loadIndex(root: string): ProjectIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(root), 'utf-8')) as Partial<ProjectIndex>
    if (
      !parsed ||
      parsed.version !== INDEX_VERSION ||
      typeof parsed.files !== 'object' ||
      parsed.files === null
    ) {
      return emptyIndex(root)
    }
    return { version: INDEX_VERSION, root, files: parsed.files as Record<string, FileIndexEntry> }
  } catch {
    return emptyIndex(root)
  }
}

/**
 * Persists the index under `<root>/.sylor/index.json`, creating `.sylor` if
 * needed. Best-effort: a read-only filesystem (or any write error) is swallowed —
 * the index is a pure optimization, so failing to persist it must never break a
 * run. `root` is rewritten into the payload so a copied index self-identifies.
 */
export function saveIndex(root: string, index: ProjectIndex): void {
  try {
    mkdirSync(join(root, '.sylor'), { recursive: true })
    const payload: ProjectIndex = { version: INDEX_VERSION, root, files: index.files }
    writeFileSync(indexPath(root), JSON.stringify(payload, null, 2), 'utf-8')
  } catch {
    // Non-fatal: no persistence this time; the in-memory index still helps the run.
  }
}

// ── Structural summarisers ───────────────────────────────────────────────────

/** NUL in the first 8 KB ⇒ treat as binary (don't try to summarise bytes). */
function looksBinary(text: string): boolean {
  return text.slice(0, 8_192).includes('\0')
}

/** First non-blank line, trimmed and clipped — the universal fallback summary. */
function firstNonEmptyLine(content: string, max = 120): string {
  const line = content.split('\n').find((l) => l.trim().length > 0)
  return line ? line.trim().slice(0, max) : ''
}

/** Clip to the summary budget without cutting mid-escape-sequence weirdness. */
function clipSummary(text: string): string {
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text
}

/**
 * The leading `/** *\/` or `//` doc comment's first meaningful line, if any.
 * Exported because it is also the best deterministic answer to "what is this file
 * for?" — {@link buildAuditInventory} quotes it into FILEMAP.md.
 */
export function leadingDoc(content: string): string {
  const m = content.match(/^\s*(?:\/\*\*?([\s\S]*?)\*\/|((?:[ \t]*\/\/[^\n]*\n?)+))/)
  if (!m) return ''
  const raw = m[1] ?? m[2] ?? ''
  const first = raw
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*\*+\s?/, '')
        .replace(/^\s*\/\/\s?/, '')
        .trim()
    )
    .find((l) => l.length > 0)
  return first ? first.slice(0, 120) : ''
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

/** Declared exports (`export function foo`, `export class Bar`, …) — the names. */
function declaredExports(content: string): string[] {
  const names: string[] = []
  const decl =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum|namespace)\s+([A-Za-z0-9_$]+)/gm
  for (const m of content.matchAll(decl)) names.push(m[1])
  // Named re-export groups: `export { a, b as c }` → the exported name (after `as`).
  const named = /^\s*export\s*(?:type\s*)?\{([^}]+)\}/gm
  for (const m of content.matchAll(named)) {
    for (const part of m[1].split(',')) {
      const token = part.trim()
      if (!token) continue
      const asMatch = token.split(/\s+as\s+/)
      const name = (asMatch[1] ?? asMatch[0]).trim().replace(/^type\s+/, '')
      if (name && /^[A-Za-z0-9_$*]+$/.test(name) && name !== 'default') names.push(name)
    }
  }
  if (/^\s*export\s+default\b/m.test(content) && !names.includes('default')) names.push('default')
  return [...new Set(names)]
}

/** Imported module specifiers (`from 'react'`, bare `import './x'`), deduped. */
function importedModules(content: string): string[] {
  const mods: string[] = []
  for (const m of content.matchAll(/^\s*import\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)) mods.push(m[1])
  for (const m of content.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) mods.push(m[1])
  return [...new Set(mods)]
}

/** Top-level markdown headings (`#`/`##`/`###`), in document order. */
function markdownHeadings(content: string): string[] {
  const heads: string[] = []
  for (const m of content.matchAll(/^#{1,3}\s+(.+?)\s*#*$/gm)) {
    const text = m[1].trim()
    if (text) heads.push(text)
  }
  return heads
}

/** Top-level keys of a JSON object, or `null` when it isn't parseable/an object. */
function jsonTopKeys(content: string): string[] | null {
  try {
    const obj: unknown = JSON.parse(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return Object.keys(obj)
    return null
  } catch {
    return null
  }
}

/** A file's structural summary + notable symbols, extracted from its head text. */
export interface SourceSummary {
  summary: string
  symbols: string[]
}

/**
 * Derives a compact structural summary for a file from its (head) text, chosen by
 * extension: exports+imports for code, headings for markdown, top-level keys for
 * JSON, and the first non-empty line for anything else. Never throws; a file it
 * can't parse structurally still gets a first-line summary.
 */
export function summarizeSource(relPath: string, content: string): SourceSummary {
  if (looksBinary(content)) return { summary: '(binary)', symbols: [] }
  const ext = extname(relPath).toLowerCase()

  if (CODE_EXTS.has(ext)) {
    const doc = leadingDoc(content)
    const exports = declaredExports(content)
    const imports = importedModules(content)
    const parts: string[] = []
    if (doc) parts.push(doc)
    if (exports.length) {
      const shown = exports.slice(0, MAX_SYMBOLS).join(', ')
      parts.push(`exports: ${shown}${exports.length > MAX_SYMBOLS ? ', …' : ''}`)
    }
    if (imports.length) {
      const shown = imports.slice(0, MAX_IMPORTS).join(', ')
      parts.push(`imports: ${shown}${imports.length > MAX_IMPORTS ? ', …' : ''}`)
    }
    const summary = parts.join(' · ') || firstNonEmptyLine(content)
    return { summary: clipSummary(summary), symbols: exports.slice(0, MAX_SYMBOLS) }
  }

  if (ext === '.md' || ext === '.markdown') {
    const heads = markdownHeadings(content)
    if (heads.length) {
      return {
        summary: clipSummary(`headings: ${heads.slice(0, MAX_HEADINGS).join(' › ')}`),
        symbols: heads.slice(0, MAX_SYMBOLS)
      }
    }
    return { summary: clipSummary(firstNonEmptyLine(content)), symbols: [] }
  }

  if (ext === '.json') {
    const keys = jsonTopKeys(content)
    if (keys && keys.length) {
      const shown = keys.slice(0, MAX_SYMBOLS).join(', ')
      return {
        summary: clipSummary(`keys: ${shown}${keys.length > MAX_SYMBOLS ? ', …' : ''}`),
        symbols: keys.slice(0, MAX_SYMBOLS)
      }
    }
    return { summary: clipSummary(firstNonEmptyLine(content)), symbols: [] }
  }

  return { summary: clipSummary(firstNonEmptyLine(content)), symbols: [] }
}
