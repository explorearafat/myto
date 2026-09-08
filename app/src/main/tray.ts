/**
 * tray — Sylor's presence in the system tray, and the dot on its taskbar button.
 *
 * This is the always-on half of the ambient status (the floating widget is the
 * opt-in half): once a run is going you can alt-tab away, and the tray icon plus
 * its tooltip still say whether Sylor is working, blocked on you, or finished.
 * "Blocked on you" is the state that earns the whole feature — a run waiting for
 * an approval looks exactly like a working one from outside the window.
 *
 * The icon is drawn here in code rather than loaded from `resources/`, for two
 * reasons that point the same way: the icon has to *change* with the state (a
 * static logo would say nothing), and `resources/` is electron-builder's
 * `buildResources` dir, so it is not shipped inside the packaged app at all —
 * `window.ts` already works around that for the window icon. Drawing means dev and
 * installed builds show the same thing, with nothing to go missing.
 */
import { app, Menu, Tray, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import type { AmbientState, AmbientStatus } from '../shared/types'
import { ambientStatus, onAmbientStatus } from './ambient'

/** RGB triples, from the app's own palette (`renderer/styles/globals.css`). */
const STATE_COLOUR: Record<AmbientState, [number, number, number]> = {
  // Terracotta: --color-primary, so the tray reads as this app and not any other.
  running: [0xd9, 0x77, 0x57],
  // Amber for "your turn". Sylor never uses red for a state a person can fix.
  waiting: [0xf5, 0xb1, 0x4c],
  done: [0x34, 0xd3, 0x99],
  failed: [0xf5, 0xb1, 0x4c],
  idle: [0x8b, 0x94, 0x9e]
}

/** How each state describes itself in the tooltip's first line. */
const STATE_LABEL: Record<AmbientState, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  done: 'Finished',
  failed: 'Stopped on an error',
  idle: 'Idle'
}

const ICON_SIZE = 16

/**
 * Draw a filled (or hollow) disc as a tray/overlay icon.
 *
 * `createFromBitmap` takes raw BGRA, which is the one image format available
 * without an asset or an encoder. Alpha is premultiplied so the one-pixel feather
 * at the rim doesn't leave a bright halo on a dark taskbar.
 */
function discIcon([r, g, b]: [number, number, number], hollow: boolean): NativeImage {
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4)
  const centre = (ICON_SIZE - 1) / 2
  const outer = 7
  const inner = 3.2
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const dx = x - centre
      const dy = y - centre
      const distance = Math.sqrt(dx * dx + dy * dy)
      // Coverage of this pixel: 1 inside, 0 outside, feathered across the rim. A
      // hollow disc subtracts the same feather from the inside edge.
      let coverage = Math.min(1, Math.max(0, outer - distance + 0.5))
      if (hollow) coverage = Math.min(coverage, Math.min(1, Math.max(0, distance - inner + 0.5)))
      if (coverage <= 0) continue
      const alpha = Math.round(255 * coverage)
      const at = (y * ICON_SIZE + x) * 4
      buffer[at] = Math.round((b * alpha) / 255)
      buffer[at + 1] = Math.round((g * alpha) / 255)
      buffer[at + 2] = Math.round((r * alpha) / 255)
      buffer[at + 3] = alpha
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: ICON_SIZE, height: ICON_SIZE })
}

/** The tray glyph for a state: a ring while nothing is running, a solid dot otherwise. */
function stateIcon(state: AmbientState): NativeImage {
  return discIcon(STATE_COLOUR[state], state === 'idle')
}

/**
 * The tooltip. Two or three short lines — the state, what is happening, and the
 * lane count when there is more than one worker. `message` is the engine's own
 * words, so this never claims more than the chat window does.
 */
function tooltipFor(status: AmbientStatus): string {
  const lines = [`Sylor — ${STATE_LABEL[status.state]}`]
  if (status.message && status.message !== STATE_LABEL[status.state]) lines.push(status.message)
  if (status.agents > 0) {
    lines.push(`${status.agents} subagent${status.agents === 1 ? '' : 's'} running`)
  }
  return lines.join('\n')
}

let tray: Tray | null = null
let host: BrowserWindow | null = null
let disposeStatus: (() => void) | null = null
/** Called with a lane when a tray item wants the window at one; null = every lane. */
let focusLane: ((lane: string | null) => void) | null = null
/** Called when a tray item asks the live run to stop. */
let requestStop: (() => void) | null = null

/** Bring the main window forward — restoring it first if it was minimised. */
function surfaceWindow(): void {
  if (host == null || host.isDestroyed()) return
  if (host.isMinimized()) host.restore()
  host.show()
  host.focus()
}

function rebuildMenu(status: AmbientStatus): void {
  if (tray == null) return
  const live = status.state === 'running' || status.state === 'waiting'
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // Not a toggle and not a status line: the label says what the click does.
      { label: 'Show Sylor', click: () => surfaceWindow() },
      {
        label: status.lane != null ? 'Open the run log on this lane' : 'Open the run log',
        click: () => {
          surfaceWindow()
          focusLane?.(status.lane)
        }
      },
      { type: 'separator' },
      {
        label: 'Stop this run',
        // Greyed rather than hidden while nothing is running: the item's absence
        // would read as "there is no way to stop it from here".
        enabled: live,
        click: () => requestStop?.()
      },
      { type: 'separator' },
      { label: 'Quit Sylor', click: () => app.quit() }
    ])
  )
}

/** Paint the current status onto the tray icon, its tooltip, and the taskbar button. */
function paint(status: AmbientStatus): void {
  if (tray != null && !tray.isDestroyed()) {
    tray.setImage(stateIcon(status.state))
    tray.setToolTip(tooltipFor(status))
    rebuildMenu(status)
  }
  if (host == null || host.isDestroyed()) return
  // Windows-only, and only while there is something to report: an overlay that
  // never clears would keep claiming a run that ended.
  if (process.platform !== 'win32') return
  const live = status.state === 'running' || status.state === 'waiting'
  if (live) {
    host.setOverlayIcon(stateIcon(status.state), tooltipFor(status))
  } else {
    host.setOverlayIcon(null, '')
  }
}

/**
 * Create the tray and start reflecting the run into it.
 *
 * `onFocusLane` / `onStop` are injected because the *renderer* owns the live run's
 * id and the canvas — main forwards the intent instead of reaching into the engine
 * behind the window's back, which is what keeps one owner for cancellation.
 */
export function startTray(
  window: BrowserWindow,
  handlers: { onFocusLane: (lane: string | null) => void; onStop: () => void }
): void {
  host = window
  focusLane = handlers.onFocusLane
  requestStop = handlers.onStop
  if (tray == null) {
    tray = new Tray(stateIcon('idle'))
    tray.setIgnoreDoubleClickEvents(true)
    // A plain click is the thing people expect from a tray icon, so it does the
    // obvious thing rather than opening the menu.
    tray.on('click', () => surfaceWindow())
  }
  paint(ambientStatus())
  disposeStatus?.()
  disposeStatus = onAmbientStatus(paint)
}

/** Tear the tray down (app quit). Safe to call when it was never started. */
export function stopTray(): void {
  disposeStatus?.()
  disposeStatus = null
  if (host != null && !host.isDestroyed() && process.platform === 'win32') {
    host.setOverlayIcon(null, '')
  }
  if (tray != null && !tray.isDestroyed()) tray.destroy()
  tray = null
  host = null
  focusLane = null
  requestStop = null
}
