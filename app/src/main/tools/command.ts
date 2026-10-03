import { resolve } from 'node:path'
import { executeCode, formatRunResult, resolveShell } from './runCode'
import { unsafeCommandReason } from './exec-guard'
import { fsAvailable } from './fs'
import type { ToolDef } from './registry'

/**
 * `run_command` — run a shell command in the working folder and hand its output
 * back. This is the verification workhorse of Cowork: after the agent writes code it
 * runs the project's own build / test / lint / typecheck, reads the real output, and
 * fixes what actually broke — instead of declaring success it never checked.
 *
 * It is a thin, clearer-labelled shell over the same {@link executeCode} runner
 * `run_code` uses, but through a full shell ({@link resolveShell} — Git Bash where
 * installed on Windows, else cmd.exe; bash on Unix) pinned to the working folder as
 * cwd. It is a side-effecting exec tool, so the Cowork permission tier gates it like
 * run_code.
 */

/** Verification/build commands can be slow (a real test run), so give them room. */
const COMMAND_TIMEOUT_MS = 120_000

/** A short unique id for one command run, so the Terminal pane can upsert it in place. */
function commandRunId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Read the `command` string out of a tool input, or null. */
function readCommand(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export const runCommandTool: ToolDef = {
  name: 'run_command',
  description:
    'Run a shell command in the working folder and return its output — use it to verify your work: run the build, tests, linter, or typecheck (e.g. "npm test", "npm run build"), or to scaffold/install (e.g. "npm install"). Read the output and fix what actually failed.',
  usage: '{"command": "npm run build"}',
  sideEffect: 'exec',
  available: fsAvailable,
  async run(input, ctx) {
    const command = readCommand(input)
    if (!command) return 'run_command needs a "command" string, e.g. {"command": "npm test"}.'
    // Defence-in-depth under the permission tier: reject control-character injection
    // (NUL / newline / CR / ESC) before it reaches the shell. Normal shell syntax
    // (&&, pipes, quotes, globs) is untouched — this only stops the pathological cases.
    const unsafe = unsafeCommandReason(command)
    if (unsafe) return `run_command refused: ${unsafe}`
    const spec = resolveShell()
    const cwd = ctx.workspaceDir ? resolve(ctx.workspaceDir) : undefined
    if (!cwd) return 'run_command: no working folder is set.'
    // Scoped credential injection: a saved secret enters the child's ENV only when this
    // command's leading program matches the credential's scope (GH_TOKEN for `git`/`gh`,
    // not for `npm install`). The value lives in the child env, never on argv, and never
    // in the model-facing return (redacted centrally in runTool).
    const injected = ctx.resolveCredentialEnv?.(command)
    const result = await executeCode(spec, command, ctx.signal, cwd, COMMAND_TIMEOUT_MS, injected)
    // Mirror the run to the renderer's Terminal pane (Cowork): the raw combined
    // output, or the spawn error / a placeholder when there was none. This is
    // display-only — the model still reads the formatted result returned below.
    const output = result.spawnError
      ? result.spawnError
      : [result.stdout, result.stderr].map((s) => s.trimEnd()).filter(Boolean).join('\n') ||
        (result.timedOut ? `(timed out after ${COMMAND_TIMEOUT_MS / 1000}s)` : '(no output)')
    // The Terminal pane is a SEPARATE channel the central runTool redactor never sees, so
    // scrub any injected secret out of the mirrored output here too (e.g. a command that
    // echoed its own env). No-op when no redactor/secret is in play.
    const safeOutput = ctx.redactSecrets?.(output) ?? output
    ctx.onCommand?.({ id: commandRunId(), command, output: safeOutput, exitCode: result.spawnError ? null : result.exitCode, cwd })
    return formatRunResult(`command "${command}"`, result, COMMAND_TIMEOUT_MS)
  }
}
