import type { IPty } from '@lydell/node-pty'
import { ptyAvailable, ptyLoadError, spawnCommandPty } from './pty'

/** Cap on captured output fed back to the model / UI (keeps things token-light). */
const MAX_OUTPUT = 32_000

/** Outcome of a one-shot agent command. */
export interface CommandRunResult {
  /** Exit code, or null if the command was aborted before exiting. */
  exitCode: number | null
  /** Captured combined output, truncated to {@link MAX_OUTPUT}. */
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
}

/**
 * Runs a shell command in a one-shot pty. Output streams live through `onData`
 * (so the integrated terminal shows it as it happens) and is simultaneously
 * buffered — bounded — for the returned result. Respects `signal`: an abort
 * kills the pty and resolves with whatever was captured. `options.timeoutMs`
 * adds a self-abort after the deadline, and `options.env` passes extra
 * environment variables to the child.
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
      term = spawnCommandPty(command, undefined, undefined, options?.env)
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
      resolve({ exitCode, output: buffer, truncated })
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
        if (buffer.length > MAX_OUTPUT) {
          buffer = buffer.slice(0, MAX_OUTPUT)
          truncated = true
        }
      }
    })

    term.onExit(({ exitCode }) => finish(exitCode))
  })
}
