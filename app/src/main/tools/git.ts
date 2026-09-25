import { resolve } from 'node:path'
import { executeArgv, formatRunResult, type RunResult } from './runCode'
import { fsAvailable } from './fs'
import type { ToolContext, ToolDef } from './registry'

/**
 * The Cowork git tools — version control from inside the working folder, so the
 * agent can inspect history and land its own work without shelling out through the
 * generic `run_command`. They matter for two reasons:
 *
 *  - **Correct per-operation permissioning.** A single omnibus tool can only carry
 *    one {@link ToolDef.sideEffect} tier, so reads and pushes would prompt alike.
 *    Splitting them lets `git_status`/`git_diff`/`git_log` run friction-free
 *    (read-only, never prompts), `git_commit` sit at the `write` tier (silent under
 *    autoApprove, asks under `ask`), and anything that leaves the machine or mutates
 *    history go through the arbitrary {@link gitTool} at the `exec` tier (always
 *    approval-gated) — matching how the desktop app gates VCS actions.
 *  - **No shell, no quoting hazard.** Every command runs through {@link executeArgv}
 *    with an explicit argv, so a commit message or a path with spaces/quotes/shell
 *    metacharacters is passed verbatim as one argument and can never be
 *    re-interpreted by a shell. That is why `git_commit` takes a `message` field
 *    rather than having the model assemble a `git commit -m "…"` line itself.
 *
 * All of them are gated by {@link fsAvailable}: git only makes sense in Cowork with a
 * chosen working folder, which is also the repo they act on (via `cwd`). `git` and
 * `gh` resolve from PATH and inherit `process.env`, so the user's own credential
 * manager / `GH_TOKEN` applies. Note: these are NON-interactive (no stdin) — a
 * command that would prompt for a passphrase or password will hang until it times
 * out, so credentials must be pre-configured.
 */

/** Version-control commands (a fetch/push over the network) can be slow — give them room. */
const GIT_TIMEOUT_MS = 120_000
/** Default number of commits `git_log` shows when the model gives no count. */
const DEFAULT_LOG_COUNT = 15
/** Upper bound on `git_log` count so one call can't dump an enormous history. */
const MAX_LOG_COUNT = 100

/** A short unique id for one git run, so the Terminal pane can show it as its own row. */
function gitRunId(): string {
  return `git-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Run `git <args>` in the working folder, mirror it to the Terminal pane, and
 * return the formatted result the model reads back. The single execution path all
 * the git tools funnel through, so the sandbox (cwd), Terminal mirroring, and
 * output formatting are identical across them.
 */
async function runGit(args: string[], ctx: ToolContext): Promise<string> {
  const cwd = ctx.workspaceDir ? resolve(ctx.workspaceDir) : undefined
  if (!cwd) return 'git tools need a working folder to be set.'
  const result = await executeArgv('git', args, ctx.signal, { cwd, timeoutMs: GIT_TIMEOUT_MS })
  mirrorToTerminal(`git ${args.join(' ')}`, result, cwd, ctx)
  // A missing `git` executable surfaces as a spawn error; give the model an actionable message.
  if (result.spawnError) {
    return `Could not run git: ${result.spawnError}. Is git installed and on PATH?`
  }
  return formatRunResult(`git ${args.join(' ')}`, result, GIT_TIMEOUT_MS)
}

/** Push the raw combined output to the renderer's Terminal pane (display-only). */
function mirrorToTerminal(command: string, result: RunResult, cwd: string, ctx: ToolContext): void {
  const output = result.spawnError
    ? result.spawnError
    : [result.stdout, result.stderr].map((s) => s.trimEnd()).filter(Boolean).join('\n') ||
      (result.timedOut ? `(timed out after ${GIT_TIMEOUT_MS / 1000}s)` : '(no output)')
  ctx.onCommand?.({ id: gitRunId(), command, output, exitCode: result.spawnError ? null : result.exitCode, cwd })
}

/** Read a trimmed string field out of a tool input, or null. */
function readString(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** Whether a boolean-ish field is explicitly true. */
function readBool(input: unknown, key: string): boolean {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[key] === true : false
}

export const gitStatusTool: ToolDef = {
  name: 'git_status',
  description:
    'Show the working-folder git status (branch + staged/unstaged/untracked changes, short format). Read-only — use it to see what has changed before staging or committing.',
  usage: '{}',
  available: fsAvailable,
  run: (_input, ctx) => runGit(['status', '--short', '--branch'], ctx)
}

export const gitDiffTool: ToolDef = {
  name: 'git_diff',
  description:
    'Show the git diff of the working folder. Read-only. Pass "staged": true for what is staged for commit, or "path" to limit the diff to one file/folder.',
  usage: '{"staged": false, "path": "src/app.ts"}',
  available: fsAvailable,
  run: (input, ctx) => {
    const args = ['diff']
    if (readBool(input, 'staged')) args.push('--staged')
    const path = readString(input, 'path')
    if (path) args.push('--', path)
    return runGit(args, ctx)
  }
}

export const gitLogTool: ToolDef = {
  name: 'git_log',
  description:
    'Show recent commits (one line each: short hash + subject). Read-only. Pass "count" for how many (default 15).',
  usage: '{"count": 15}',
  available: fsAvailable,
  run: (input, ctx) => {
    const rawCount = input && typeof input === 'object' ? (input as Record<string, unknown>).count : undefined
    const n = typeof rawCount === 'number' && Number.isFinite(rawCount) ? Math.floor(rawCount) : DEFAULT_LOG_COUNT
    const count = Math.max(1, Math.min(MAX_LOG_COUNT, n))
    return runGit(['log', `-n`, String(count), '--oneline', '--decorate'], ctx)
  }
}

export const gitCommitTool: ToolDef = {
  name: 'git_commit',
  description:
    'Stage changes and create a commit with "message". By default stages only already-tracked files (git add -u); pass "all": true to also stage new/untracked files (git add -A). A write-tier action.',
  usage: '{"message": "fix: handle empty input", "all": false}',
  sideEffect: 'write',
  available: fsAvailable,
  async run(input, ctx) {
    const message = readString(input, 'message')
    if (!message) {
      return 'git_commit needs a non-empty "message" string, e.g. {"message": "fix: …"}.'
    }
    // Stage first (all tracked, or everything including untracked), then commit.
    const stage = await runGit(readBool(input, 'all') ? ['add', '-A'] : ['add', '-u'], ctx)
    // The message is passed as its own argv element, so no quoting/escaping is needed.
    const commit = await runGit(['commit', '-m', message], ctx)
    return `${stage}\n\n${commit}`
  }
}

/** Split a raw `args` value (string or string[]) into an argv, dropping a redundant leading "git". */
function readArgs(input: unknown): string[] | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).args : undefined
  let parts: string[]
  if (Array.isArray(raw)) {
    parts = raw.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
  } else if (typeof raw === 'string' && raw.trim()) {
    // A plain string is split on whitespace — fine for the common cases (push,
    // pull, branch, checkout). For arguments that contain spaces, pass an array.
    parts = raw.trim().split(/\s+/)
  } else {
    return null
  }
  if (parts[0]?.toLowerCase() === 'git') parts = parts.slice(1)
  return parts.length ? parts : null
}

export const gitTool: ToolDef = {
  name: 'git',
  description:
    'Run an arbitrary git command in the working folder (e.g. branch, checkout, merge, pull, push, reset). Use the read-only git_status/git_diff/git_log and git_commit for the common cases; this is the escape hatch for everything else. An exec-tier action (approval-gated) because it can push, mutate history, or reach the network. Pass "args" as an array (preferred) or a string; a leading "git" is optional. Non-interactive — a command that prompts for a password will hang.',
  usage: '{"args": ["push", "origin", "main"]}',
  sideEffect: 'exec',
  available: fsAvailable,
  run: (input, ctx) => {
    const args = readArgs(input)
    if (!args) {
      return Promise.resolve(
        'git needs an "args" array or string, e.g. {"args": ["push", "origin", "main"]} or {"args": "checkout -b feature"}.'
      )
    }
    return runGit(args, ctx)
  }
}

/** All Cowork git tools, in the order they're advertised to the model. */
export const gitTools: readonly ToolDef[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitTool
]
