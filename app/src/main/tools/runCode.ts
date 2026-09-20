import { spawn } from 'node:child_process'
import type { ToolDef } from './registry'

/**
 * `run_code` — execute a short snippet of python / JavaScript / bash on the
 * user's machine and hand its output back to the model. This is the one tool that
 * runs arbitrary code with the user's privileges, so it is gated behind an
 * explicit opt-in ({@link ProviderSettings.tools}.codeExecution, default off): the
 * registry never advertises it while off (see {@link ToolDef.available}), and
 * {@link runCodeTool.run} refuses a second time even if it were somehow called.
 *
 * The JavaScript path runs the very Node that hosts this process
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE`), so it needs nothing on `PATH` and
 * behaves identically in the Electron app and under Vitest. python/bash resolve
 * from `PATH`; a missing interpreter degrades to a readable message, never a throw.
 */

/** Longest a snippet may run before it is killed. */
const RUN_TIMEOUT_MS = 15_000
/** Largest captured stream, in characters (each of stdout/stderr). */
const OUTPUT_CAP = 10_000

/** How to invoke one language: the executable, its "run this string" flag, env. */
export interface InterpreterSpec {
  cmd: string
  flag: string
  /** When set, run `cmd` as Node via ELECTRON_RUN_AS_NODE (the bundled runtime). */
  electronNode?: boolean
}

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

const INTERPRETERS: Record<string, InterpreterSpec> = {
  python: { cmd: PYTHON, flag: '-c' },
  py: { cmd: PYTHON, flag: '-c' },
  python3: { cmd: PYTHON, flag: '-c' },
  javascript: { cmd: process.execPath, flag: '-e', electronNode: true },
  js: { cmd: process.execPath, flag: '-e', electronNode: true },
  node: { cmd: process.execPath, flag: '-e', electronNode: true },
  bash: { cmd: 'bash', flag: '-c' },
  sh: { cmd: 'bash', flag: '-c' }
}

/** Map a language name to its interpreter spec, or null if unsupported. */
export function resolveInterpreter(language: string): InterpreterSpec | null {
  return INTERPRETERS[language.toLowerCase()] ?? null
}

/** Outcome of one execution. */
export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when the interpreter itself could not be launched (e.g. not installed). */
  spawnError?: string
}

/** Spawn the interpreter, capture output under a timeout + size cap, resolve. */
export async function executeCode(
  spec: InterpreterSpec,
  code: string,
  signal: AbortSignal
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(spec.cmd, [spec.flag, code], {
      env: spec.electronNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      windowsHide: true
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, RUN_TIMEOUT_MS)

    const onAbort = (): void => {
      child.kill()
    }

    const done = (r: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(r)
    }

    if (signal.aborted) child.kill()
    else signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > OUTPUT_CAP) {
        stdout = stdout.slice(0, OUTPUT_CAP)
        child.kill()
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(0, OUTPUT_CAP)
    })
    child.on('error', (err) => done({ stdout, stderr, exitCode: null, timedOut, spawnError: err.message }))
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode, timedOut }))
  })
}

/** Render a {@link RunResult} as the plain text the model reads back. */
export function formatRunResult(language: string, r: RunResult): string {
  if (r.spawnError) {
    return `Could not run ${language}: ${r.spawnError}. Is the interpreter installed and on PATH?`
  }
  const parts: string[] = []
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trimEnd()}`)
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trimEnd()}`)
  if (r.timedOut) parts.push(`(killed after ${RUN_TIMEOUT_MS / 1000}s timeout)`)
  parts.push(`exit code: ${r.exitCode ?? 'n/a'}`)
  return parts.join('\n\n')
}

/** Read `{language, code}` out of a tool input, normalising the language. */
function readCodeInput(input: unknown): { language: string | null; code: string | null } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const language = typeof o.language === 'string' && o.language.trim() ? o.language.trim().toLowerCase() : null
  const code = typeof o.code === 'string' && o.code ? o.code : null
  return { language, code }
}

export const runCodeTool: ToolDef = {
  name: 'run_code',
  description: 'Execute a snippet of python, JavaScript (node), or bash on this machine and return its output.',
  usage: '{"language": "python", "code": "print(2 + 2)"}',
  available: (s) => s.tools.codeExecution,
  async run(input, ctx) {
    // Belt-and-braces: the registry hides this tool while the setting is off, but
    // never trust that a call couldn't arrive anyway (stale prompt, replayed turn).
    if (!ctx.settings.tools.codeExecution) {
      return 'run_code is disabled. The user can turn it on in Settings › Tools › “Run code on this machine”.'
    }
    const { language, code } = readCodeInput(input)
    if (!language || !code) {
      return 'run_code needs a JSON input like {"language": "python", "code": "…"}.'
    }
    const spec = resolveInterpreter(language)
    if (!spec) return `run_code does not support "${language}". Use python, javascript, or bash.`
    return formatRunResult(language, await executeCode(spec, code, ctx.signal))
  }
}
