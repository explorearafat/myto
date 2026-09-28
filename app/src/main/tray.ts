import { app, Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * System-tray keep-alive for the background-autonomy mandate.
 *
 * The whole module is INERT unless the user opts in (settings.background.keepAliveInTray).
 * With the flag off — the default — no tray is ever created and Myto keeps its normal
 * lifecycle (closing the last window quits). With it on, a tray icon (Show / Quit) is
 * shown and the process stays alive after the window closes, so scheduled tasks and any
 * in-flight run survive a window close. This does NOT relaunch Myto after a real Quit or
 * an OS restart — that needs an OS login-item/daemon and is deliberately deferred.
 *
 * Everything here is best-effort and failure-isolated: a tray that can't be built (missing
 * icon, platform quirk) must never take down the main process or block the app, because the
 * feature is a convenience layered on top of a fully-working app.
 */

let tray: Tray | null = null
/** Set true once a real quit is under way, so nothing tries to resurrect the tray. */
let quitting = false

/** Callback that (re)creates and focuses the main window — injected to avoid a cycle. */
type ShowWindow = () => void
let showWindow: ShowWindow = () => {}

/** Wire the window-show behaviour the tray's "Show Myto" item uses. Call once on boot. */
export function setTrayWindowOpener(fn: ShowWindow): void {
  showWindow = fn
}

/** Mark that the app is genuinely quitting (called from `before-quit`). */
export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

/**
 * Resolve a tray icon. In dev the brand PNG sits next to the app root; packaged it ships
 * inside the asar (added to electron-builder `files`) and Electron transparently reads it
 * from app.asar.unpacked. Falls back to an empty image so the Tray still constructs on any
 * platform even if the asset is somehow missing — the tray entry stays usable via its menu.
 */
function trayImage(): NativeImage {
  const candidates = [
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  for (const path of candidates) {
    try {
      if (path && existsSync(path)) {
        const img = nativeImage.createFromPath(path)
        if (!img.isEmpty()) {
          // Windows tray art is ~16px; downscale the 256px brand mark so it stays crisp.
          return img.resize({ width: 16, height: 16 })
        }
      }
    } catch {
      // try the next candidate
    }
  }
  return nativeImage.createEmpty()
}

function buildTray(): void {
  if (tray) return
  try {
    tray = new Tray(trayImage())
    tray.setToolTip('Myto — running in the background')
    const menu = Menu.buildFromTemplate([
      {
        label: 'Show Myto',
        click: () => {
          try {
            showWindow()
          } catch (error) {
            console.error('[myto] tray show failed:', error)
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit Myto',
        click: () => {
          quitting = true
          destroyTray()
          app.quit()
        }
      }
    ])
    tray.setContextMenu(menu)
    // Left-click on Windows/Linux surfaces the window too (matches user expectation).
    tray.on('click', () => {
      try {
        showWindow()
      } catch (error) {
        console.error('[myto] tray click failed:', error)
      }
    })
  } catch (error) {
    // A tray we couldn't build must not break the app; log and carry on tray-less.
    console.error('[myto] failed to create tray:', error)
    tray = null
  }
}

function destroyTray(): void {
  if (!tray) return
  try {
    tray.destroy()
  } catch (error) {
    console.error('[myto] failed to destroy tray:', error)
  }
  tray = null
}

/**
 * Reconcile the tray with the current setting. Called on boot and on every settings save,
 * so toggling keep-alive in the UI takes effect immediately with no restart. Idempotent.
 */
export function applyTrayState(keepAlive: boolean): void {
  if (quitting) return
  if (keepAlive) buildTray()
  else destroyTray()
}

/** Whether the last-window-closed handler should keep the process alive (tray up). */
export function shouldKeepAlive(keepAlive: boolean): boolean {
  return keepAlive && !quitting
}
