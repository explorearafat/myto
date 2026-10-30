/**
 * The call system's command execution service.
 *
 * Everything the phone asks the PC to DO runs through here — either directly
 * (the user says "check my current directory") or as part of an agent task.
 * It is deliberately the ONLY exec path reachable from a call:
 *
 *  - PowerShell 7 (`pwsh`) when installed, Windows PowerShell fallback;
 *  - commands run in the Cowork workspace directory (the existing project
 *    workspace config is preserved — nothing executes from a network-owned cwd);
 *  - stdout/stderr captured separately, streamed live to the phone;
 *  - PIDs tracked, long-running processes supported, trees killable, timeouts
 *    enforced;
 *  - every execution is classified into a permission tier BEFORE it runs
 *    (read-only / dev / destructive / elevated) and audited to sqlite after.
 *
 * The CLASSIFIER decides what a command IS; the SESSION decides who must
 * approve it. Unauthenticated network messages can never reach this module —
 * callers arrive only through the authenticated, user-initiated call session.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { insertCallAudit } from './db'

/** Permission tier of a command, decided by {@link classifyCommand}. */
export type CommandTier = 'read_only' | 'dev' | 'destructive' | 'elevated'

const ELEVATED_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\brunas\b/i,
  /start-process\b[^\n]*-verb\s+runas/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\breg\s+(add|delete|import)\b/i,
  /\bset-executionpolicy\b/i,
  /\binstall-module\b/i,
  /\b(format|diskpart|bcdedit|shutdown|restart-computer|stop-computer)\b/i,
  /\bnpm\s+(install|i|add)\b[^|\n;&]*\s(-g|--global)\b/i,
  /\bpip\s+install\b[^|\n;&]*--user\b/i
]

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bremove-item\b/i,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i,
  /\brm\s+-r/i,
  /\brmdir\b/i,
  /\b(rd|del|erase)\s+\/[sq]/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b[^|\n;&]*(--force|-f)\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+checkout\s+--\s+\.[\s]*$/i,
  /\btruncate|wipedisk\b/i
]

/** Access to credentials/secrets is sensitive even when the command looks benign.
 *  The boundary is "not a letter/digit" (underscore allowed as the preceding
 *  char) so `$env:MYTO_API_KEY` and snake_case names still match — \b fails
 *  before `_`, which is a word character. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /(^|[^a-z0-9])get-credential/i,
  /(^|[^a-z0-9])cmdkey/i,
  /(^|[^a-z0-9])(credential|password|passphrase)/i,
  /(^|[^a-z0-9])(api[_-]?key|apikey|secret[_-]?key|secret[_-]?token|access[_-]?token)/i
]

const READONLY_PATTERNS: RegExp[] = [
  /^(get-|test-|measure-|select-|compare-|resolve-|read-|find-|search-|out-|sort-|where-object|foreach-object|format-list|format-table)/i,
  /^(ls|dir|pwd|cat|type|head|tail|wc|echo|write-host|whoami|hostname|which|where)\b/i,
  /^git\s+(status|log|diff|show|branch$|remote|tag$|blame|describe|rev-parse)\b/i,
  /^(node|python|pip|npm|npx|tsc|flutter|dotnet|go|cargo|java|mvn|gradle|pwsh)\s+(-v|-V|--version|version)\b/i,
  /^npm\s+(ls|list|outdated|view|run\s+list|config\s+get)\b/i,
  /^flutter\s+(devices|doctor|--version)\b/i,
  /\bselect-string\b/i,
  /\bfindstr\b/i,
  /\btest-path\b/i
]

const DEV_PATTERNS: RegExp[] = [
  /^(npm|pnpm|yarn|npx|node|tsc|vite|eslint|prettier|jest|vitest|mocha)\b/i,
  /^(git\s+(add|commit|push|pull|fetch|checkout|merge|rebase|stash|restore|switch|init|clone))\b/i,
  /^(python|pip|pytest|python3)\b/i,
  /^(flutter|dart|dotnet|cargo|go|maven|gradle|mvn)\b/i,
  /^(start|invoke-item)\b/i, // "open PowerShell" / "open VS Code"
  /^(code|explorer|wt|cmd|start-process)\b/i,
  /^(mkdir|new-item|copy-item|move-item|set-content|add-content)\b/i
]

/**
 * Classify a command string into its permission tier. Order matters: elevation
 * and destructiveness win over everything; credential keywords escalate; known
 * read-only shapes are recognized; everything else is treated as dev (a write
 * or a program run) — never silently as read-only. Exported for unit tests.
 */
export function classifyCommand(command: string): CommandTier {
  const cmd = command.trim()
  if (ELEVATED_PATTERNS.some((re) => re.test(cmd))) return 'elevated'
  if (DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))) return 'destructive'
  if (CREDENTIAL_PATTERNS.some((re) => re.test(cmd))) return 'destructive'
  if (READONLY_PATTERNS.some((re) => re.test(cmd))) return 'read_only'
  if (DEV_PATTERNS.some((re) => re.test(cmd))) return 'dev'
  return 'dev'
}

/** Does this tier need an explicit approval under the given call permission mode? */
export function needsApproval(tier: CommandTier, mode: 'ask' | 'autoReadOnly' | 'autoDev'): boolean {
  if (tier === 'elevated' || tier === 'destructive') return true // NEVER auto-run these
  if (tier === 'dev') return mode === 'ask'
  return false // read-only always flows
}

/**
 * Resolve pwsh 7 once per run; Windows PowerShell is the fallback. `spawn` on
 * Windows does NOT throw for a missing binary — it emits an async 'error' — so
 * the probe is promise-shaped and the first real command may race it.
 */
let pwshProbe: Promise<string> | null = null
function resolveShell(): Promise<string> {
  if (!pwshProbe) {
    pwshProbe = new Promise<string>((resolve) => {
      try {
        const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
          stdio: 'ignore',
          windowsHide: true
        })
        const bail = setTimeout(() => {
          try {
            p.kill()
          } catch {
            /* already gone */
          }
        }, 8_000)
        p.on('error', () => {
          clearTimeout(bail)
          resolve('powershell')
        })
        p.on('close', () => {
          clearTimeout(bail)
          resolve('pwsh')
        })
      } catch {
        resolve('powershell')
      }
    })
  }
  return pwshProbe
}

export interface ExecResult {
  exitCode: number | null
  cancelled: boolean
  timedOut: boolean
  output: { out: string; err: string }
}

export interface ExecHandle {
  pid: number | null
  cancel: () => void
  done: Promise<ExecResult>
}

export interface ExecRequest {
  callId: string
  taskId?: string
  command: string
  cwd: string
  /** Who approved (audit trail): 'auto' | 'voice' | 'phone' | 'desktop'. */
  approvedBy: string
  tier: CommandTier
  /** No timeout — dev servers and watchers. Killable via the returned handle. */
  longRunning?: boolean
  timeoutMs?: number
  onLog?: (stream: 'out' | 'err', text: string) => void
}

const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_CAP = 200_000 // per stream, char cap — keep memory sane on chatty builds

interface Running {
  child: ChildProcess
  output: { out: string; err: string }
  cancelled: boolean
  timedOut: boolean
  settled: boolean
  timer: NodeJS.Timeout | null
}

function spawnShell(shell: string, req: ExecRequest): ChildProcess {
  return spawn(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', req.command],
    { cwd: req.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function finish(run: Running, req: ExecRequest, code: number | null, outcome: string): ExecResult {
  if (run.settled) {
    return { exitCode: code, cancelled: run.cancelled, timedOut: run.timedOut, output: run.output }
  }
  run.settled = true
  if (run.timer) clearTimeout(run.timer)
  const result: ExecResult = {
    exitCode: code,
    cancelled: run.cancelled,
    timedOut: run.timedOut,
    output: run.output
  }
  // The audit trail is best-effort: a DB hiccup must never lose the execution
  // result (this runs inside the close handler — a throw here would wedge the
  // awaiting caller forever).
  try {
    insertCallAudit({
      callId: req.callId,
      taskId: req.taskId ?? null,
      command: req.command,
      tier: req.tier,
      approvedBy: req.approvedBy,
      exitCode: code,
      outcome: run.timedOut ? 'timeout' : run.cancelled ? 'cancelled' : outcome
    })
  } catch (error) {
    console.error('[call] audit write failed:', error)
  }
  return result
}

/**
 * Run one PowerShell command (pwsh 7 preferred, Windows PowerShell fallback).
 * Streams stdout/stderr separately as they arrive; resolves when the process
 * exits (or is killed by timeout/cancel). Long-running commands return a handle
 * immediately and keep streaming until killed.
 */
export async function executeCommand(req: ExecRequest): Promise<ExecHandle> {
  let shell = await resolveShell()
  let child: ChildProcess
  let retried = false
  try {
    child = spawnShell(shell, req)
  } catch (error) {
    insertCallAudit({
      callId: req.callId,
      taskId: req.taskId ?? null,
      command: req.command,
      tier: req.tier,
      approvedBy: req.approvedBy,
      exitCode: null,
      outcome: `spawn-failed: ${String(error)}`
    })
    return {
      pid: null,
      cancel: () => undefined,
      done: Promise.resolve({
        exitCode: null,
        cancelled: false,
        timedOut: false,
        output: { out: '', err: `spawn failed: ${String(error)}` }
      })
    }
  }

  const run: Running = {
    child,
    output: { out: '', err: '' },
    cancelled: false,
    timedOut: false,
    settled: false,
    timer: null
  }

  const collect = (stream: 'out' | 'err') => (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    if (run.output[stream].length < OUTPUT_CAP) run.output[stream] += text
    req.onLog?.(stream, text)
  }
  child.stdout?.on('data', collect('out'))
  child.stderr?.on('data', collect('err'))

  if (!req.longRunning) {
    run.timer = setTimeout(() => {
      run.timedOut = true
      killTree(child.pid)
    }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  const done = new Promise<ExecResult>((resolve) => {
    // A missing shell binary surfaces here (async on Windows). Retry ONCE with
    // the other PowerShell so a pwsh-less machine still executes the command.
    child.on('error', (error) => {
      if (shell === 'pwsh' && !retried && !run.settled) {
        retried = true
        shell = 'powershell'
        const retry = spawnShell(shell, req)
        retry.stdout?.on('data', collect('out'))
        retry.stderr?.on('data', collect('err'))
        if (!req.longRunning && run.timer) {
          run.timer.refresh()
        }
        retry.on('error', (err2) => {
          run.output.err += `\n${String(err2)}`
          resolve(finish(run, req, null, 'error'))
        })
        retry.on('close', (code, signal) => {
          run.child = retry
          resolve(finish(run, req, code, signal ? 'signalled' : 'done'))
        })
        run.child = retry
        return
      }
      run.output.err += `\n${String(error)}`
      resolve(finish(run, req, null, 'error'))
    })
    child.on('close', (code, signal) => {
      if (retried) return // the retry child owns the terminal event
      resolve(finish(run, req, code, signal ? 'signalled' : 'done'))
    })
  })

  return {
    pid: child.pid ?? null,
    cancel: () => {
      run.cancelled = true
      killTree(run.child.pid)
    },
    done
  }
}

/** Kill a process AND its tree (node's kill() alone orphans child grandchildren). */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** The effective working directory for call commands (falls back to the user's home). */
export function resolveCallCwd(workspaceDir: string, fallback: string): string {
  return workspaceDir.trim() !== '' ? workspaceDir : fallback
}
