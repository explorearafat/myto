import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { loadIndex, readHead, saveIndex, summarizeSource, type ProjectIndex } from './projectIndex'

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

/** Longest file-index list injected into an overview, so it stays token-light. */
const MAX_INDEX_ENTRIES = 80

/** Longest prefix of just-written content summarised for the index (chars). */
const INDEX_HEAD_CHARS = 64 * 1024

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
  /**
   * Per-async-context root override (Phase 3, worktree isolation). When a
   * subagent runs inside its own git worktree, {@link runWithRoot} installs the
   * worktree path for the whole async subtree of that agent's loop; every
   * `getRoot()` consumer — `fs/operations.ts` path resolution, `searchProject` /
   * `findFiles`, and the command cwd in `terminal/pty.ts` — then transparently
   * targets the worktree instead of the shared project root, with ZERO change to
   * their signatures. `AsyncLocalStorage` keeps concurrent agents isolated: each
   * one's async context carries its own override, so two worktree agents running
   * in parallel never see each other's root. The persistent project *overview*
   * (`listFiles` / `buildOverview` / the caches) deliberately keeps reading
   * `this.root` — it is built once, at the lead level, and frames the whole run.
   */
  private readonly rootOverride = new AsyncLocalStorage<string>()

  /**
   * The persistent project file-index (Problem 1), lazily loaded from
   * `<root>/.sylor/index.json` on first use and reset on {@link setRoot}. It maps
   * files the agent has read to compact structural summaries so a later turn — or
   * a whole new run — can consult the summary instead of blindly re-reading. Kept
   * tied to {@link root} (the persistent project), NOT the {@link rootOverride}: a
   * worktree subagent reads a throwaway tree and must not pollute the project's
   * index (see the `getRoot() !== this.root` guard in {@link noteRead}).
   */
  private index: ProjectIndex | null = null
  /** True when {@link index} has unsaved changes (flushed at run end / on root change). */
  private indexDirty = false

  constructor(root?: string) {
    // Default to the app's working directory; a project-open flow lands later.
    this.root = root ?? process.cwd()
  }

  /**
   * The active project root directory — or, inside a {@link runWithRoot} scope,
   * that scope's overridden root (a subagent's private worktree). Everything that
   * resolves paths or picks a command cwd flows through here, so a single
   * override confines an entire agent's filesystem + command surface.
   */
  getRoot(): string {
    return this.rootOverride.getStore() ?? this.root
  }

  /**
   * The project root the user actually opened, ignoring any {@link runWithRoot}
   * override. Use this to tell "we are acting inside a subagent's private worktree"
   * apart from "we are acting on the user's project" — checkpoints, for one, are only
   * meaningful for the latter (`getRoot() === getProjectRoot()`).
   */
  getProjectRoot(): string {
    return this.root
  }

  /**
   * Runs `fn` with `root` installed as the active root for the whole async
   * subtree of the call (survives every `await` inside `fn`). Used to confine a
   * worktree-isolated subagent's writes and commands without threading a root
   * through every fs signature. Returns whatever `fn` returns (including a
   * Promise, which stays within the override for its entire continuation).
   */
  runWithRoot<T>(root: string, fn: () => T): T {
    return this.rootOverride.run(root, fn)
  }

  /** Point the manager at a different project root, clearing caches. */
  setRoot(root: string): void {
    if (root === this.root) return
    // Persist the outgoing project's index before we forget it, then reset — the
    // incoming root's index is loaded lazily the next time it's needed.
    this.flushIndex()
    this.root = root
    this.fileCache.clear()
    this.treeCache = null
    this.index = null
    this.indexDirty = false
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

    // Inject the persistent file-index (Problem 1): compact structural summaries
    // of files opened on earlier turns/runs, so the model starts already knowing
    // what the essentials contain and doesn't blindly re-read them. Stale entries
    // were dropped on load, so every summary here reflects the file as it is now.
    const index = this.ensureIndex()
    const indexed = Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b))
    if (indexed.length > 0) {
      const shown = indexed.slice(0, MAX_INDEX_ENTRIES)
      lines.push(
        `## File index (${indexed.length}${indexed.length > MAX_INDEX_ENTRIES ? `, showing ${MAX_INDEX_ENTRIES}` : ''})`,
        'Structural summaries cached from earlier reads — consult these before re-opening a file:'
      )
      for (const [path, entry] of shown) lines.push(`- ${path} — ${entry.summary}`)
      lines.push('')
    }

    for (const doc of KEY_DOCS) {
      const content = this.readFile(doc)
      if (content) {
        const trimmed =
          content.length > MAX_DOC_CHARS
            ? `${content.slice(0, MAX_DOC_CHARS)}\n… (truncated)`
            : content
        lines.push(`## ${doc}`, '```', trimmed, '```', '')
      }
    }

    return lines.join('\n')
  }

  // ── Persistent project index (Problem 1) ───────────────────────────────────

  /**
   * Resolves a caller-supplied path (project-relative, or absolute inside the
   * project) to `{ rel, abs, key }` against the PERSISTENT root — the index's
   * frame of reference. `key` is the POSIX-normalised relative path used to key
   * index entries; `abs` is the on-disk path to stat/read.
   */
  private toProjectRel(path: string): { rel: string; abs: string; key: string } {
    const rel = path.startsWith(this.root) ? relative(this.root, path) : path
    const abs = join(this.root, rel)
    const key = rel.split(sep).join('/')
    return { rel, abs, key }
  }

  /** Lazily loads + prunes the project index for the current root. */
  private ensureIndex(): ProjectIndex {
    if (!this.index) {
      this.index = loadIndex(this.root)
      this.pruneIndex(this.index)
    }
    return this.index
  }

  /** Drops index entries whose file has vanished or changed since it was indexed. */
  private pruneIndex(index: ProjectIndex): void {
    for (const [key, entry] of Object.entries(index.files)) {
      let fresh = false
      try {
        const st = statSync(join(this.root, key))
        fresh = st.isFile() && st.size === entry.size && st.mtimeMs === entry.mtime
      } catch {
        fresh = false
      }
      if (!fresh) {
        delete index.files[key]
        this.indexDirty = true
      }
    }
  }

  /**
   * `{ size, mtime }` of a project file resolved against the ACTIVE root (the
   * {@link runWithRoot} override if one is installed — matching how the read tools
   * resolve paths), or null when it's missing/unreadable. The engine's per-run
   * read-dedup uses this as its freshness guard: a changed size/mtime means a
   * cached read is stale and the file must be read again.
   */
  fileStamp(path: string): { size: number; mtime: number } | null {
    try {
      const root = this.getRoot()
      const abs = path.startsWith(root) ? path : join(root, path)
      const st = statSync(abs)
      return { size: st.size, mtime: st.mtimeMs }
    } catch {
      return null
    }
  }

  /**
   * Records what the agent just READ into the persistent index (Problem 1): reads
   * a bounded head of the file, summarises it structurally, and stores it keyed by
   * project-relative path. A no-op when the file is unchanged since it was last
   * indexed (freshness hit — so re-reading never re-summarises) or when a
   * {@link runWithRoot} override is active (a worktree subagent's reads resolve
   * against a throwaway tree and must not pollute the project index). Best-effort:
   * any fs/parse failure is swallowed so indexing never breaks a read.
   */
  noteRead(path: string): void {
    if (this.getRoot() !== this.root) return
    try {
      const { rel, abs, key } = this.toProjectRel(path)
      const st = statSync(abs)
      if (!st.isFile()) return
      const index = this.ensureIndex()
      const existing = index.files[key]
      if (existing && existing.size === st.size && existing.mtime === st.mtimeMs) return
      const { summary, symbols, imports } = summarizeSource(rel, readHead(abs))
      index.files[key] = {
        size: st.size,
        mtime: st.mtimeMs,
        summary,
        symbols: symbols.length ? symbols : undefined,
        imports: imports.length ? imports : undefined,
        indexedAt: Date.now()
      }
      this.indexDirty = true
    } catch {
      // Best-effort: indexing must never break a read.
    }
  }

  /**
   * Refreshes the index entry for a file the agent just WROTE, summarising the new
   * content directly (no re-read) and stamping it with the freshly-written file's
   * size/mtime so the next run treats it as fresh. Same override guard as
   * {@link noteRead}. Best-effort.
   */
  noteWrite(path: string, content: string): void {
    if (this.getRoot() !== this.root) return
    try {
      const { rel, abs, key } = this.toProjectRel(path)
      const st = statSync(abs)
      const { summary, symbols, imports } = summarizeSource(rel, content.slice(0, INDEX_HEAD_CHARS))
      const index = this.ensureIndex()
      index.files[key] = {
        size: st.size,
        mtime: st.mtimeMs,
        summary,
        symbols: symbols.length ? symbols : undefined,
        imports: imports.length ? imports : undefined,
        indexedAt: Date.now()
      }
      this.indexDirty = true
    } catch {
      // Best-effort.
    }
  }

  /**
   * The cached structural summary for a path, or undefined when the index has no
   * (fresh) entry for it. Used by the engine's read-dedup to enrich the "already
   * read" note. Scoped to the persistent root (returns undefined under a worktree
   * override, whose files aren't in the project index).
   */
  indexSummaryFor(path: string): string | undefined {
    if (this.getRoot() !== this.root || !this.index) return undefined
    return this.index.files[this.toProjectRel(path).key]?.summary
  }

  /**
   * The live project index — the in-memory one when a run has already loaded it,
   * otherwise whatever is on disk. The dependency graph reads through this rather
   * than `loadIndex` directly so a file summarised earlier in *this* run is part of
   * the picture; `.sylor/index.json` is only written at the end of a run, so going
   * straight to disk would draw the graph as it was before the run started.
   *
   * Always the persistent project's index, never a worktree override's — a
   * subagent's throwaway tree has no index of its own (see {@link noteRead}).
   */
  projectIndex(): ProjectIndex {
    if (this.getRoot() !== this.root) return loadIndex(this.root)
    return this.ensureIndex()
  }

  /**
   * Persists the index to disk if it has unsaved changes. Called at the end of a
   * run (and before a root switch) so summaries survive into the next run/session.
   * No-op when nothing changed; never throws (saveIndex swallows write errors).
   */
  flushIndex(): void {
    if (this.index && this.indexDirty) {
      saveIndex(this.root, this.index)
      this.indexDirty = false
    }
  }
}

/** Process-wide context manager instance (singleton for Phase 3). Defaults to
 *  the working directory; a project-open flow can retarget it later. */
export const contextManager = new ContextManager(process.cwd())
