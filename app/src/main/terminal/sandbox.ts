/**
 * OS-level sandbox for shell commands (Principle 7 #3).
 *
 * Wraps {@link spawnCommandPty} so the child process runs confined by the OS — the
 * layer beneath the permission prompt. Its job is to make the audit's finding false
 * *by construction*: even a wrongly-approved `rm -rf ~` must not escape the project
 * root. The sandbox is ADDED, never removed — `autonomous`/`bypassPermissions`/
 * full-access waive *prompts*, not *confinement*.
 *
 * Two sandbox modes, tracking the permission mode:
 *  - `read-only` (plan mode): filesystem is read-only everywhere, network denied.
 *  - `workspace-write` (every other mode): reads allowed broadly (commands need to
 *    read system libraries, configs, node itself), writes confined to the workspace
 *    (+ the OS temp dir and `/dev/null`), network allowed (so `npm install`, `git
 *    push`, `curl` still work — the core protection is the *write* boundary, not an
 *    egress block; outbound-network risk is gated at the tool layer by the browse and
 *    web_fetch permissions).
 *
 * Per-platform mechanism (matching the proven references — Codex/Claude Code):
 *  - **macOS:** `sandbox-exec` (Seatbelt) with a generated profile. Real confinement.
 *  - **Linux:** `bwrap` (bubblewrap) when present. Real confinement.
 *  - **Windows (primary platform):** robust confinement needs an AppContainer / restricted
 *    token, which a vanilla-Node spawn cannot set up — it needs a small native helper
 *    binary (`sylor-confine.exe`) bundled with the app. The integration seam for that
 *    helper is wired and unit-tested here ({@link buildWindowsConfineArgv} + the win32
 *    branch of {@link spawnSandboxedCommand}), but the helper binary itself is not yet
 *    built, so {@link sandboxAvailable} finds nothing and the branch takes the design's
 *    documented **fail-safe fallback**: the command still runs, confinement resting on
 *    the command classifier + approval prompts (destructive always asks, even hands-free),
 *    NOT on the OS. {@link sandboxAvailable} stays `false` until the helper ships, so the
 *    UI says so honestly — we never claim a sandbox we don't have. See the design proposal
 *    (Principle 7 · Windows confinement spike) for the helper CLI contract.
 *
 * The profile/argv builders are pure and unit-tested; the spawn functions compose them
 * with {@link spawnCommandPty} (which sets `cwd` to the project root and inherits env).
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { spawnCommandPty } from './pty'
import type { PermissionMode } from '../../shared/types'

/** How tightly the child is confined. Derived from the run's {@link PermissionMode}. */
export type SandboxMode = 'read-only' | 'workspace-write'

/**
 * Maps a permission mode to its sandbox mode. `plan` is read-only exploration, so it
 * gets a read-only filesystem and no network; every other mode may write, so it gets
 * workspace-write. Full access / autonomous do NOT widen this — confinement is not a
 * prompt, so it is never waived.
 */
export function sandboxModeFor(mode: PermissionMode): SandboxMode {
  return mode === 'plan' ? 'read-only' : 'workspace-write'
}

/**
 * Spawns a command pty confined to {@link workspaceRoot} by the OS where available,
 * else (Windows, today) falls back to an unsandboxed spawn — the caller's classifier
 * + prompts are the fail-safe. Returns the raw {@link IPty} for the caller to wire to
 * its output handler, exactly like {@link spawnCommandPty}.
 */
export function spawnSandboxedCommand(
  command: string,
  workspaceRoot: string,
  mode: PermissionMode,
  cols = 120,
  rows = 30,
  extraEnv?: Record<string, string | undefined>
): IPty {
  const sandboxMode = sandboxModeFor(mode)
  switch (process.platform) {
    case 'darwin':
      return spawnMacOSSandboxed(command, workspaceRoot, sandboxMode, cols, rows, extraEnv)
    case 'linux':
      return spawnLinuxSandboxed(command, workspaceRoot, sandboxMode, cols, rows, extraEnv)
    case 'win32':
      return spawnWindowsSandboxed(command, workspaceRoot, sandboxMode, cols, rows, extraEnv)
    default:
      // Any other platform: no OS confinement available.
      // Fail-safe: run with classifier + prompt gating only, and say so once.
      warnUnsandboxed(command, sandboxMode, workspaceRoot)
      return spawnCommandPty(command, cols, rows, extraEnv)
  }
}

/**
 * Builds a Seatbelt (macOS `sandbox-exec`) profile. Read is allowed broadly — a real
 * command reads dylibs, `/etc`, node's own files, and denying that breaks everything —
 * while WRITE is denied by default and re-allowed only under the workspace (plus the OS
 * temp dir and `/dev/null`, which builds and tools legitimately need). Network is denied
 * in read-only mode and allowed in workspace-write. Pure: returned string is testable.
 */
export function buildSeatbeltProfile(workspaceRoot: string, mode: SandboxMode): string {
  const esc = (p: string): string => p.replace(/"/g, '\\"')
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target self))',
    // Reading is unrestricted — the write boundary is what confines side effects.
    '(allow file-read*)'
  ]
  if (mode === 'workspace-write') {
    lines.push(
      '(allow file-write*',
      `  (subpath "${esc(workspaceRoot)}")`,
      '  (subpath "/tmp")',
      '  (subpath "/private/tmp")',
      '  (subpath "/private/var/folders")',
      '  (literal "/dev/null")',
      '  (literal "/dev/stdout")',
      '  (literal "/dev/stderr"))',
      '(allow network*)'
    )
  } else {
    lines.push('(deny file-write*)', '(deny network*)')
  }
  return lines.join('\n') + '\n'
}

/**
 * Builds the `bwrap` (bubblewrap, Linux) argument vector. The whole filesystem is bound
 * read-only so commands can read libraries/configs, then the workspace is re-bound
 * read-write (workspace-write mode only). `--dev`/`--proc`/`--tmpfs /tmp` give a minimal
 * usable environment; read-only mode also `--unshare-net` (no network). Pure: the argv
 * is testable without spawning.
 */
export function buildBwrapArgv(workspaceRoot: string, mode: SandboxMode, command: string): string[] {
  const argv = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--die-with-parent'
  ]
  if (mode === 'workspace-write') {
    // Re-bind the workspace read-write on top of the read-only root.
    argv.push('--bind', workspaceRoot, workspaceRoot)
  } else {
    // Read-only exploration: no network either.
    argv.push('--unshare-net')
  }
  argv.push('sh', '-c', command)
  return argv
}

/**
 * Builds the argument vector for the Windows confinement helper (`sylor-confine.exe`).
 * The helper takes the workspace root + sandbox mode and the command to run, sets up the
 * AppContainer / restricted-token confinement natively, then executes the command inside
 * it. The command is passed base64-encoded (`--command-b64`) precisely so that NO shell or
 * PowerShell quoting of the *inner* command is ever required — the base64 alphabet is
 * entirely shell-safe, sidestepping the nested-quoting hazard the POSIX spawners handle
 * with {@link singleQuote}. Pure: the argv is testable without the helper existing or
 * spawning anything.
 *
 * Helper CLI contract (for the native implementation, once built):
 *   sylor-confine.exe --workspace <dir> --mode <read-only|workspace-write> --command-b64 <b64>
 */
export function buildWindowsConfineArgv(
  helperPath: string,
  workspaceRoot: string,
  mode: SandboxMode,
  command: string
): string[] {
  return [
    helperPath,
    '--workspace',
    workspaceRoot,
    '--mode',
    mode,
    '--command-b64',
    Buffer.from(command, 'utf8').toString('base64')
  ]
}

/**
 * Whether OS-level sandboxing is actually enforced on this platform. The UI reads this
 * to tell the user honestly when confinement rests on classification + prompts (Windows,
 * today) rather than the OS. macOS always has `sandbox-exec`; Linux needs `bwrap`.
 */
export function sandboxAvailable(): boolean {
  if (process.platform === 'darwin') return true
  if (process.platform === 'linux') return bwrapAvailable()
  // Windows enforces only once the native confinement helper is bundled; until then the
  // probe finds nothing and we report false rather than claim a sandbox we don't have.
  if (process.platform === 'win32') return windowsConfineHelperPath() !== undefined
  return false
}

// ── platform spawners ───────────────────────────────────────────────────────────────

function spawnMacOSSandboxed(
  command: string,
  workspaceRoot: string,
  mode: SandboxMode,
  cols: number,
  rows: number,
  extraEnv?: Record<string, string | undefined>
): IPty {
  const profile = buildSeatbeltProfile(workspaceRoot, mode)
  // sandbox-exec -p '<profile>' sh -c '<command>'. Both the profile and the command are
  // single-quoted; embedded single quotes are escaped the POSIX way ('\'').
  const wrapped = `sandbox-exec -p ${singleQuote(profile)} sh -c ${singleQuote(command)}`
  return spawnCommandPty(wrapped, cols, rows, extraEnv)
}

function spawnLinuxSandboxed(
  command: string,
  workspaceRoot: string,
  mode: SandboxMode,
  cols: number,
  rows: number,
  extraEnv?: Record<string, string | undefined>
): IPty {
  if (!bwrapAvailable()) {
    warnUnsandboxed(command, mode, workspaceRoot)
    return spawnCommandPty(command, cols, rows, extraEnv)
  }
  const argv = buildBwrapArgv(workspaceRoot, mode, command)
  const wrapped = `bwrap ${argv.map(singleQuote).join(' ')}`
  return spawnCommandPty(wrapped, cols, rows, extraEnv)
}

function spawnWindowsSandboxed(
  command: string,
  workspaceRoot: string,
  mode: SandboxMode,
  cols: number,
  rows: number,
  extraEnv?: Record<string, string | undefined>
): IPty {
  const helperPath = windowsConfineHelperPath()
  if (!helperPath) {
    // Helper not bundled yet → honest fail-safe (classifier + prompts, no OS confinement).
    warnUnsandboxed(command, mode, workspaceRoot)
    return spawnCommandPty(command, cols, rows, extraEnv)
  }
  // The win32 pty runs `powershell.exe -Command <command>`, so invoke the helper as a
  // PowerShell call (`& '<exe>' '<arg>' ...`). Only the paths need quoting; the inner
  // command rides along as base64 in the argv, so there is no nested-quoting hazard.
  const argv = buildWindowsConfineArgv(helperPath, workspaceRoot, mode, command)
  const wrapped = powershellCall(argv)
  return spawnCommandPty(wrapped, cols, rows, extraEnv)
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

/** POSIX single-quote a string for safe interpolation into a `sh -c` command line. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * PowerShell single-quote (literal string, no variable/backtick expansion); an embedded
 * single quote is doubled per PowerShell's rules. Used to quote the helper path + its
 * fixed args when composing the `& '<exe>' ...` call line for the win32 pty.
 */
function powershellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Compose a PowerShell call line for the confinement helper: `& 'exe' 'arg' 'arg' …`. */
function powershellCall(argv: string[]): string {
  const [exe, ...rest] = argv
  return ['&', powershellSingleQuote(exe), ...rest.map(powershellSingleQuote)].join(' ')
}

/** Cached bwrap probe — `execFileSync` per command would be wasteful. */
let bwrapProbe: boolean | undefined
/**
 * The actual "is bwrap installed" check. Injectable ({@link __setBwrapProbe}) so tests
 * can drive both branches without shelling out or mocking `node:child_process` — the
 * builtin's binding inside this module is not reliably reachable by a module mock.
 */
let bwrapProbeFn: () => boolean = defaultBwrapProbe
function defaultBwrapProbe(): boolean {
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function bwrapAvailable(): boolean {
  if (bwrapProbe === undefined) bwrapProbe = bwrapProbeFn()
  return bwrapProbe
}

/**
 * Cached Windows confinement-helper path. `undefined` = not yet probed, `null` = probed
 * and absent, a string = the resolved helper path. The helper is bundled by
 * electron-builder (extraResources) next to {@link process.resourcesPath}, or built
 * locally under `./resources` in dev. It does not exist yet, so this resolves to `null`
 * today and {@link sandboxAvailable} stays honest.
 */
let windowsHelperPath: string | null | undefined
/** Injectable ({@link __setWindowsHelperProbe}) for the same reason as the bwrap probe. */
let windowsHelperProbeFn: () => string | undefined = defaultWindowsHelperProbe
function defaultWindowsHelperProbe(): string | undefined {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'sylor-confine.exe'))
  candidates.push(join(process.cwd(), 'resources', 'sylor-confine.exe'))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate → treat as absent and keep looking.
    }
  }
  return undefined
}
function windowsConfineHelperPath(): string | undefined {
  if (windowsHelperPath === undefined) windowsHelperPath = windowsHelperProbeFn() ?? null
  return windowsHelperPath ?? undefined
}

/** So a killed/absent sandbox is surfaced once, not silently — honesty over a false claim. */
let warnedUnsandboxed = false
function warnUnsandboxed(command: string, mode: SandboxMode, workspaceRoot: string): void {
  if (warnedUnsandboxed) return
  warnedUnsandboxed = true
  console.warn(
    '[sylor] OS-level command sandbox is not enforced on this platform; ' +
      'commands run with classifier + approval gating only (destructive always asks). ' +
      'See design-proposal.md Principle 7 (Windows native-confinement spike).',
    { mode, workspaceRoot, example: command }
  )
}

/**
 * Test-only: override the bwrap probe (and clear its memo) so a suite can drive both
 * the "bwrap present" and "bwrap absent" branches deterministically, without shelling
 * out or depending on a `node:child_process` module mock reaching this module.
 */
export function __setBwrapProbe(fn: () => boolean): void {
  bwrapProbeFn = fn
  bwrapProbe = undefined
}

/**
 * Test-only: override the Windows confinement-helper probe (and clear its memo) so a suite
 * can drive both the "helper bundled" and "helper absent" branches without a real binary.
 */
export function __setWindowsHelperProbe(fn: () => string | undefined): void {
  windowsHelperProbeFn = fn
  windowsHelperPath = undefined
}

/** Test-only: reset the memoized probes AND restore the real bwrap / helper checks. */
export function __resetSandboxProbes(): void {
  bwrapProbe = undefined
  bwrapProbeFn = defaultBwrapProbe
  windowsHelperPath = undefined
  windowsHelperProbeFn = defaultWindowsHelperProbe
  warnedUnsandboxed = false
}
