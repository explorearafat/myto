/**
 * Track 2 (browser automation) — the REAL transports behind ./cowork-browser-cdp. This
 * is the GUI/OS-facing half: it either opens an in-app Electron BrowserWindow and drives
 * it through `webContents.debugger`, or launches the user's own Chrome with a remote-
 * debugging port and drives it over a WebSocket. Neither path can run headless, so —
 * unlike the pure core and the CDP orchestration — this module has NO unit tests; it is
 * exercised only in a packaged app. Keep it thin: all page logic lives in BrowserSession.
 *
 * ⚠️ Unverified here: this is only typechecked. The debugger attach, the Chrome spawn,
 * the /json discovery and the global WebSocket are all runtime behaviours to confirm in
 * a real build.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session as electronSession } from 'electron'
import type { BrowserTarget } from '../shared/types'
import { BrowserSession, type CdpTransport } from './cowork-browser-cdp'
import { chromeCandidates, chromeUserAgent, resolveBrowserTarget } from './cowork-browser'

/** A live browser for one Cowork run: the session the tools use + a disposer for teardown. */
export interface BrowserController {
  session: BrowserSession
  dispose(): Promise<void>
}

/** How long to wait for a freshly-spawned Chrome to expose its debugging endpoint. */
const CHROME_DISCOVERY_TIMEOUT_MS = 12_000

/**
 * Hard ceiling on any single CDP command round-trip. Without it, one dead page (a spinner
 * that never fires `did-finish-load`, a Chrome tab that stops answering) leaves the send
 * promise pending forever — and because the Cowork loop awaits each tool, the WHOLE run
 * wedges with no way for Stop to unstick it. 30s is far longer than a healthy command yet
 * short enough that a hung page surfaces as an error the model (or the loop's stall guard)
 * can act on, instead of an infinite hang.
 */
const CMD_TIMEOUT_MS = 30_000

/** Shared, persistent profile for the in-app browser — the SAME one the human-driven "Setup
 * Myto Browser" window uses (cowork-browser-setup.ts), so logins made there flow through here. */
const IN_APP_PARTITION = 'persist:myto-inapp-browser'

/** One-line message for a thrown value. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Reject `p` if it hasn't settled within `ms`. The timer is always cleared once `p`
 * settles (win or lose), so a resolved command never leaves a dangling timeout. Used to
 * put a hard ceiling on every CDP command so a dead page can't wedge the run forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/**
 * Append a line to `userData/myto-browser.log`. This runtime can't run headless and has
 * no unit tests, so when the packaged app shows a blank window or the model reports the
 * browser "does nothing", this file is the only trace of what the CDP round-trip actually
 * did. Best-effort — logging must never break the browser, so every failure is swallowed.
 */
function browserLog(msg: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'myto-browser.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // never let logging throw into the browser path
  }
}

/**
 * A friendly "ready" page shown the instant the in-app window opens, so it is never a
 * jarring blank rectangle before the first navigation (the symptom behind "kisui hoy na").
 * Replaced by the real site as soon as the model calls browser_navigate.
 */
const IN_APP_READY_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><title>Myto Browser</title>' +
      '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;' +
      'font:15px/1.6 system-ui,Segoe UI,sans-serif;color:#444;background:#faf9f7}' +
      'div{text-align:center;max-width:32rem;padding:2rem}b{color:#181818}</style></head>' +
      '<body><div><b>Myto Browser</b><br>Ready — Myto will open pages here as it works.</div></body></html>'
  )

/**
 * CDP over Electron's built-in `webContents.debugger` (the in-app sandboxed browser).
 * `sendCommand` already returns the bare CDP result, and the WebContents fires
 * `did-finish-load` for us, so this is a thin shim.
 */
class DebuggerTransport implements CdpTransport {
  constructor(private readonly wc: Electron.WebContents) {}
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      return await withTimeout(
        this.wc.debugger.sendCommand(method, params ?? {}),
        CMD_TIMEOUT_MS,
        `in-app browser command ${method} timed out after ${CMD_TIMEOUT_MS / 1000}s`
      )
    } catch (err) {
      browserLog(`[in-app] send ${method} FAILED: ${errText(err)}`)
      throw err
    }
  }
  log(msg: string): void {
    browserLog(`[in-app] ${msg}`)
  }
  waitForLoad(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wc.off('did-finish-load', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.wc.once('did-finish-load', done)
    })
  }
}
/** Minimal structural view of the global WebSocket — the node tsconfig has no DOM lib. */
interface WsLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void
}
type WsCtor = new (url: string) => WsLike
const WebSocketCtor = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket

/**
 * CDP over a raw WebSocket to a Chrome page target (the system-chrome path). Tracks
 * request ids to match replies, and resolves `waitForLoad` on the `Page.loadEventFired`
 * event so a navigation waits for the real page, not a fixed delay.
 */
class WebSocketTransport implements CdpTransport {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private loadWaiters: Array<() => void> = []
  constructor(private readonly ws: WsLike) {
    ws.addEventListener('message', (ev) => this.onMessage(ev.data))
  }

  private onMessage(data: unknown): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    const id = typeof msg.id === 'number' ? msg.id : undefined
    if (id !== undefined && this.pending.has(id)) {
      const waiter = this.pending.get(id)!
      this.pending.delete(id)
      const err = msg.error as { message?: string } | undefined
      if (err) waiter.reject(new Error(err.message ?? 'CDP error'))
      else waiter.resolve((msg.result as unknown) ?? {})
    } else if (msg.method === 'Page.loadEventFired') {
      const waiters = this.loadWaiters
      this.loadWaiters = []
      for (const w of waiters) w()
    }
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      // A dead Chrome tab may never reply; drop the pending entry and reject so the
      // command surfaces as an error instead of hanging the whole run forever.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`system-chrome command ${method} timed out after ${CMD_TIMEOUT_MS / 1000}s`))
        }
      }, CMD_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  log(msg: string): void {
    browserLog(`[system-chrome] ${msg}`)
  }

  waitForLoad(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.loadWaiters.push(done)
    })
  }

  close(): void {
    this.ws.close()
  }
}
/** Poll Chrome's `/json` list until a page target with a WebSocket URL appears (or time out).
 * `isDefunct` lets the caller short-circuit the wait: when the Chrome we spawned has already
 * exited (it forwarded our flags to an existing instance and quit), there is no point polling
 * a port that will never open — bail out at once with an actionable message instead. */
async function discoverPageWs(
  port: number,
  signal: AbortSignal,
  isDefunct?: () => boolean
): Promise<string> {
  const deadline = Date.now() + CHROME_DISCOVERY_TIMEOUT_MS
  let lastErr = 'no page target'
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Cancelled while starting Chrome.')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      lastErr = 'Chrome is up but exposed no page target'
    } catch {
      lastErr = 'debugging port not accepting connections yet'
    }
    // If the launched Chrome already quit, an existing Chrome swallowed our flags — stop early.
    if (isDefunct?.()) {
      throw new Error(
        'Chrome was already running, so it ignored the debugging request and no port opened. ' +
          'Fully quit Chrome first (close every window, and check the system tray / Task Manager for a lingering chrome.exe), then try again — ' +
          'or switch to the in-app browser in Settings › Tools, which reuses the logins you set up in "Setup Myto Browser".'
      )
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(
    `Could not reach Chrome's remote-debugging port (${lastErr}). If Chrome is already running, quit it first, or switch to the in-app browser in Settings › Tools.`
  )
}

/** Wait for a WebSocket to open (or reject on error/timeout). */
function waitForOpen(ws: WsLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening the Chrome WebSocket.')), timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Failed to open the Chrome WebSocket.'))
    })
  })
}

/** In-app target: a sandboxed BrowserWindow (blank persistent profile) driven via CDP. */
function createInAppController(): BrowserController {
  browserLog('[in-app] creating BrowserWindow')
  // Present as plain Chrome on the shared partition BEFORE the window loads. Electron's
  // default UA carries `Electron/…`+`Myto/…` tokens that WhatsApp Web / some login pages
  // reject; without this the agent's own browser hits the same "update Chrome" wall the
  // Setup window did. Set at session level so it sticks across every navigation here.
  const ua = chromeUserAgent(process.platform)
  try {
    electronSession.fromPartition(IN_APP_PARTITION).setUserAgent(ua)
  } catch (err) {
    browserLog(`[in-app] setUserAgent (session) failed: ${errText(err)}`)
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    title: 'Myto Browser',
    webPreferences: { partition: IN_APP_PARTITION, sandbox: true, contextIsolation: true }
  })
  const wc = win.webContents
  wc.setUserAgent(ua)
  // Trace the WebContents' own load lifecycle — independent of CDP, so a blank window
  // caused by a failed/blocked load (offline, cert error, crashed renderer) shows up here
  // even when the CDP round-trip looks fine.
  wc.on('did-fail-load', (_e, code, desc, url) =>
    browserLog(`[in-app] did-fail-load ${code} "${desc}" @ ${url}`)
  )
  wc.on('did-finish-load', () => browserLog(`[in-app] did-finish-load @ ${wc.getURL()}`))
  wc.on('render-process-gone', (_e, details) =>
    browserLog(`[in-app] render-process-gone: ${details.reason}`)
  )
  try {
    wc.debugger.attach('1.3')
    browserLog('[in-app] debugger attached (protocol 1.3)')
  } catch (err) {
    // Usually means it's already attached (e.g. devtools open); the session can still
    // send commands. Logged in case it's a real failure behind a blank window.
    browserLog(`[in-app] debugger.attach threw (likely already attached): ${errText(err)}`)
  }
  // Show a friendly ready page immediately so the window is never an unexplained blank
  // rectangle before the first navigation, and surface it if even this fails to render.
  win.loadURL(IN_APP_READY_PAGE).catch((err) => browserLog(`[in-app] ready page failed: ${errText(err)}`))
  win.focus()
  const session = new BrowserSession(new DebuggerTransport(wc))
  return {
    session,
    async dispose(): Promise<void> {
      browserLog('[in-app] dispose')
      try {
        wc.debugger.detach()
      } catch {
        // ignore — window may already be gone.
      }
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
/** system-chrome target: launch the user's real Chrome with a debugging port and drive it over CDP/WS. */
async function createSystemChromeController(signal: AbortSignal): Promise<BrowserController> {
  const exe = chromeCandidates(process.platform, process.env).find((p) => existsSync(p))
  if (!exe) {
    throw new Error('No Chrome/Chromium/Edge was found. Install Chrome, or pick the in-app browser in Settings › Cowork.')
  }
  if (!WebSocketCtor) {
    throw new Error('This runtime has no WebSocket; the system-chrome browser is unavailable — use the in-app browser.')
  }
  const port = 9222 + Math.floor(Math.random() * 2000)
  browserLog(`[system-chrome] launching ${exe} on port ${port}`)
  const child: ChildProcess = spawn(
    exe,
    // No --user-data-dir → Chrome reuses the real profile (the point: existing logins).
    // --remote-allow-origins=* is required by modern Chrome to accept a non-browser CDP client.
    [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check'],
    { stdio: 'ignore' }
  )
  child.on('error', (err) => {
    browserLog(`[system-chrome] spawn error: ${errText(err)}`)
  })
  // A COLD-started Chrome stays alive as the browser process; if instead it exits within a
  // moment, an already-running Chrome swallowed our flags — discoverPageWs uses this to fail
  // fast with a "quit Chrome first" message instead of polling a dead port for 12s.
  let launcherExited = false
  child.on('exit', (code) => {
    launcherExited = true
    browserLog(`[system-chrome] launcher exited (code ${code ?? 'null'}) — likely an existing Chrome took the flags`)
  })
  const wsUrl = await discoverPageWs(port, signal, () => launcherExited)
  browserLog(`[system-chrome] discovered page target`)
  const ws = new WebSocketCtor(wsUrl)
  await waitForOpen(ws, 5_000)
  browserLog(`[system-chrome] WebSocket open`)
  const transport = new WebSocketTransport(ws)
  const session = new BrowserSession(transport)
  return {
    session,
    async dispose(): Promise<void> {
      transport.close()
      try {
        child.kill()
      } catch {
        // ignore — process may have exited already.
      }
    }
  }
}

/**
 * Build the browser controller for the chosen target. Called lazily by provider-ipc on
 * the first `browser_*` tool call of a run and disposed when the run ends. Throws (with a
 * user-actionable message the tool surfaces) when the target is off or can't be started.
 */
export async function createBrowserController(
  target: BrowserTarget | undefined,
  signal: AbortSignal
): Promise<BrowserController> {
  const resolved = resolveBrowserTarget(target)
  browserLog(`createBrowserController target=${target ?? 'undefined'} → ${resolved}`)
  switch (resolved) {
    case 'in-app':
      return createInAppController()
    case 'system-chrome':
      return createSystemChromeController(signal)
    default:
      throw new Error('The browser is off — pick in-app or system-chrome in Settings › Cowork.')
  }
}
