import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

/**
 * Directories never worth walking for project context. Exported because the
 * file-inspection tools in `fs/operations.ts` must skip exactly the same noise —
 * a `search_files` that trawled node_modules would be useless and slow.
 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.vite',
  '.cache',
  'coverage',
  '.next',
  '.turbo'
])

/** Documentation/manifest files that give the model cheap, high-value context. */
const KEY_DOCS = ['package.json', 'README.md', 'readme.md', 'tsconfig.json']

/** Upper bounds so context stays token-light and the walk stays fast. */
const MAX_FILES = 400
const MAX_DEPTH = 6
const MAX_DOC_CHARS = 2_000

/**
 * Read-only view of the active project. Phase 3 uses this to give the workflow
 * engine a cheap structural overview and a few key manifest files for grounding.
 * Writing and command execution are deliberately absent — those arrive in
 * Phase 4 behind permission checks.
 */
export class ContextManager {
  private root: string
  /** Cache of file contents keyed by absolute path (invalidated on root change). */
  private readonly fileCache = new Map<string, string>()
  private treeCache: string[] | null = null

  constructor(root?: string) {
    // Default to the app's working directory; a project-open flow lands later.
    this.root = root ?? process.cwd()
  }

  /** The active project root directory. */
  getRoot(): string {
    return this.root
  }

  /** Point the manager at a different project root, clearing caches. */
  setRoot(root: string): void {
    if (root === this.root) return
    this.root = root
    this.fileCache.clear()
    this.treeCache = null
  }

  /**
   * Returns project-relative paths (POSIX-style), bounded by MAX_FILES/MAX_DEPTH
   * and skipping ignored directories. Result is cached until the root changes.
   */
  listFiles(): string[] {
    if (this.treeCache) return this.treeCache

    const results: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH || results.length >= MAX_FILES) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return // unreadable dir — skip silently
      }
      for (const entry of entries) {
        if (results.length >= MAX_FILES) return
        const full = join(dir, entry)
        let isDir: boolean
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue
          walk(full, depth + 1)
        } else {
          results.push(relative(this.root, full).split(sep).join('/'))
        }
      }
    }

    walk(this.root, 0)
    results.sort()
    this.treeCache = results
    return results
  }

  /** Reads a file (absolute or project-relative), caching the result. */
  readFile(path: string): string | null {
    const abs = path.startsWith(this.root) ? path : join(this.root, path)
    const cached = this.fileCache.get(abs)
    if (cached !== undefined) return cached
    try {
      const text = readFileSync(abs, 'utf-8')
      this.fileCache.set(abs, text)
      return text
    } catch {
      return null
    }
  }

  /**
   * Builds a compact, token-light overview string: project name, the bounded
   * file tree, and truncated key manifests. Fed to the engine as grounding.
   */
  buildOverview(): string {
    const files = this.listFiles()
    const projectName = basename(this.root)

    const lines: string[] = [`# Project: ${projectName}`, `Root: ${this.root}`, '']

    lines.push(`## Files (${files.length}${files.length >= MAX_FILES ? '+, truncated' : ''})`)
    lines.push(files.join('\n'))
    lines.push('')

    for (const doc of KEY_DOCS) {
      const content = this.readFile(doc)
      if (content) {
        const trimmed =
          content.length > MAX_DOC_CHARS ? `${content.slice(0, MAX_DOC_CHARS)}\n… (truncated)` : content
        lines.push(`## ${doc}`, '```', trimmed, '```', '')
      }
    }

    return lines.join('\n')
  }
}

/** Process-wide context manager instance (singleton for Phase 3). Defaults to
 *  the working directory; a project-open flow can retarget it later. */
export const contextManager = new ContextManager(process.cwd())
