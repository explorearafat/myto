/**
 * One way to run `git` in the main process.
 *
 * Both features that shell out to git — worktree isolation for subagents and
 * checkpoints — need the same three properties, so they share one function rather
 * than each growing its own: `execFile` (never a shell, so a hostile path, branch
 * name or label cannot be interpreted as a command), a bounded timeout and buffer,
 * and **totality** — it resolves a result instead of rejecting, so callers degrade
 * gracefully when git is missing, the folder is not a repo, or the call is aborted.
 *
 * `env` exists for the one thing checkpoints need that nothing else does:
 * `GIT_INDEX_FILE` pointed at a scratch index, which is what lets a snapshot stage
 * the whole tree without touching the index the user is about to commit from.
 */
import { execFile } from 'node:child_process'

/** Result of a git invocation: total (never throws), stdout/stderr captured. */
export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Runs `git <args>` in `cwd`. Resolves a {@link GitResult} for every outcome,
 * including a git that isn't installed. `env` is merged over the process
 * environment (used for `GIT_INDEX_FILE`); omit it and git sees exactly what
 * Sylor sees.
 */
export function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: Record<string, string>
): Promise<GitResult> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 30_000,
        windowsHide: true,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        ...(env ? { env: { ...process.env, ...env } } : {})
      },
      (err, stdout, stderr) => {
        resolveResult({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}
