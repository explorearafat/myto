import { extname, join, posix } from 'node:path'
import { contextManager } from './manager'
import { leadingDoc, readHead, summarizeSource } from './projectIndex'
import { SCAFFOLD_MARKER } from './projectMemory'

/**
 * The one-time project audit (§3) — the read that stops every later read.
 *
 * §3 allows exactly one targeted inspection of an unfamiliar project, on the
 * condition that what it learns is **persisted**. This module is the deterministic
 * half of that deal: it walks the project once and renders the file map — every
 * important file and what it is RESPONSIBLE for — so no later turn ever opens a
 * file merely to discover its purpose (§7, "extremely important").
 *
 * Nothing here calls a model. A file's responsibility is taken from what the file
 * itself already says: its leading doc comment first, then its declared exports,
 * then the conventions its path implies (`*.test.ts` is a test, `use*.ts` is a
 * hook, `index.ts` is an entry point). That is cheap, offline, and — because it
 * quotes the source rather than guessing at it — usually more accurate than a
 * summary a model would write from the same head bytes.
 *
 * The two documents that DO need judgement (ARCHITECTURE.md, CONVENTIONS.md) are
 * not written here; {@link buildAuditInventory} produces the digest a single
 * authoring call works from, and `staging.ts` spends that call. So the whole audit
 * costs one model call per project, once, ever.
 *
 * Regeneration is safe by construction: {@link renderFileMap} keeps the purpose
 * line already recorded for a path it still finds, so refining a description by
 * hand (or by agent) is never undone by the next audit — it only fills in the
 * files nobody has described yet.
 */

/** Marks a machine-maintained file map; its absence means "hand-written, leave it". */
export const FILEMAP_MARKER = '<!-- sylor:filemap -->'

/** Longest prefix of a file read to derive its purpose. Enough for any docblock. */
const HEAD_BYTES = 8_192

/** Bounds so an audit of a large repo stays fast and the document stays readable. */
const MAX_MAPPED_FILES = 160
const MAX_PURPOSE_CHARS = 150
const MAX_DIGEST_CHARS = 2_600

/** Files whose contents say nothing useful about what the project IS. */
const SKIPPED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.editorconfig',
  '.DS_Store'
])

/** Extensions that carry no readable responsibility (assets, binaries, artefacts). */
const SKIPPED_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.webm',
  '.pdf',
  '.zip',
  '.gz',
  '.exe',
  '.dll',
  '.node',
  '.wasm',
  '.map',
  '.snap',
  '.log'
])

/** Directory names whose role is worth stating once, at the top of the map. */
const DIR_ROLES: Readonly<Record<string, string>> = {
  src: 'source',
  app: 'application code',
  main: 'Electron main process',
  renderer: 'renderer / UI',
  preload: 'preload bridge',
  shared: 'code shared across processes',
  components: 'UI components',
  hooks: 'React hooks',
  lib: 'shared library code',
  utils: 'helpers',
  api: 'API layer',
  routes: 'routes',
  pages: 'pages',
  views: 'views',
  layouts: 'layouts',
  styles: 'styling',
  assets: 'static assets',
  public: 'served static files',
  server: 'server code',
  db: 'database access',
  models: 'data models',
  services: 'service layer',
  store: 'client state',
  context: 'context providers',
  types: 'type declarations',
  tests: 'tests',
  test: 'tests',
  __tests__: 'tests',
  scripts: 'build and maintenance scripts',
  config: 'configuration',
  docs: 'documentation',
  migrations: 'database migrations',
  workflow: 'workflow engine',
  e2e: 'end-to-end tests'
}

/** One audited file: where it lives and what it is responsible for. */
export interface FileFacts {
  /** POSIX project-relative path. */
  path: string
  /** One line: what this file is responsible for. */
  purpose: string
}

/** What a single audit learned, ready to be persisted. */
export interface AuditInventory {
  /** The rendered FILEMAP.md, complete with its marker. Deterministic. */
  filemap: string
  /** The project's shape, as the digest an ARCHITECTURE/CONVENTIONS call works from. */
  digest: string
  /** How many files the map describes. 0 means there was nothing to audit. */
  files: number
}

// ── Purpose derivation ───────────────────────────────────────────────────────

/** Collapses whitespace and clips to one readable line. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_PURPOSE_CHARS ? `${flat.slice(0, MAX_PURPOSE_CHARS - 1)}…` : flat
}

/** `src/main/db/db.ts` → `db`; the name without its extension. */
function stem(path: string): string {
  const base = posix.basename(path)
  const dot = base.indexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** True for a name that looks like a React component (`PascalCase`). */
function looksComponent(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name)
}

/** The responsibility a file's PATH implies, when its contents didn't say. */
function purposeFromPath(path: string, exports: string[]): string {
  const base = posix.basename(path)
  const name = stem(path)
  const ext = extname(path).toLowerCase()
  const dir = posix.dirname(path)
  const parent = dir === '.' ? '' : posix.basename(dir)
  const list = exports.length ? ` Exports ${exports.slice(0, 6).join(', ')}.` : ''

  if (/\.(test|spec)\.[jt]sx?$/.test(base)) return `Tests for ${name}.`
  if (base === 'package.json') return 'Package manifest — name, scripts and dependencies.'
  if (/^tsconfig.*\.json$/.test(base)) return 'TypeScript compiler configuration.'
  if (/^(eslint|prettier)/.test(base) || /\.eslintrc/.test(base)) return 'Lint and formatting rules.'
  if (/\.config\.[jt]s$/.test(base) || base.endsWith('.config.mjs')) return `Build configuration (${name}).`
  if (base === 'README.md' || base === 'readme.md') return 'Project readme.'
  if (ext === '.md') return 'Documentation.'
  if (ext === '.css' || ext === '.scss' || ext === '.less') return `Stylesheet for ${parent || 'the app'}.`
  if (ext === '.html') return 'HTML entry document.'
  if (ext === '.json') return `Data / configuration (${name}).`
  if (ext === '.sql') return 'SQL schema or query.'
  if (name === 'index' && parent) return `Entry point for ${parent}.${list}`
  if (/^use[A-Z]/.test(name)) return `React hook: ${name}.${list}`
  if (ext === '.tsx' || ext === '.jsx') {
    return looksComponent(name) ? `React component: ${name}.${list}` : `UI module.${list}`
  }
  if (list) return list.trim()
  return 'Purpose not recorded yet — describe it here.'
}

/**
 * What one file is responsible for, from its own head bytes: its leading doc
 * comment when it has one (the file's own account of itself), otherwise the
 * conventions its path implies, enriched with what it exports.
 */
export function describeFile(path: string, head: string): string {
  const { symbols } = summarizeSource(path, head)
  const doc = leadingDoc(head)
  if (doc) {
    // A docblock that opens with the file's own name ("Task graph — the DAG …")
    // already reads as a responsibility line; keep it as the file states it.
    return oneLine(doc.replace(/\s*[.:]\s*$/, '.'))
  }
  if (extname(path).toLowerCase() === '.md') {
    const heading = /^#{1,3}\s+(.+)$/m.exec(head)?.[1]?.trim()
    if (heading) return oneLine(`${heading}.`)
  }
  return oneLine(purposeFromPath(path, symbols))
}

// ── Walk ─────────────────────────────────────────────────────────────────────

/** True when a path is worth describing in the file map. */
function auditable(rel: string): boolean {
  const base = posix.basename(rel)
  if (SKIPPED_FILES.has(base)) return false
  if (SKIPPED_EXTS.has(extname(rel).toLowerCase())) return false
  // Generated bundles and minified output describe nothing.
  return !/\.min\.[a-z]+$/.test(base)
}

/**
 * Sorts shallow-and-central before deep-and-peripheral, so a clipped read of the
 * map still covers the files that frame the project.
 */
function auditOrder(a: string, b: string): number {
  const depth = (p: string): number => p.split('/').length
  return depth(a) - depth(b) || a.localeCompare(b)
}

/** Reads the head of a project file; '' when it can't be read. */
function head(rel: string): string {
  try {
    return readHead(join(contextManager.getRoot(), rel), HEAD_BYTES)
  } catch {
    return ''
  }
}

/**
 * Audits the active project: describes every auditable file (bounded, ordered so
 * the important ones come first) and renders both the file map and the digest.
 * Best-effort — an unreadable file is described from its path alone, and a project
 * with nothing to read yields `files: 0` so the caller can skip the whole stage.
 *
 * `existingFileMap` is the file map already on disk, if any. A map Sylor generated
 * (it carries {@link FILEMAP_MARKER}) is merged: refined purpose lines are kept and
 * new files are added. A map somebody wrote by hand in their own format is **left
 * alone** — `filemap` comes back empty, which tells the caller there is nothing to
 * write (§4: integrate with what a project already has, never destroy it).
 */
export function buildAuditInventory(existingFileMap?: string | null): AuditInventory {
  const all = contextManager.listFiles().filter(auditable).sort(auditOrder)
  const mapped = all.slice(0, MAX_MAPPED_FILES)
  const facts: FileFacts[] = mapped.map((path) => ({ path, purpose: describeFile(path, head(path)) }))
  const ours = machineMaintained(existingFileMap)
  return {
    filemap: ours === null ? '' : renderFileMap(facts, { total: all.length, existing: ours }),
    digest: renderDigest(facts, all),
    files: facts.length
  }
}

/**
 * The existing map when Sylor may rewrite it ('' / the marked doc), or null when it
 * is somebody else's document and must be left as it is.
 */
function machineMaintained(doc?: string | null): string | null {
  if (!doc || !doc.trim()) return ''
  if (doc.includes(SCAFFOLD_MARKER)) return '' // our own untouched skeleton
  return doc.includes(FILEMAP_MARKER) ? doc : null
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** `src/main/db/db.ts` → `src/main/db`; `vite.config.ts` → `(root)`. */
function groupOf(path: string): string {
  const dir = posix.dirname(path)
  return dir === '.' ? '(root)' : dir
}

/** Parses `- \`path\` — purpose` lines out of an existing map. */
export function parseFileMap(doc: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of doc.matchAll(/^[-*]\s+`([^`]+)`\s+—\s+(.+?)\s*$/gm)) out.set(m[1], m[2])
  return out
}

/** One line per directory: how many files it holds and what it is for. */
function layoutLines(facts: FileFacts[]): string[] {
  const counts = new Map<string, number>()
  for (const f of facts) counts.set(groupOf(f.path), (counts.get(groupOf(f.path)) ?? 0) + 1)
  return [...counts.entries()].map(([dir, n]) => {
    const role = DIR_ROLES[posix.basename(dir)]
    return `- \`${dir}\` — ${n} file${n === 1 ? '' : 's'}${role ? ` · ${role}` : ''}`
  })
}

/**
 * Renders FILEMAP.md: the layout rollup first (so even a clipped read shows the
 * shape of the whole tree), then one line per file grouped by directory.
 *
 * A purpose already recorded for a path in `existing` **wins** — a description
 * someone refined is never replaced by a freshly-derived one, so re-auditing only
 * ever fills gaps and adds new files (§36, don't overwrite working understanding).
 */
export function renderFileMap(
  facts: FileFacts[],
  opts: { total?: number; existing?: string | null } = {}
): string {
  const kept = opts.existing ? parseFileMap(opts.existing) : new Map<string, string>()
  const merged = facts.map((f) => ({ path: f.path, purpose: kept.get(f.path) ?? f.purpose }))
  const total = opts.total ?? merged.length
  const omitted = total - merged.length

  const out: string[] = [
    FILEMAP_MARKER,
    '# File map',
    '',
    'One line per file: what that file is RESPONSIBLE for. This is the answer to "what is this',
    'file for?" — read it here instead of opening the file. Keep it current: add a line when a',
    'file is created, remove one when it is deleted, and rewrite one when a file changes job.',
    '',
    `Format: \`- \`path\` — purpose.\`  ·  ${merged.length} file${merged.length === 1 ? '' : 's'} described${
      omitted > 0 ? `, ${omitted} more not yet described` : ''
    }.`,
    '',
    '## Layout',
    '',
    ...layoutLines(merged)
  ]

  let group = ''
  for (const f of merged) {
    const g = groupOf(f.path)
    if (g !== group) {
      group = g
      out.push('', `## ${g}`, '')
    }
    out.push(`- \`${f.path}\` — ${f.purpose}`)
  }
  return `${out.join('\n')}\n`
}

/** The manifest facts worth handing an authoring call, from package.json. */
function manifestDigest(): string[] {
  const raw = contextManager.readFile('package.json')
  if (!raw) return []
  try {
    const pkg = JSON.parse(raw) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    const dev = Object.keys(pkg.devDependencies ?? {})
    const scripts = Object.entries(pkg.scripts ?? {}).map(([k, v]) => `${k}: ${v}`)
    return [
      pkg.name ? `Package: ${pkg.name}` : '',
      deps.length ? `Dependencies: ${deps.join(', ')}` : '',
      dev.length ? `Dev dependencies: ${dev.slice(0, 40).join(', ')}` : '',
      scripts.length ? `Scripts —\n${scripts.map((s) => `- ${s}`).join('\n')}` : ''
    ].filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The digest an ARCHITECTURE/CONVENTIONS authoring call is given: the manifest,
 * the layout, and every audited file with its purpose. Bounded, because the point
 * is to spend ONE call on the whole project rather than a tour of it.
 */
export function renderDigest(facts: FileFacts[], all: readonly string[]): string {
  const parts = [
    ...manifestDigest(),
    `Layout —\n${layoutLines(facts).join('\n')}`,
    `Files (${facts.length} of ${all.length}) —\n${facts.map((f) => `- ${f.path} — ${f.purpose}`).join('\n')}`
  ]
  const text = parts.join('\n\n')
  return text.length <= MAX_DIGEST_CHARS ? text : `${text.slice(0, MAX_DIGEST_CHARS)}\n…`
}
