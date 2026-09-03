import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { contextManager } from './manager'
import { readProjectFile } from '../fs/operations'

/**
 * Hierarchical instruction loading (Phase 5) — Sylor's answer to Claude Code's
 * layered `CLAUDE.md`. Three levels are discovered and merged, least-specific
 * first so the most-specific guidance lands last (where the model weighs it most):
 *
 *   1. **User-level** — `~/.sylor/SYLOR.md`, the person's standing preferences
 *      that apply in every project.
 *   2. **Project root** — `.sylor/SYLOR.md` (canonical), plus a legacy `SYLOR.md`,
 *      a cross-tool `AGENTS.md`, and `.claude/CLAUDE.md` / `CLAUDE.md` at the root,
 *      so a repo already set up for another agent works unchanged.
 *   3. **Nearest subdirectory** — a `SYLOR.md` / `.sylor/SYLOR.md` inside a
 *      package or module folder, so a monorepo's sub-project can carry its own
 *      rules. Discovered by a shallow, bounded walk (ignored and dot dirs skipped).
 *
 * Any loaded file may pull in another with an `@path` line (a line that is just
 * `@relative/file.md`); {@link expandImports} inlines the referenced file's
 * contents, recursively, with cycle- and depth-guards. Project imports resolve
 * through the sandbox (they can never escape the project root); user-level
 * imports are confined to `~/.sylor`.
 *
 * Everything is best-effort and never throws — a missing, unreadable, or
 * out-of-sandbox file is simply skipped — so a broken instruction file degrades
 * to "no preamble" rather than aborting a run.
 */

/**
 * Root-level instruction slots, in inclusion order (`.sylor/SYLOR.md` is canonical).
 * The cross-tool slots that follow are why Sylor can be dropped into a repo that was
 * already set up for another agent and pick up its standing guidance unchanged —
 * `AGENTS.md`, and the `.claude/CLAUDE.md` / `CLAUDE.md` pair that a Claude-Code
 * project keeps its permanent instructions in.
 */
const PROJECT_INSTRUCTION_FILES = [
  '.sylor/SYLOR.md',
  'SYLOR.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
  'CLAUDE.md'
] as const
/** Total char budget across every merged section — keeps the system prompt lean. */
const MAX_INSTRUCTION_CHARS = 8_000
/** How many `@import` hops deep to follow before giving up (cycle/runaway guard). */
const MAX_IMPORT_DEPTH = 5
/** How far below the root the subdirectory walk descends looking for instruction files. */
const MAX_SUBDIR_DEPTH = 3
/** Directories never worth walking for nested instruction files (own copy — the
 *  context-manager export is unavailable when that module is mocked in tests). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'release',
  '.vite',
  '.cache',
  'coverage',
  '.next',
  '.turbo'
])
/** Standing-guidance trailer appended once when any instructions were found. */
const TRAILER =
  'Follow these repository instructions as standing guidance for this project, ' +
  'the same way you would the user’s direct request.'

/** A reader for one instruction "domain": maps a domain-relative path to text or null. */
type DomainRead = (relPath: string) => string | null

/** POSIX dirname of a `/`-joined relative path ('' for a bare filename). */
function posixDirname(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/**
 * Resolve `importPath` (from a file living in `fromRelDir`) to a normalized,
 * domain-relative POSIX path — or null when it is absolute, `~`-rooted, or climbs
 * above the domain root. This is the escape guard for `@imports`: a project file
 * can never reach outside the project, a user file never outside `~/.sylor`.
 */
function resolveRel(fromRelDir: string, importPath: string): string | null {
  if (isAbsolute(importPath) || importPath.startsWith('~')) return null
  const segs = (fromRelDir ? fromRelDir.split('/') : []).concat(importPath.split(/[\\/]/))
  const out: string[] = []
  for (const s of segs) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (out.length === 0) return null // escapes the domain root
      out.pop()
      continue
    }
    out.push(s)
  }
  return out.join('/')
}

/**
 * Whether an `@token` looks like a file import rather than incidental prose (an
 * `@handle`, a CSS `@media`, a JSDoc `@param`). Requires a path shape: a leading
 * `./`/`../`, an embedded `/`, or a text-file extension.
 */
function looksLikeImportPath(p: string): boolean {
  return /^\.\.?\//.test(p) || p.includes('/') || /\.(md|markdown|txt)$/i.test(p)
}

/**
 * Inline every `@path` import line in `content`. A line that is exactly `@<path>`
 * (optionally indented) and looks like a file reference is replaced by the
 * referenced file's contents, expanded recursively. A line that can't be resolved
 * (absolute, escaping, missing, cyclic, or too deep) is left verbatim, so nothing
 * is silently lost. Exported for direct unit testing.
 */
export function expandImports(
  content: string,
  fromRelDir: string,
  read: DomainRead,
  seen: Set<string>,
  depth: number
): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = /^\s*@(\S+)\s*$/.exec(line)
      if (!m || !looksLikeImportPath(m[1])) return line
      const target = resolveRel(fromRelDir, m[1])
      if (target === null) return line
      const key = target.toLowerCase()
      if (depth <= 0 || seen.has(key)) return line
      const text = read(target)
      if (text === null) return line
      seen.add(key)
      return expandImports(text, posixDirname(target), read, seen, depth - 1)
    })
    .join('\n')
}

/** Read a user-level file under `userDir`, trimmed; null when missing/unreadable. */
function makeUserReader(userDir: string): DomainRead {
  return (rel) => {
    try {
      return readFileSync(join(userDir, rel), 'utf-8').trim() || null
    } catch {
      return null
    }
  }
}

/** Read a project-relative file through the sandbox, trimmed; null on any failure. */
const projectRead: DomainRead = (rel) => {
  try {
    return readProjectFile(rel).trim() || null
  } catch {
    return null // missing / unreadable / outside the sandbox
  }
}

/**
 * Bounded, depth-first walk for `SYLOR.md` / `.sylor/SYLOR.md` files in
 * subdirectories of `root` (the root-level slots are handled separately). Skips
 * ignored + dot directories, descends at most {@link MAX_SUBDIR_DEPTH} levels,
 * and returns project-relative POSIX paths ordered shallow-first for a stable,
 * nearest-first merge. Never throws — an unreadable directory is skipped.
 */
function discoverSubdirInstructionFiles(root: string): string[] {
  const found: Array<{ rel: string; depth: number }> = []
  const toPosix = (p: string): string => p.split(sep).join('/')

  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (depth > MAX_SUBDIR_DEPTH) return
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return
    }
    // This directory's own instruction files (skip the root — handled elsewhere).
    if (relDir !== '') {
      for (const cand of [join(relDir, 'SYLOR.md'), join(relDir, '.sylor', 'SYLOR.md')]) {
        try {
          if (statSync(join(root, cand)).isFile()) found.push({ rel: toPosix(cand), depth })
        } catch {
          // no such file — skip
        }
      }
    }
    for (const name of entries) {
      if (name === '.sylor' || name.startsWith('.') || SKIP_DIRS.has(name)) continue
      const abs = join(absDir, name)
      try {
        if (statSync(abs).isDirectory()) walk(abs, relDir ? join(relDir, name) : name, depth + 1)
      } catch {
        // unreadable entry — skip
      }
    }
  }

  walk(root, '', 0)
  found.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))
  return found.map((f) => f.rel)
}

/**
 * Build the merged, `@import`-expanded instruction preamble from all three levels
 * (see the module doc). Returns '' when no instruction file exists anywhere, so a
 * repo/user without one adds nothing to the prompt. Sections are de-duplicated by
 * their expanded content and clipped to {@link MAX_INSTRUCTION_CHARS} in total.
 *
 * `opts.userDir` overrides the user-level directory (defaults to `~/.sylor`) —
 * used by tests to stay hermetic; the engine calls this with no arguments.
 */
export function buildInstructionsPreamble(opts: { userDir?: string } = {}): string {
  const root = contextManager.getRoot()
  const userDir = opts.userDir ?? join(homedir(), '.sylor')
  const userRead = makeUserReader(userDir)

  const sections: string[] = []
  const seenContent = new Set<string>()
  let total = 0

  const addSection = (heading: string, rawBody: string, fromRelDir: string, read: DomainRead): void => {
    const remaining = MAX_INSTRUCTION_CHARS - total
    if (remaining <= 0) return
    const expanded = expandImports(rawBody, fromRelDir, read, new Set(), MAX_IMPORT_DEPTH).trim()
    if (!expanded || seenContent.has(expanded)) return
    seenContent.add(expanded)
    const clipped =
      expanded.length > remaining ? `${expanded.slice(0, remaining)}\n… (instructions clipped)` : expanded
    total += clipped.length
    sections.push(`${heading}\n${clipped}`)
  }

  // 1. User-level (~/.sylor/SYLOR.md) — applies across every project.
  const userRaw = userRead('SYLOR.md')
  if (userRaw) addSection('## User instructions (from ~/.sylor/SYLOR.md)', userRaw, '', userRead)

  // 2. Project-root slots — .sylor/SYLOR.md canonical, legacy files honoured.
  for (const rel of PROJECT_INSTRUCTION_FILES) {
    const content = projectRead(rel)
    if (content) addSection(`## Repository instructions (from ${rel})`, content, posixDirname(rel), projectRead)
  }

  // 3. Nearest-subdirectory instruction files (monorepo packages, submodules).
  for (const rel of discoverSubdirInstructionFiles(root)) {
    const content = projectRead(rel)
    if (content) addSection(`## Repository instructions (from ${rel})`, content, posixDirname(rel), projectRead)
  }

  if (sections.length === 0) return ''
  return `${sections.join('\n\n')}\n\n${TRAILER}`
}
