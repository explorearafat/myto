import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveShell } from './runCode'
import { fsAvailable } from './fs'
import type { PreviewTarget } from '../../shared/types'
import type { ToolContext, ToolDef } from './registry'

/**
 * `run_dev_server` — start a project's dev server (or any long-running server
 * command) in the BACKGROUND and auto-open its localhost URL in the preview pane.
 *
 * Why this is separate from run_command/run_code: those run a command to completion
 * under a kill-timeout and hand the output back. A dev server never "completes" — it
 * stays up serving — so under those tools it would be killed by the timeout or hang
 * the agent loop. This tool instead:
 *   - spawns through the full shell (resolveShell: Git Bash where installed on
 *     Windows, else cmd.exe; bash on Unix) so `npm run dev` resolves as in a real
 *     terminal — the old resolveInterpreter('bash') path failed to even spawn on a
 *     typical Windows box;
 *   - never sets a kill-timer and is NOT killed when the turn ends, so the server
 *     (and its preview) stays live while Myto keeps working;
 *   - streams stdout/stderr to the Terminal pane under a STABLE id (one row per
 *     folder, updated in place) so the user watches it boot;
 *   - watches the output for a localhost URL, opens it in the preview pane, and only
 *     then resolves to the model — or after a grace period, or if the process exits
 *     early — so a server slow to print its URL still works.
 *
 * Lifetime: one server per working folder. Starting again in the same folder kills
 * the previous one (a restart), and survivors are killed on app quit. It is a
 * side-effecting exec tool, so the Cowork permission tier gates it like run_command.
 */

/** How long to wait for a URL (or early exit) before returning to the model anyway. */
const URL_GRACE_MS = 25_000
/** Keep the streamed transcript bounded (characters); we keep the newest output. */
const OUTPUT_CAP = 12_000
/** Min interval between Terminal-pane updates while output streams in. */
const EMIT_THROTTLE_MS = 150

/** A dev server we launched and are keeping alive, keyed by working folder. */
interface RunningServer {
  child: ChildProcess
  command: string
  cwd: string
  id: string
  /** The localhost URL it printed once detected, so the loop can preview/screenshot it later. */
  url?: string
}

/** Live servers by absolute cwd — at most one per folder. */
const servers = new Map<string, RunningServer>()

/**
 * The localhost URL of a dev server still running for `cwd`, or null. Lets the build-complete
 * visual review (provider-ipc) screenshot a server the run left up without re-parsing output or
 * reaching into this module's internals. Normalises the folder the same way `startDevServer`
 * keys it (`resolve`) so a caller passing the raw workspaceDir still matches.
 */
export function runningServerUrl(cwd: string): string | null {
  const s = servers.get(resolve(cwd))
  return s?.url?.trim() ? s.url.trim() : null
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

/**
 * Find the first localhost/loopback http(s) URL in dev-server output, normalised so
 * the preview pane can load it: strips ANSI colour (Vite even colours the port),
 * maps 0.0.0.0 / 127.0.0.1 / ::1 to `localhost`, and keeps the scheme, port and
 * path. Returns null when no local URL has been printed yet. Pure — unit-tested.
 */
export function detectUrl(text: string): string | null {
  const clean = text.replace(ANSI, '')
  const re = /(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d+))?(\/[^\s"'`<>)]*)?/gi
  for (const m of clean.matchAll(re)) {
    const host = m[2].toLowerCase()
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host === '[::]'
    if (!isLocal) continue
    const scheme = m[1].toLowerCase()
    const port = m[3] ? `:${m[3]}` : ''
    const path = m[4] || '/'
    return `${scheme}://localhost${port}${path}`
  }
  return null
}

/** Kill a server best-effort, tree-killing on Windows where child procs detach. */
function killServer(s: RunningServer): void {
  try {
    if (process.platform === 'win32' && s.child.pid) {
      spawn('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      s.child.kill('SIGTERM')
    }
  } catch {
    /* already gone — nothing to do */
  }
}

let quitHookInstalled = false
/** Kill any surviving dev servers when the app quits (best-effort; no-op under tests). */
function installQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  import('electron')
    .then((electron) => {
      electron.app?.on?.('before-quit', () => {
        for (const s of servers.values()) killServer(s)
        servers.clear()
      })
    })
    .catch(() => {
      /* no electron app (unit tests) — restart-kill still bounds server count */
    })
}

/** Read an explicit `command` string out of the tool input, or null. */
function readCommand(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** Fall back to the project's own dev/start/serve script when no command was given. */
async function defaultDevCommand(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    for (const name of ['dev', 'start', 'serve', 'preview']) {
      if (typeof scripts[name] === 'string' && scripts[name].trim()) return `npm run ${name}`
    }
  } catch {
    /* no/invalid package.json — caller asks the model for a command */
  }
  return null
}

/** Spawn the command, stream it to the Terminal, preview its URL, resolve to the model. */
function startDevServer(command: string, cwd: string, ctx: ToolContext): Promise<string> {
  installQuitHook()
  // A restart in the same folder replaces the previous server.
  const prev = servers.get(cwd)
  if (prev) {
    killServer(prev)
    servers.delete(cwd)
  }

  const spec = resolveShell()
  const id = `dev-server:${cwd}`
  let output = ''
  let previewed = false
  let settled = false
  let lastEmit = 0

  const emit = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmit < EMIT_THROTTLE_MS) return
    lastEmit = now
    ctx.onCommand?.({ id, command, output: output || '(starting…)', exitCode: null, cwd })
  }

  const child = spawn(spec.cmd, [spec.flag, command], { cwd, env: process.env, windowsHide: true })
  const server: RunningServer = { child, command, cwd, id }
  servers.set(cwd, server)
  emit(true) // show the row the instant it launches

  return new Promise<string>((resolveP) => {
    const finish = (msg: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveP(msg)
    }

    // No URL after a grace period: return anyway (the server stays up in the
    // background) so the loop is never blocked by a slow-to-boot server.
    // `finish` closes over `timer` but only ever runs after this assignment.
    const timer = setTimeout(() => {
      emit(true)
      finish(
        `Started "${command}" in the background — it's running but hasn't printed a local URL in ${URL_GRACE_MS / 1000}s. Its output is streaming to the Terminal pane; if it needs longer, check there, or preview its URL once you know the port.`
      )
    }, URL_GRACE_MS)

    // A real user Stop: stop WAITING, but leave the server (and its preview) running —
    // cleaned up on app quit or the next restart. Per-turn aborts never reach here (the
    // loop passes the outer user-cancel signal, not the per-turn one). The listener is
    // once-only and finish() is idempotent, so no explicit removal is needed.
    const onAbort = (): void => finish('Left the dev server running in the background.')
    if (ctx.signal.aborted) onAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })

    const onData = (d: Buffer): void => {
      output += d.toString()
      if (output.length > OUTPUT_CAP) output = output.slice(output.length - OUTPUT_CAP)
      emit()
      if (previewed) return
      const url = detectUrl(output)
      if (!url) return
      previewed = true
      server.url = url // remember it so the build-complete review can screenshot it later
      emit(true)
      const target: PreviewTarget = { kind: 'url', url, title: url }
      ctx.onPreview?.(target)
      finish(
        `Started "${command}" — it's serving at ${url}, now open in the preview pane. The server keeps running in the background and its output streams to the Terminal pane.`
      )
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    // Spawn failure (e.g. the shell or npm isn't found): drop the row and report it —
    // don't leave a dead server registered.
    child.on('error', (err) => {
      if (servers.get(cwd) === server) servers.delete(cwd)
      output += `\n[failed to start: ${err.message}]`
      emit(true)
      finish(
        `Could not start "${command}": ${err.message}. Check the command is right and its dependencies are installed (e.g. run "npm install" first).`
      )
    })

    // Early exit before any URL: a build error or a one-shot command mistaken for a
    // server. Record the final exit code on the Terminal row and tell the model why.
    child.on('close', (code) => {
      if (servers.get(cwd) === server) servers.delete(cwd)
      output += `\n[process exited with code ${code ?? 'n/a'}]`
      ctx.onCommand?.({ id, command, output, exitCode: code, cwd })
      finish(
        code === 0
          ? `"${command}" exited cleanly (code 0) without starting a lasting server — if it was meant to keep serving, check the Terminal output for why it stopped.`
          : `"${command}" exited with code ${code ?? 'n/a'} before it served anything. Read its output in the Terminal pane and fix the cause, then try again.`
      )
    })
  })
}

export const runDevServerTool: ToolDef = {
  name: 'run_dev_server',
  description:
    "Start a project's dev server (or any long-running server command) in the background and auto-open its localhost URL in the preview pane. Use this — NOT run_code or run_command — to run any server (React/Vite/Next, Node, Python http.server, etc.): it never blocks the turn and isn't killed when the turn ends. Omit \"command\" to use the project's own dev/start/serve script from package.json.",
  usage: '{"command": "npm run dev"}',
  sideEffect: 'exec',
  available: fsAvailable,
  async run(input, ctx) {
    const cwd = ctx.workspaceDir ? resolve(ctx.workspaceDir) : null
    if (!cwd) return 'run_dev_server: no working folder is set.'
    const explicit = readCommand(input)
    const command = explicit ?? (await defaultDevCommand(cwd))
    if (!command) {
      return 'run_dev_server needs a "command" (e.g. {"command": "npm run dev"}). No dev/start/serve/preview script was found in package.json to fall back to.'
    }
    return startDevServer(command, cwd, ctx)
  }
}

