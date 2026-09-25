import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { toErrorMessage } from '../providers/http'
import { fsAvailable, resolveInWorkspace } from './fs'
import type { ToolDef } from './registry'

/**
 * Codebase-intelligence tools for Cowork: {@link searchCodeTool} (find where a
 * string/pattern appears across the folder) and {@link findFilesTool} (find files
 * by name/glob). Together they are what let the agent work on a LARGE existing
 * project without reading every file first — it locates the few relevant files, then
 * reads only those. Both are read-only and sandboxed to the working folder through
 * the same {@link resolveInWorkspace} chokepoint the other fs tools use.
 */

/** Directories never worth walking — vendored deps, VCS, build output, caches. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode'
])

/** Files above this size are skipped when scanning content (likely binary/generated). */
const MAX_FILE_BYTES = 512 * 1024
/** Largest number of files walked in one call — bounds a search on a huge tree. */
const MAX_FILES_SCANNED = 4000
/** Largest number of matches (search_code) or paths (find_files) returned. */
const MAX_RESULTS = 100
/** Trim each matched line to this many characters in the output. */
const LINE_CAP = 200

/** A crude binary sniff: NUL byte in the first chunk ⇒ treat as binary, skip. */
function looksBinary(text: string): boolean {
  return text.slice(0, 1024).includes('\0')
}

/**
 * Walk the workspace depth-first, yielding each file's absolute + relative path.
 * Skips {@link SKIP_DIRS} and stops after {@link MAX_FILES_SCANNED} so a pathological
 * tree can't hang the call. Directory read errors are skipped, not thrown.
 */
async function* walk(root: string): AsyncGenerator<{ abs: string; rel: string }> {
  let scanned = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs)
      } else if (e.isFile()) {
        if (++scanned > MAX_FILES_SCANNED) return
        yield { abs, rel: relative(root, abs).split(sep).join('/') }
      }
    }
  }
}

/**
 * List workspace files whose relative path matches `query` (case-insensitive
 * substring), ranked so basename hits come before mid-path hits and shorter paths
 * before longer ones. Powers the composer's `@file` mention popover (#7): it reuses
 * the same sandboxed {@link walk} + {@link SKIP_DIRS} the search tools use, so it can
 * only ever surface files inside the working folder. An empty query returns the first
 * files walked (a useful "just opened @" listing). Never throws — a bad root or a
 * mid-walk read error yields whatever was collected so far.
 */
export async function listWorkspaceFiles(root: string, query: string, limit = 20): Promise<string[]> {
  const needle = query.trim().toLowerCase()
  const scored: { rel: string; rank: number }[] = []
  try {
    for await (const { rel } of walk(root)) {
      if (needle === '') {
        scored.push({ rel, rank: 0 })
      } else {
        const lower = rel.toLowerCase()
        const base = (rel.split('/').pop() ?? rel).toLowerCase()
        const inBase = base.includes(needle)
        const inPath = lower.includes(needle)
        if (!inBase && !inPath) continue
        // Basename match ranks above a match buried in the directory portion.
        scored.push({ rel, rank: inBase ? 0 : 1 })
      }
      // Collect a healthy multiple of `limit` before ranking so the sort has real
      // candidates to order, but still bound the work on a huge tree.
      if (scored.length >= limit * 8) break
    }
  } catch {
    // fall through with whatever we gathered
  }
  scored.sort((a, b) => a.rank - b.rank || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
  return scored.slice(0, limit).map((s) => s.rel)
}

/** Read a trimmed string field out of a tool input, or null. */
function readField(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export const searchCodeTool: ToolDef = {
  name: 'search_code',
  description:
    'Search the working folder for a text string and return matching file:line locations (case-insensitive substring). Use this to find where something is defined or used before reading files. Optionally limit by "glob" (e.g. "*.ts").',
  usage: '{"query": "function handleLogin", "glob": "*.tsx"}',
  available: fsAvailable,
  async run(input, ctx) {
    const query = readField(input, 'query')
    if (!query) return 'search_code needs a "query" string, e.g. {"query": "TODO"}.'
    const root = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, '.') : null
    if (!root) return 'search_code: no working folder is set.'
    const glob = readField(input, 'glob')
    const matcher = glob ? globToRegExp(glob) : null
    const needle = query.toLowerCase()

    const hits: string[] = []
    try {
      for await (const { abs, rel } of walk(root)) {
        if (matcher && !matcher.test(rel.split('/').pop() ?? rel)) continue
        let text: string
        try {
          const buf = await readFile(abs)
          if (buf.length > MAX_FILE_BYTES) continue
          text = buf.toString('utf8')
        } catch {
          continue
        }
        if (looksBinary(text)) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            const trimmed = lines[i].trim().slice(0, LINE_CAP)
            hits.push(`${rel}:${i + 1}: ${trimmed}`)
            if (hits.length >= MAX_RESULTS) break
          }
        }
        if (hits.length >= MAX_RESULTS) break
      }
    } catch (err) {
      return `search_code failed: ${toErrorMessage(err)}`
    }
    if (hits.length === 0) return `No matches for "${query}"${glob ? ` in ${glob}` : ''}.`
    const capped = hits.length >= MAX_RESULTS ? `\n…(stopped at ${MAX_RESULTS} matches)` : ''
    return `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}":\n${hits.join('\n')}${capped}`
  }
}

export const findFilesTool: ToolDef = {
  name: 'find_files',
  description:
    'Find files in the working folder by name or glob pattern (e.g. "*.test.ts", "SignUp*"). Returns matching relative paths. Use this to locate files without listing every folder.',
  usage: '{"pattern": "*.tsx"}',
  available: fsAvailable,
  async run(input, ctx) {
    const pattern = readField(input, 'pattern')
    if (!pattern) return 'find_files needs a "pattern" string, e.g. {"pattern": "*.ts"}.'
    const root = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, '.') : null
    if (!root) return 'find_files: no working folder is set.'
    const matcher = globToRegExp(pattern)

    const paths: string[] = []
    try {
      for await (const { rel } of walk(root)) {
        const base = rel.split('/').pop() ?? rel
        // Match against the base name OR the full relative path, so "src/SignUp" works too.
        if (matcher.test(base) || matcher.test(rel)) {
          paths.push(rel)
          if (paths.length >= MAX_RESULTS) break
        }
      }
    } catch (err) {
      return `find_files failed: ${toErrorMessage(err)}`
    }
    if (paths.length === 0) return `No files match "${pattern}".`
    paths.sort()
    const capped = paths.length >= MAX_RESULTS ? `\n…(stopped at ${MAX_RESULTS})` : ''
    return `${paths.length} file${paths.length === 1 ? '' : 's'} matching "${pattern}":\n${paths.join('\n')}${capped}`
  }
}

/**
 * Compile a simple glob (`*` = any run within a segment, `?` = one char) to a
 * case-insensitive anchored RegExp. Plain substrings (no wildcard) become a
 * contains-match so `{"pattern": "SignUp"}` still finds `SignUp.jsx`.
 */
export function globToRegExp(glob: string): RegExp {
  const hasWildcard = /[*?]/.test(glob)
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return hasWildcard ? new RegExp(`^${escaped}$`, 'i') : new RegExp(escaped, 'i')
}

/** The Cowork codebase-intelligence tools, advertised in this order. */
export const searchTools: readonly ToolDef[] = [searchCodeTool, findFilesTool]
