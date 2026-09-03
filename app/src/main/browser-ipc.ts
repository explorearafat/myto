/**
 * The renderer-facing door onto the in-app page view, and the wiring that lets the
 * engine drive either browser.
 *
 * Two responsibilities, deliberately in one small file:
 *
 *   1. **IPC** — the panel says where to draw the view, whether it is showing, and
 *      what to load; status changes are pushed back so the address row mirrors
 *      url/title/loading with no polling.
 *   2. **Target wiring** — {@link setBrowserTargets} hands the runner a factory for
 *      each driver: the in-app `WebContentsView` and the real Chrome that
 *      `chrome-ipc.ts` already manages. Injected rather than imported by the runner,
 *      so the runner (and the engine that calls it) stays Electron-free.
 *
 * The driver is also selected here: the renderer's segmented control sets it, and
 * that same choice is what the engine's next `browse` drives — one setting, not two.
 */
import { BrowserWindow, ipcMain, type BrowserWindow as Window } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { BrowserBounds, BrowserDriver, BrowserViewStatus } from '../shared/types'
import { chromeManager } from './chrome-ipc'
import { chromeBrowserTarget } from './browser/chromeAdapter'
import { setBrowserDriver, setBrowserTargets } from './browser/runner'
import {
  appBrowserTarget,
  attachBrowserHost,
  browserStatus,
  destroyBrowserView,
  goBrowserView,
  openBrowserView,
  reloadBrowserView,
  setBrowserBounds,
  setBrowserVisible,
  stopBrowserView
} from './browser/view'

/** Push a view-status change to every live renderer. */
function broadcast(status: BrowserViewStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.BrowserStatusChanged, status)
  }
}

/** Coerce an untrusted IPC rect. */
function asBounds(raw: unknown): BrowserBounds {
  const r = (raw ?? {}) as Partial<BrowserBounds>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
}

/**
 * Hand the view module its window and wire both browse targets.
 *
 * Called once, right after `createWindow()`. The Chrome factory is lazy on purpose:
 * touching `chromeManager()` only when a `browse` actually asks for the real browser
 * means nothing is launched at startup.
 */
export function attachBrowserWindow(window: Window): void {
  attachBrowserHost(window, broadcast)
  setBrowserTargets({
    app: () => appBrowserTarget(),
    chrome: () => chromeBrowserTarget(chromeManager())
  })
}

export function registerBrowserIpc(): void {
  ipcMain.handle(IpcChannel.BrowserGetStatus, () => browserStatus())

  ipcMain.handle(IpcChannel.BrowserOpen, (_event, url: unknown) =>
    openBrowserView(typeof url === 'string' ? url : undefined)
  )

  ipcMain.handle(IpcChannel.BrowserSetBounds, (_event, bounds: unknown) => {
    setBrowserBounds(asBounds(bounds))
  })

  ipcMain.handle(IpcChannel.BrowserSetVisible, (_event, visible: unknown) => {
    setBrowserVisible(visible === true)
  })

  ipcMain.handle(IpcChannel.BrowserClose, () => destroyBrowserView())

  ipcMain.handle(IpcChannel.BrowserReload, (_event, ignoreCache: unknown) =>
    reloadBrowserView(ignoreCache === true)
  )

  ipcMain.handle(IpcChannel.BrowserStop, () => {
    stopBrowserView()
  })

  ipcMain.handle(IpcChannel.BrowserGo, (_event, delta: unknown) =>
    goBrowserView(typeof delta === 'number' && delta < 0 ? -1 : 1)
  )

  // Which browser the agent drives next. The panel's segmented control owns this,
  // so what the user sees selected is what the engine actually uses.
  ipcMain.handle(IpcChannel.BrowserSetDriver, (_event, driver: unknown) => {
    setBrowserDriver((driver === 'chrome' ? 'chrome' : 'app') as BrowserDriver)
  })
}
