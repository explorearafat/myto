/**
 * widget — the opt-in floating status window.
 *
 * The tray is always there; this is for people who would rather not have to look
 * at a tray at all. It is a 280×84 frameless card, always on top, out of the
 * taskbar, showing the same line the tray tooltip shows plus the two things a
 * tooltip cannot offer: a running clock, and buttons — open the run log at the lane
 * that is talking, or stop the run.
 *
 * It loads the ordinary renderer bundle at `#/widget` (see `renderer/src/main.tsx`)
 * rather than a second HTML entry, so it inherits the preload bridge, the CSP, the
 * theme and the fonts for free.
 *
 * The window is deliberately `closable: false`. Its visibility is a *persisted
 * preference* (`ui.statusWidget`), and a window that could dismiss itself would
 * leave the Settings toggle claiming something untrue until the next launch. One
 * owner of the state, one place to turn it off.
 */
import { join } from 'node:path'
import { BrowserWindow, screen, type Rectangle } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { AmbientStatus } from '../shared/types'
import { ambientStatus, onAmbientStatus } from './ambient'
import { getSettings } from './settings'

const WIDTH = 280
const HEIGHT = 84
/** Gap from the screen edge, so it doesn't sit flush against the taskbar. */
const MARGIN = 16

/**
 * Paint colour for the frame before the page draws, from the same two palettes
 * `globals.css` defines. Matching the persisted theme here is what keeps a white
 * flash off a dark desktop in the instant between create and first paint.
 */
const FRAME_COLOUR: Record<'light' | 'dark', string> = {
  light: '#faf9f5',
  dark: '#1a1917'
}

let widget: BrowserWindow | null = null
let disposeStatus: (() => void) | null = null
/**
 * Where the user last dragged it, within this session. Toggling the preference off
 * and on again should not teleport the card back to the corner; a fresh launch
 * starting bottom-right is fine, and is what someone expects of a new window.
 */
let lastPosition: { x: number; y: number } | null = null

/** Bottom-right of the display the cursor is on, inside its work area. */
function cornerPosition(): { x: number; y: number } {
  const area: Rectangle = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return {
    x: Math.round(area.x + area.width - WIDTH - MARGIN),
    y: Math.round(area.y + area.height - HEIGHT - MARGIN)
  }
}

function push(status: AmbientStatus): void {
  if (widget == null || widget.isDestroyed()) return
  widget.webContents.send(IpcChannel.AmbientStatusChanged, status)
}

/** Create and show the widget. A no-op when it is already up. */
export function showStatusWidget(): void {
  if (widget != null && !widget.isDestroyed()) {
    widget.showInactive()
    return
  }
  const position = lastPosition ?? cornerPosition()

  widget = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...position,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // See the file comment: Settings is the only thing that turns this off.
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: FRAME_COLOUR[getSettings().ui.theme === 'dark' ? 'dark' : 'light'],
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // 'floating' keeps it above ordinary windows without fighting menus and
  // notification popups for the very top of the stack.
  widget.setAlwaysOnTop(true, 'floating')
  widget.on('move', () => {
    if (widget == null || widget.isDestroyed()) return
    const [x, y] = widget.getPosition()
    lastPosition = { x, y }
  })
  // `showInactive`: appearing must never steal focus from whatever is being typed
  // in — this is a thing to glance at, not a thing to interact with by default.
  widget.once('ready-to-show', () => widget?.showInactive())
  widget.on('closed', () => {
    widget = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void widget.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/widget`)
  } else {
    void widget.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/widget' })
  }

  // The renderer also asks for the status itself on mount (`ambient.get`), so a
  // slow load cannot miss the state it opened in.
  disposeStatus?.()
  disposeStatus = onAmbientStatus(push)
  push(ambientStatus())
}

/**
 * Take the widget down. Safe to call when there isn't one.
 *
 * Also the reason quitting works: a `closable: false` window ignores `close()`, so
 * `app.quit()` would stall forever waiting for it. Callers destroy it on
 * `before-quit` and when the main window closes.
 */
export function hideStatusWidget(): void {
  disposeStatus?.()
  disposeStatus = null
  // `destroy`, not `close`: the window is `closable: false`, so close() is ignored.
  if (widget != null && !widget.isDestroyed()) widget.destroy()
  widget = null
}

/** Apply the persisted preference. The single entry point for the toggle. */
export function applyWidgetPreference(show: boolean): void {
  if (show) {
    showStatusWidget()
  } else {
    hideStatusWidget()
  }
}
