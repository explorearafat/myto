/**
 * ambient-ipc — wiring for the surfaces outside the chat window.
 *
 * Two directions meet here, and keeping them apart is the whole point:
 *  - the mini widget READS (`AmbientGet`, `AmbientStatusChanged`) and ASKS
 *    (`AmbientFocus`, `AmbientStop`);
 *  - the MAIN window only LISTENS (`AmbientFocusLane`, `AmbientStopRun`).
 *
 * Nothing out here cancels a run itself. The renderer holds the live run's id and
 * owns the canvas, so an ambient "Stop" is forwarded to it as an intent — which
 * leaves exactly one owner of cancellation instead of two paths into the engine
 * that could disagree about what is running.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { AmbientStatus } from '../shared/types'
import { ambientStatus } from './ambient'
import { getSettings } from './settings'
import { startTray, stopTray } from './tray'
import { applyWidgetPreference, hideStatusWidget } from './widget'

/** The chat window: where a focus/stop intent is delivered. */
let host: BrowserWindow | null = null

/** Bring the chat window forward, restoring it if it was minimised. */
function surfaceHost(): void {
  if (host == null || host.isDestroyed()) return
  if (host.isMinimized()) host.restore()
  host.show()
  host.focus()
}

function tellHost(channel: string, ...args: unknown[]): void {
  if (host == null || host.isDestroyed()) return
  host.webContents.send(channel, ...args)
}

/** Show the chat window and point its run log at a lane (null = every lane). */
function focusLane(lane: string | null): void {
  surfaceHost()
  tellHost(IpcChannel.AmbientFocusLane, lane)
}

/** Ask the chat window to stop its live run. */
function requestStop(): void {
  tellHost(IpcChannel.AmbientStopRun)
}

export function registerAmbientIpc(): void {
  ipcMain.handle(IpcChannel.AmbientGet, (): AmbientStatus => ambientStatus())

  ipcMain.on(IpcChannel.AmbientFocus, (_event, lane: unknown) => {
    focusLane(typeof lane === 'string' ? lane : null)
  })

  ipcMain.on(IpcChannel.AmbientStop, () => {
    requestStop()
  })
}

/**
 * Hand the ambient surfaces their window: start the tray, and open the floating
 * widget if the user has asked for one.
 *
 * Called right after `createWindow()`, and again if the window is recreated (macOS
 * `activate`). The widget is destroyed when this window closes — it is
 * `closable: false`, so leaving it up would keep `window-all-closed` from ever
 * firing and the app would never quit.
 */
export function attachAmbientWindow(window: BrowserWindow): void {
  host = window
  startTray(window, { onFocusLane: focusLane, onStop: requestStop })
  window.on('closed', () => {
    hideStatusWidget()
    if (host === window) host = null
  })
  applyWidgetPreference(getSettings().ui.statusWidget)
}

/** Tear both surfaces down (app quit). Safe when neither was ever started. */
export function stopAmbient(): void {
  hideStatusWidget()
  stopTray()
  host = null
}
