/**
 * Build-complete preview screenshot — the ELECTRON half of the Cowork visual self-review.
 *
 * When a run finishes building something viewable, the loop screenshots its preview so the model
 * can SEE the result and fix visual/layout bugs. We render the same URL the preview pane shows —
 * a localhost dev server the run started, or a `file://` page it built — in a hidden BrowserWindow
 * and `capturePage()` it. Same "let the app's own Chromium do it" trick as document-raster-runtime
 * (offscreen render, no puppeteer, no native module); an offscreen window is used rather than the
 * user's live preview `<webview>` so this never touches that crash-sensitive panel.
 *
 * ⚠️ Only typechecked, never unit-tested: a real BrowserWindow + a real page load need a packaged
 * app. All pure logic (which preview, the review prompt) lives in ./tools/preview-review-core,
 * where the tests are. Best-effort by contract: any failure resolves to null so a flaky capture
 * can never block or crash the finish — the run just proceeds to verify as before.
 */
import { BrowserWindow } from 'electron'
import type { ChatImage } from '../shared/types'

/** Viewport to render at — a desktop width so layouts show as a user would first see them. */
const CAPTURE_WIDTH = 1280
const CAPTURE_HEIGHT = 900
/** Hard cap on the whole load; a dev server that hangs must not stall the finish. */
const LOAD_TIMEOUT_MS = 15_000
/** Let a client-rendered page (React/Vite) paint, fonts settle, first data land, after load. */
const SETTLE_MS = 1_100

/** Resolve when the page stops loading (or fails), or after `capMs` — whichever comes first. */
function waitForLoad(wc: Electron.WebContents, capMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, capMs)
    // did-fail-load still resolves: an error/500 page is itself worth showing the model.
    wc.once('did-stop-loading', finish)
    wc.once('did-fail-load', finish)
  })
}

/**
 * Screenshot `url` (an http(s) dev-server URL or a `file://` page) as a PNG {@link ChatImage},
 * or null if it can't be captured. Loads in a hidden, secure BrowserWindow, waits for the page
 * to settle, captures the viewport, and always destroys the window. Never throws.
 */
export async function capturePreviewImage(url: string, signal?: AbortSignal): Promise<ChatImage | null> {
  if (!url || !url.trim()) return null
  if (signal?.aborted) return null
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const wc = win.webContents
    const loaded = waitForLoad(wc, LOAD_TIMEOUT_MS)
    // loadURL rejects on some non-2xx / aborted loads; the waiter + capture still run, so swallow.
    win.loadURL(url).catch(() => {})
    await loaded
    if (signal?.aborted) return null
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    if (signal?.aborted) return null
    const image = await wc.capturePage()
    const png = image.toPNG()
    if (!png || png.length === 0) return null
    return { mediaType: 'image/png', dataBase64: png.toString('base64') }
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}
