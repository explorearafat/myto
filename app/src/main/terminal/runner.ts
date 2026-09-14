import type { IPty } from '@lydell/node-pty'
import { stripAnsi } from '../../shared/ansi'
import { ptyAvailable, ptyLoadError, spawnCommandPty } from './pty'
import { spawnSandboxedCommand } from './sandbox'
import type { PermissionMode } from '../../shared/types'

/** Cap on captured output fed back to the model / UI (keeps things token-light). */
const MAX_OUTPUT = 32_000

/**
 * Cap on the raw bytes held while the command runs, before escapes are stripped.
 * Generous relative to {@link MAX_OUTPUT} because progress-heavy output is mostly
 * escape sequences — capping the raw stream at 32k would spend most of the budget
 * on colour codes and hand the model a few lines of actual text.
 */
const MAX_RAW = MAX_OUTPUT * 4

/** Outcome of a one-shot agent command. */
export interface CommandRunResult {
  /** Exit code, or null if the command was aborted before exiting. */
  exitCode: number | null
  /**
   * Captured combined output, truncated to {@link MAX_OUTPUT}, with terminal escape
   * sequences removed. This copy is read back by the model and shown on a tool
   * card — neither renders a terminal, and a dev server's `\x1b[K` reaching the
   * model is how `http://localhost:8080/[K` ends up quoted in the conversation.
   * The live `onData` stream keeps every byte for the terminal panel.
   */
  output: string
  /** True when output exceeded the cap and was truncated. */
  truncated: boolean
}

/** Extra knobs for {@link runCommand}; all optional (ordinary commands pass none). */
export interface RunCommandOptions {
  /** Environment variables merged over `process.env` for the child (e.g. hook context). */
  env?: Record<string, string | undefined>
  /**
   * Kill the command after this many ms and resolve with exitCode `null`. Used to
   * bound automation hooks so a hung hook can't stall a run. Combined with any
   * caller `signal`, so either an abort or a timeout stops the command.
   */
  timeoutMs?: number
  /**
   * Run the command inside the OS-level sandbox (Principle 7 #3), confined to
   * `workspaceRoot` with confinement derived from `mode` (plan → read-only, else
   * workspace-write). Only the agent's own `run_command` passes this — hooks and the
   * preview-install path deliberately run unconfined (they are the user's own
   * plumbing and legitimately reach outside the workspace / the network). Where the
   * OS can't enforce it (Windows, today) this degrades to an ordinary spawn; the
   * command classifier + approval prompts are the fail-safe.
   */
  sandbox?: { workspaceRoot: string; mode: PermissionMode }
}

/**
 * Runs a shell command in a one-shot pty. Output streams live through `onData`
 * (so the integrated terminal shows it as it happens, escape sequences and all)
 * and is simultaneously buffered — bounded — for the returned result, which is
 * cleaned of escapes because nothing downstream of it is a terminal. Respects
 * `signal`: an abort kills the pty and resolves with whatever was captured.
 * `options.timeoutMs` adds a self-abort after the deadline, and `options.env`
 * passes extra environment variables to the child.
 *
 * Never rejects: a spawn failure resolves with exitCode 1 and the error text as
 * output, so the engine can surface it as a normal (failed) tool result.
 */
export function runCommand(
  command: string,
  onData: (data: string) => void,
  signal?: AbortSignal,
  options?: RunCommandOptions
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    if (!ptyAvailable()) {
      const message = ptyLoadError() ?? 'Terminal backend unavailable'
      onData(`\x1b[31m${message}\x1b[0m\r\n`)
      resolve({ exitCode: 1, output: message, truncated: false })
      return
    }

    // A timeout is modelled as its own abort signal, combined with the caller's:
    // whichever fires first kills the pty. `AbortSignal.any` is available on the
    // bundled Node 24 (Electron 43) and the Node the tests run on.
    let timer: ReturnType<typeof setTimeout> | undefined
    let effectiveSignal = signal
    if (options?.timeoutMs && options.timeoutMs > 0) {
      const timeoutController = new AbortController()
      timer = setTimeout(() => timeoutController.abort(), options.timeoutMs)
      effectiveSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal
    }

    let term: IPty
    try {
      term = options?.sandbox
        ? spawnSandboxedCommand(
            command,
            options.sandbox.workspaceRoot,
            options.sandbox.mode,
            undefined,
            undefined,
            options?.env
          )
        : spawnCommandPty(command, undefined, undefined, options?.env)
    } catch (err) {
      if (timer) clearTimeout(timer)
      const message = err instanceof Error ? err.message : String(err)
      onData(`\x1b[31m${message}\x1b[0m\r\n`)
      resolve({ exitCode: 1, output: message, truncated: false })
      return
    }

    let buffer = ''
    let truncated = false
    let settled = false

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      effectiveSignal?.removeEventListener('abort', onAbort)
      // Stripped once, at the end, over the whole buffer: a sequence split across
      // two pty chunks is only whole here, and stripping per chunk would leave its
      // halves behind as visible junk.
      let output = stripAnsi(buffer)
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT)
        truncated = true
      }
      resolve({ exitCode, output, truncated })
    }

    const onAbort = (): void => {
      try {
        term.kill()
      } catch {
        // Already gone.
      }
      finish(null)
    }

    if (effectiveSignal) {
      if (effectiveSignal.aborted) {
        onAbort()
        return
      }
      effectiveSignal.addEventListener('abort', onAbort)
    }

    term.onData((data) => {
      onData(data)
      if (!truncated) {
        buffer += data
        if (buffer.length > MAX_RAW) {
          buffer = buffer.slice(0, MAX_RAW)
          truncated = true
        }
      }
    })

    term.onExit(({ exitCode }) => finish(exitCode))
  })
}
