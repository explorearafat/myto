/**
 * The renderer-facing door onto the user's real browser.
 *
 * One {@link ChromeManager}, built lazily with the real world wired in: the browser is
 * located on disk, launched with a Sylor-only profile under `userData`, and driven
 * over a loopback DevTools port. Status changes are broadcast so the UI can mirror
 * url/title/loading without polling.
 *
 * Two things are deliberate here. The profile lives in Sylor's own `userData`, never in
 * the user's normal Chrome profile — nothing reads or copies their existing cookies; they
 * sign in once themselves, in a clean window Sylor opens on that profile and does not
 * drive (a debugging port is enough for Google to refuse the sign-in). And every window
 * Sylor opened is killed on quit (`closeChrome`), because an open debugging port is a
 * capability that should not outlive the app that asked for it.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { IpcChannel } from '../shared/ipc'
import type { ChromeStatus } from '../shared/types'
import { CdpClient } from './chrome/cdp'
import { launchBrowser, launchForSignIn } from './chrome/launch'
import { locateBrowser } from './chrome/locate'
import { openPage } from './chrome/page'
import { ChromeManager } from './chrome/manager'

let manager: ChromeManager | null = null

/** Push a status change to every live renderer. */
function broadcast(status: ChromeStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.ChromeStatusChanged, status)
  }
}

/** True for a path that exists and is a file we could execute. */
function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The dedicated browser profile — never the user's own Chrome profile.
 *
 * The directory name is deliberately still `sylorium-browser`: it holds the cookies
 * and logins of whoever has already signed in through this profile, so renaming it
 * would silently sign them out. It is a storage key, not a label.
 */
function profileDir(): string {
  return join(app.getPath('userData'), 'sylorium-browser')
}

/** Start a browser process without inheriting Sylor's stdio or lifetime quirks. */
function spawnBrowser(path: string, args: string[]): ReturnType<typeof spawn> {
  const child = spawn(path, args, { detached: false, stdio: 'ignore' })
  child.on('error', (err) => console.error('[sylor] the browser failed to start:', err))
  return child
}

/**
 * The single manager, wired to the real filesystem, the real Chrome, real sockets.
 *
 * Exported as {@link chromeManager} so the engine's `browse` tool can drive the same
 * one browser the UI shows — two managers would mean two windows and two profiles
 * fighting over Chrome's per-profile singleton lock.
 */
function getManager(): ChromeManager {
  if (manager) return manager
  manager = new ChromeManager({
    locate: () =>
      locateBrowser({
        platform: process.platform,
        env: process.env,
        exists: isExecutable,
        home: app.getPath('home')
      }),
    launch: (browser) =>
      launchBrowser({
        browser,
        userDataDir: profileDir(),
        spawn: spawnBrowser,
        readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
        removeFile: (path) => rmSync(path, { force: true })
      }),
    // Same profile, no debugging port: the only shape Google's sign-in accepts.
    launchForSignIn: (browser, url) =>
      launchForSignIn({ browser, userDataDir: profileDir(), spawn: spawnBrowser, startUrl: url }),
    connect: (url) => CdpClient.connect(url),
    open: (client, options) => openPage(client, options),
    onStatus: broadcast
  })
  return manager
}

/** Shut every window Sylor opened down (app quit, or the user closing the pane). */
export async function closeChrome(): Promise<void> {
  await manager?.shutdown()
}

/** The one real-Chrome manager, for main-side callers (the engine's `browse` tool). */
export function chromeManager(): ChromeManager {
  return getManager()
}

/** Coerce an untrusted IPC string. */
function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

export function registerChromeIpc(): void {
  ipcMain.handle(IpcChannel.ChromeGetStatus, () => getManager().status())

  ipcMain.handle(IpcChannel.ChromeOpen, async (_event, url: unknown) => {
    const chrome = getManager()
    const target = asString(url).trim()
    await chrome.ensure(target || undefined)
    return chrome.status()
  })

  ipcMain.handle(IpcChannel.ChromeClose, async () => {
    const chrome = getManager()
    await chrome.close()
    return chrome.status()
  })

  ipcMain.handle(IpcChannel.ChromeNavigate, async (_event, url: unknown) => {
    const chrome = getManager()
    const target = asString(url).trim()
    if (!target) throw new Error('No URL to open.')
    await chrome.navigate(target)
    return chrome.status()
  })

  // The expression comes from Sylor's own perception/controller code, and it runs in
  // the page's own world — the same trust boundary as `webview.executeJavaScript`.
  ipcMain.handle(IpcChannel.ChromeEvaluate, (_event, expression: unknown) =>
    getManager().evaluate(asString(expression))
  )

  ipcMain.handle(IpcChannel.ChromeScreenshot, () => getManager().screenshot())

  ipcMain.handle(IpcChannel.ChromeReload, (_event, ignoreCache: unknown) =>
    getManager().reload(ignoreCache === true)
  )

  ipcMain.handle(IpcChannel.ChromeStop, () => getManager().stopLoading())

  ipcMain.handle(IpcChannel.ChromeGo, (_event, delta: unknown) =>
    getManager().go(typeof delta === 'number' && delta < 0 ? -1 : 1)
  )

  ipcMain.handle(IpcChannel.ChromeFocus, () => getManager().focus())

  // Sign-in is the user's, in a window with nothing attached to it. Sylor gives up
  // the profile for the duration and takes it back when that window closes.
  ipcMain.handle(IpcChannel.ChromeSignIn, async (_event, url: unknown) => {
    const chrome = getManager()
    const target = asString(url).trim()
    await chrome.signIn(target || undefined)
    return chrome.status()
  })

  ipcMain.handle(IpcChannel.ChromeFinishSignIn, async () => {
    const chrome = getManager()
    await chrome.finishSignIn()
    return chrome.status()
  })
}


