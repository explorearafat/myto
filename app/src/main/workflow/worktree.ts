/**
 * Worktree isolation for delegated subagents (Phase 3, requirement: sub-agent
 * power-up).
 *
 * When the lead spawns an agent with `isolation: 'worktree'`, that agent works
 * in a private `git worktree` carved from the project's current commit — its own
 * directory on its own throwaway branch. Combined with the engine's
 * `contextManager.runWithRoot(dir, …)` wrapper, every file the agent writes and
 * every command it runs is confined to that directory, so two isolated agents
 * can edit files in parallel without clobbering each other or the lead. When the
 * agent finishes, {@link finalizeWorktree} syncs its changes back into the main
 * project and tears the worktree down; an unchanged worktree is simply removed.
 *
 * Everything here is **best-effort and total**: git runs through `execFile` (no
 * shell — a path or branch name can't inject a command), and no function ever
 * throws. If git is missing, the project isn't a repo, or a step fails,
 * {@link createWorktree} returns `null` (the caller runs the agent in the shared
 * root instead) and {@link finalizeWorktree} leaves the worktree on disk rather
 * than losing the agent's work to a cleanup error.
 *
 * Note the isolation boundary: a worktree is checked out at `HEAD`, so an agent
 * inside it sees committed state plus its own writes — not the lead's
 * *uncommitted* edits. That is intended for genuinely independent slices; the
 * lead's prompt is told to reserve isolation for exactly those.
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isGitAvailable } from '../plugins/git'
import { contextManager } from '../context/manager'

/** A live isolated worktree carved for one subagent. */
export interface WorktreeHandle {
  /** Absolute path of the private worktree directory the agent works in. */
  dir: string
  /** The temporary branch backing the worktree (deleted on finalize). */
  branch: string
  /** The main project root the worktree was carved from (sync-back target). */
  base: string
}

/** Result of a git invocation: total (never throws), stdout/stderr captured. */
interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Runs `git <args>` in `cwd` through `execFile` — no shell, so a hostile path or
 * branch name can't be interpreted as a command. Total: it resolves a
 * {@link GitResult} rather than rejecting, so callers degrade gracefully on any
 * failure (missing git, non-repo, aborted signal) instead of unwinding.
 */
function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 30_000, windowsHide: true, signal, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolveResult({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/**
 * Resolves a repo-relative path against `base`, returning the absolute path only
 * if it stays *inside* `base`. A porcelain path that tries to escape the tree
 * (via `..`, an absolute path, etc.) yields `null` and is skipped — a subagent's
 * sync-back can never write outside the main project root.
 */
function safeJoin(base: string, rel: string): string | null {
  const root = resolve(base)
  const dest = resolve(root, rel)
  if (dest !== root && !dest.startsWith(root + sep)) return null
  return dest
}

/** One change reported by `git status --porcelain -z`. */
interface PorcelainEntry {
  /** Repo-relative path of the (new) file. */
  path: string
  /** True when the file was removed in the worktree. */
  deleted: boolean
  /** For a rename/copy, the original path (removed from the main tree). */
  from?: string
}

/**
 * Parses NUL-separated `git status --porcelain -z` output. The `-z` format emits
 * each entry as `XY <path>` terminated by NUL, and for a rename/copy the source
 * path follows as its own NUL-terminated token — so a rename consumes two tokens.
 * NUL separation (rather than newline) is what lets paths containing spaces or
 * newlines parse unambiguously and without git's quoting.
 */
function parsePorcelainZ(out: string): PorcelainEntry[] {
  const tokens = out.split('\0').filter((t) => t.length > 0)
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.length < 4) continue // need "XY " + at least one path char
    const x = token[0]
    const y = token[1]
    const path = token.slice(3)
    const isRename = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    let from: string | undefined
    if (isRename) {
      // The rename/copy SOURCE is the next NUL-separated token.
      from = tokens[i + 1]
      i++
    }
    // A delete is reported by 'D' on either side; a rename is a move, not a delete.
    const deleted = !isRename && (x === 'D' || y === 'D')
    entries.push({ path, deleted, from })
  }
  return entries
}

/**
 * Carves a private git worktree for a subagent so its writes and commands are
 * isolated from the lead's and any sibling's. Returns a {@link WorktreeHandle},
 * or `null` when isolation isn't possible (no git, not a repo, aborted, or the
 * worktree couldn't be created) — the caller then simply runs the agent in the
 * shared root, so isolation is a best-effort enhancement, never a hard
 * dependency.
 */
export async function createWorktree(
  agentId: string,
  signal?: AbortSignal
): Promise<WorktreeHandle | null> {
  if (signal?.aborted) return null
  // Capture the base now: finalize runs AFTER the runWithRoot override has been
  // torn down, so it can't re-read getRoot() to find the sync-back target.
  const base = contextManager.getRoot()

  // Guard 1: git must be on PATH (same probe the plugin installer uses).
  if (!(await isGitAvailable())) return null
  if (signal?.aborted) return null

  // Guard 2: the root must be a git work tree — `git worktree` is meaningless
  // otherwise, so we degrade to the shared root.
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], base, signal)
  if (!inside.ok || inside.stdout.trim() !== 'true') return null

  // A unique, collision-proof location under the OS temp dir. The token also
  // backs the branch name, so two runs (or a crashed leftover) never clash.
  const token = `${agentId}-${randomUUID().slice(0, 8)}`
  const dir = join(tmpdir(), 'sylor-worktrees', token)
  const branch = `sylor/agent-${token}`

  // `worktree add -b <branch> <dir> HEAD` checks a fresh branch out at the
  // current commit in an isolated directory. Every argument here is
  // program-generated (never user text), so no `--` guard is needed — and adding
  // one would wrongly make git read `HEAD` as a pathspec.
  const added = await runGit(['worktree', 'add', '-b', branch, dir, 'HEAD'], base, signal)
  if (!added.ok) return null

  return { dir, branch, base }
}

/**
 * Winds a worktree down after its agent finishes: syncs the agent's changes back
 * into the main project, then removes the worktree and its temp branch. Changes
 * are enumerated with `git status --porcelain` against the worktree's HEAD —
 * added/modified/renamed files are copied into the main root and deletions are
 * mirrored. An unchanged worktree is simply removed.
 *
 * Every step degrades gracefully: on any git or fs failure the worktree is left
 * on disk and the failure swallowed, never thrown, so a subagent's result is
 * never lost to a cleanup error. Returns a short human note describing what was
 * synced (for the agent report / logs), or `''` when nothing changed.
 */
export async function finalizeWorktree(
  handle: WorktreeHandle,
  signal?: AbortSignal
): Promise<string> {
  const { dir, branch, base } = handle
  let synced = 0
  let deleted = 0
  try {
    // `-z` → NUL-separated entries (unambiguous paths); `--untracked-files=all`
    // so brand-new files the agent wrote are enumerated, not just tracked edits.
    const status = await runGit(
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      dir,
      signal
    )
    if (status.ok && status.stdout) {
      for (const entry of parsePorcelainZ(status.stdout)) {
        const dest = safeJoin(base, entry.path)
        if (!dest) continue
        if (entry.deleted) {
          try {
            rmSync(dest, { force: true })
            deleted++
          } catch {
            /* best-effort: a file we couldn't remove is not worth failing over */
          }
          continue
        }
        // A rename also drops the old path from the main tree.
        if (entry.from) {
          const old = safeJoin(base, entry.from)
          if (old) {
            try {
              rmSync(old, { force: true })
            } catch {
              /* best-effort */
            }
          }
        }
        const src = safeJoin(dir, entry.path)
        if (!src || !existsSync(src)) continue
        try {
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(src, dest)
          synced++
        } catch {
          /* best-effort */
        }
      }
    }
  } finally {
    // Remove the worktree + its branch regardless of sync outcome. `--force`
    // because the worktree carries uncommitted changes we've already copied out.
    await runGit(['worktree', 'remove', '--force', dir], base, signal)
    await runGit(['branch', '-D', branch], base, signal)
    // If `worktree remove` failed (e.g. a locked dir on Windows), drop the
    // directory anyway so temp doesn't accumulate, then prune git's registry.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    await runGit(['worktree', 'prune'], base, signal)
  }

  if (synced === 0 && deleted === 0) return ''
  const parts: string[] = []
  if (synced > 0) parts.push(`${synced} file${synced === 1 ? '' : 's'} synced`)
  if (deleted > 0) parts.push(`${deleted} deleted`)
  return `Isolated worktree changes merged back into the project (${parts.join(', ')}).`
}
