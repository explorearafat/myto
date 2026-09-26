/**
 * Native document/slide → PDF — the ELECTRON half of ./cowork-docgen. The pure core turns
 * Markdown into a self-contained HTML page; this loads that HTML into a hidden, script-free
 * BrowserWindow and prints it with Chromium's own `webContents.printToPDF`, the one PDF
 * engine the app already ships. No puppeteer, pandoc, pdfkit, or headless-chrome download.
 *
 * ⚠️ Only typechecked, never unit-tested: BrowserWindow + printToPDF need a packaged app.
 * Keep it thin — all HTML/markdown logic lives in the pure ./cowork-docgen module, which is
 * where the unit tests are.
 */
import { BrowserWindow } from 'electron'
import { pdfOptionsFor, type DocKind, type PdfRenderOptions } from './cowork-docgen'

/** Let fonts, images, and layout settle after load before we snapshot the page to PDF. */
const SETTLE_MS = 180

/** How long to wait for the first full load before printing whatever has rendered so far —
 *  so one stuck remote image can never wedge the whole render. */
const LOAD_CAP_MS = 8_000

/** Resolve on the WebContents' first `did-finish-load`, or after `capMs` regardless. */
function waitForLoad(wc: Electron.WebContents, capMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      wc.off('did-finish-load', done)
      resolve()
    }
    const timer = setTimeout(done, capMs)
    wc.once('did-finish-load', done)
  })
}

/**
 * Render a complete HTML page to a PDF buffer. The HTML is loaded as a data URL into a
 * hidden window with JavaScript DISABLED — the generated markup is fully escaped and needs
 * no scripts, and disabling JS also stops any `<script>` that slipped through from running.
 * Waits for load + a short settle, prints, and always destroys the window.
 */
export async function renderHtmlToPdf(html: string, options: PdfRenderOptions): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true }
  })
  try {
    const loaded = waitForLoad(win.webContents, LOAD_CAP_MS)
    // Don't await loadURL directly: a sub-resource abort rejects it, but the page has still
    // rendered enough to print. The capped `loaded` promise is our real gate.
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {})
    await loaded
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    return await win.webContents.printToPDF({
      landscape: options.landscape,
      printBackground: options.printBackground,
      pageSize: options.pageSize,
      margins: {
        marginType: 'custom',
        top: options.margins.top,
        bottom: options.margins.bottom,
        left: options.margins.left,
        right: options.margins.right
      }
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Pick the print options for the kind, render, and return detached bytes for the tool layer. */
export async function renderDocumentPdf(html: string, kind: DocKind): Promise<Uint8Array> {
  const buf = await renderHtmlToPdf(html, pdfOptionsFor(kind))
  return new Uint8Array(buf)
}
