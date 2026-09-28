import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

/** Longest a snippet may run before it is killed (Chat / default). */
const RUN_TIMEOUT_MS = 15_000
/**
 * A longer ceiling in Cowork, where run_code is how the agent actually produces
 * deliverables (render a multi-page PDF, build/convert files, install a package
 * and use it) — work that legitimately needs more than the 15s a quick chat
 * snippet gets.
 */
const COWORK_RUN_TIMEOUT_MS = 60_000
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
  node: { cmd: process.execPath, flag: '-e', electronNode: true }
}

/** Map a language name to its interpreter spec, or null if unsupported. */
export function resolveInterpreter(language: string): InterpreterSpec | null {
  const key = language.toLowerCase()
  // bash/sh resolve to a REAL shell: on Windows that means discovering Git Bash's
  // bash.exe (which is rarely on PATH), so `run_code` with language "bash" actually
  // runs instead of failing to spawn — the "Bash isn't available, let me try Python"
  // fallback the agent used to hit. See {@link resolveBash}.
  if (key === 'bash' || key === 'sh') return resolveBash()
  return INTERPRETERS[key] ?? null
}

/**
 * Where Git for Windows drops `bash.exe`, in preference order — checked because it
 * is almost never on the Electron process's PATH (so a bare `spawn('bash')` throws
 * ENOENT). `Git\bin\bash.exe` is the wrapper that sets up a sane MSYS environment,
 * so it's preferred over `Git\usr\bin\bash.exe`. `MYTO_BASH` overrides everything for
 * non-standard installs (Scoop, WSL, a portable Git).
 */
function windowsBashCandidates(): string[] {
  const c: string[] = []
  if (process.env.MYTO_BASH) c.push(process.env.MYTO_BASH)
  const add = (base?: string): void => {
    if (base) c.push(join(base, 'Git', 'bin', 'bash.exe'))
  }
  add(process.env.ProgramW6432)
  add(process.env.ProgramFiles)
  add(process.env['ProgramFiles(x86)'])
  if (process.env.LOCALAPPDATA) c.push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  c.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  return c
}

/** The discovered bash.exe on Windows (Git Bash), or null. Resolved once, cached. */
let winBash: string | null | undefined
function windowsBashPath(): string | null {
  if (winBash === undefined) winBash = windowsBashCandidates().find((p) => existsSync(p)) ?? null
  return winBash
}

/**
 * A real POSIX shell for `run_code` language "bash"/"sh". On Unix that is `bash -c`;
 * on Windows it is the discovered Git Bash `bash.exe` ({@link windowsBashPath}), so
 * bash snippets actually run rather than failing to spawn. Falls back to a bare
 * `bash` when none is found, so the spawn error still names the missing interpreter
 * instead of pretending bash is an unsupported language.
 */
export function resolveBash(): InterpreterSpec {
  if (process.platform !== 'win32') return { cmd: 'bash', flag: '-c' }
  return { cmd: windowsBashPath() ?? 'bash', flag: '-c' }
}

/**
 * The shell for running a whole command line (build, tests, install, a dev server) —
 * what `run_command`/`run_dev_server` use. On Unix, `bash -c`. On Windows we now
 * PREFER the discovered Git Bash so the agent gets a genuine full shell — pipes,
 * globs, `&&`, and unix tools (grep/sed/cat/ls) all work, and `npm`/`node`/`git`/
 * `python` still resolve because Git Bash inherits the Windows PATH. Only when no
 * bash is installed do we fall back to cmd.exe (always present via ComSpec) so
 * `npm …` still spawns. Never returns null — every supported OS has one of these.
 */
export function resolveShell(): InterpreterSpec {
  if (process.platform !== 'win32') return { cmd: 'bash', flag: '-c' }
  const bash = windowsBashPath()
  return bash ? { cmd: bash, flag: '-c' } : { cmd: process.env.ComSpec || 'cmd.exe', flag: '/c' }
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
  signal: AbortSignal,
  cwd?: string,
  timeoutMs: number = RUN_TIMEOUT_MS
): Promise<RunResult> {
  return executeArgv(spec.cmd, [spec.flag, code], signal, {
    // The JS path runs the bundled Node via ELECTRON_RUN_AS_NODE; everything else
    // inherits the normal environment.
    env: spec.electronNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    cwd,
    timeoutMs
  })
}

/**
 * Spawn an executable with an explicit argument VECTOR (no shell) and capture its
 * output under the same timeout + size-cap discipline as {@link executeCode}. This
 * is what tools that build their own command from structured input use — the git
 * tools especially: passing argv directly means a commit message or a path with
 * spaces, quotes, or shell metacharacters can never be re-interpreted by a shell,
 * so there is nothing to escape and nothing to inject. {@link executeCode} is now a
 * thin wrapper over this that runs a shell/interpreter with a single code string.
 */
export async function executeArgv(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS
  return new Promise<RunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      // In Cowork the command runs inside the working folder, so files it writes
      // (or the repo it acts on) resolve there via a relative path.
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      windowsHide: true
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

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
export function formatRunResult(
  language: string,
  r: RunResult,
  timeoutMs: number = RUN_TIMEOUT_MS
): string {
  if (r.spawnError) {
    return `Could not run ${language}: ${r.spawnError}. Is the interpreter installed and on PATH?`
  }
  const parts: string[] = []
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trimEnd()}`)
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trimEnd()}`)
  if (r.timedOut) parts.push(`(killed after ${timeoutMs / 1000}s timeout)`)
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
  sideEffect: 'exec',
  // Available when the user opted into code execution, OR in an agentic mode (Cowork /
  // Research) — where running code is how the agent produces generated artifacts (a PDF,
  // an image) and the permission system (approvals.ts) gates each run rather than a toggle.
  available: (gate) =>
    gate.settings.tools.codeExecution || gate.mode === 'cowork' || gate.mode === 'research',
  async run(input, ctx) {
    // Belt-and-braces: allowed when the toggle is on or we're in an agentic mode; never
    // trust that a call couldn't arrive anyway (stale prompt, replayed turn).
    const agenticMode = ctx.mode === 'cowork' || ctx.mode === 'research'
    if (!ctx.settings.tools.codeExecution && !agenticMode) {
      return 'run_code is disabled. The user can turn it on in Settings › Tools › “Run code on this machine”, or use Cowork/Research mode.'
    }
    const { language, code } = readCodeInput(input)
    if (!language || !code) {
      return 'run_code needs a JSON input like {"language": "python", "code": "…"}.'
    }
    const spec = resolveInterpreter(language)
    if (!spec) return `run_code does not support "${language}". Use python, javascript, or bash.`
    // In an agentic mode, run inside the working folder so generated files land there,
    // and give the snippet a longer ceiling — it's producing real deliverables.
    const inCowork = agenticMode
    const cwd = inCowork && ctx.workspaceDir ? ctx.workspaceDir : undefined
    const timeoutMs = inCowork ? COWORK_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS
    return formatRunResult(language, await executeCode(spec, code, ctx.signal, cwd, timeoutMs), timeoutMs)
  }
}
