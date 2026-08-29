/**
 * Git operations for plugin install — a dependency-free wrapper over the system
 * `git` binary via `node:child_process`. We shell out rather than bundle a Git
 * implementation: `git` is near-universal on developer machines, needs no npm
 * dependency (keeping the offline/air-gapped story intact), and gives correct
 * auth/proxy/submodule behavior for free.
 *
 * Both calls are total — they resolve to a result object rather than rejecting —
 * and use `execFile` (no shell), so a hostile repo URL cannot inject a command.
 * A leading `--` before user-supplied arguments blocks Git option-injection.
 */
import { execFile } from 'node:child_process'

/** Outcome of a clone attempt. */
export interface GitCloneResult {
  ok: boolean
  /** A short, user-facing reason when `ok` is false. */
  error?: string
}

/** Resolves true when a usable `git` is on PATH (probed via `git --version`). */
export function isGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err))
  })
}

/** Trims Git's stderr into one tidy line for the UI (drops blank/progress noise). */
function cleanGitError(raw: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  return (line || 'git clone failed').replace(/^fatal:\s*/i, '').slice(0, 300)
}

/**
 * Shallow-clones `url` into `dest` (which must not yet exist). Uses `--depth 1
 * --single-branch` so only the tip is fetched — a plugin repo's history is
 * irrelevant. `signal` lets a caller cancel; a rejected/blank URL is refused up
 * front. Resolves `{ ok:false, error }` on any failure rather than throwing.
 */
export function gitClone(url: string, dest: string, signal?: AbortSignal): Promise<GitCloneResult> {
  if (!url.trim() || url.startsWith('-')) {
    return Promise.resolve({ ok: false, error: 'Refusing to clone an unsafe URL.' })
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['clone', '--depth', '1', '--single-branch', '--', url, dest],
      { timeout: 120_000, windowsHide: true, signal },
      (err, _stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ ok: false, error: 'Git is not installed or not on PATH.' })
          } else if ((err as { name?: string }).name === 'AbortError') {
            resolve({ ok: false, error: 'Install cancelled.' })
          } else {
            resolve({ ok: false, error: cleanGitError(String(stderr || err.message)) })
          }
          return
        }
        resolve({ ok: true })
      }
    )
  })
}
