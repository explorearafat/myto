/**
 * Scanned-PDF → page images — the ELECTRON half of the `render_document` tool (A2b). A PDF
 * with no text layer can't be read as text, so we rasterize its pages to PNGs a vision model
 * can actually see. Rendering uses pdf.js on a REAL Chromium `<canvas>` inside a hidden
 * BrowserWindow — the same "let the app's own Chromium do it" trick as cowork-docgen-runtime.ts
 * (printToPDF). No native module, no headless-chrome download, no puppeteer.
 *
 * ⚠️ Only typechecked, never unit-tested: BrowserWindow + a canvas + the pdf.js worker need a
 * packaged app. Keep it thin — all pure logic (which pages, data-URL→ChatImage, captions) lives
 * in ./tools/document-raster-core, which is where the unit tests are.
 */
import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseRasterPages, clampScale } from './tools/document-raster-core'

/** Resolve the two pdf.js ESM assets to file:// URLs the offscreen page can import.
 * The regular (non-legacy) build is the browser-canvas entry; the legacy build is the
 * Node-only text path used by document-read.ts. `createRequire` locates them inside the
 * externalized node_modules (kept unpacked by electron-builder), so no bundling of the
 * multi-MB worker into the app chunk. */
function pdfAssetUrls(): { pdfUrl: string; workerUrl: string } {
  const require = createRequire(import.meta.url)
  const pdfUrl = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.mjs')).href
  const workerUrl = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.worker.mjs')).href
  return { pdfUrl, workerUrl }
}

/**
 * The offscreen page's script. It imports pdf.js as an ES module, points the worker at the
 * bundled worker file, and exposes two globals the Node side drives via executeJavaScript:
 *   __open(base64)  → opens the doc (kept alive on the page) and returns its page count
 *   __render(pages, scale) → renders those 1-based pages to PNG data-URLs
 * Splitting open/render lets the Node side pick pages with the pure {@link parseRasterPages}
 * once the true page count is known, without opening the document twice.
 */
function harnessHtml(pdfUrl: string, workerUrl: string): string {
  const script = `
import * as pdfjsLib from ${JSON.stringify(pdfUrl)}
pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(workerUrl)}
let _doc = null
window.__open = async (b64) => {
  const raw = atob(b64)
  const data = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
  const task = pdfjsLib.getDocument({ data, isEvalSupported: false, useSystemFonts: true })
  _doc = await task.promise
  return _doc.numPages
}
window.__render = async (pages, scale) => {
  if (!_doc) throw new Error('no document open')
  const urls = []
  for (const p of pages) {
    const page = await _doc.getPage(p)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    const context = canvas.getContext('2d')
    await page.render({ canvasContext: context, viewport, canvas }).promise
    urls.push(canvas.toDataURL('image/png'))
  }
  return urls
}
window.__rasterReady = true
`
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">${script}</script></body></html>`
}

/** Result of a rasterization: the doc's true page count, the pages actually rendered, and
 * their PNG data-URLs (aligned with `pages`). */
export interface RasterResult {
  total: number
  pages: number[]
  dataUrls: string[]
}

/** Resolve once `window.__rasterReady` is set by the module script, or reject after `capMs`.
 * A module script's import can finish just after `did-finish-load`, so we poll rather than
 * trust the load event alone. */
async function waitReady(wc: Electron.WebContents, capMs = 10_000): Promise<void> {
  const deadline = Date.now() + capMs
  for (;;) {
    const ready = await wc.executeJavaScript('!!window.__rasterReady').catch(() => false)
    if (ready) return
    if (Date.now() > deadline) throw new Error('pdf.js failed to initialise in time')
    await new Promise((r) => setTimeout(r, 60))
  }
}

/**
 * Rasterize a PDF's pages to PNG data-URLs. `pagesInput` is the tool's `pages` field (a
 * number, `"3-5"`, or absent → the first page-window); `scale` is clamped to [1,3]. Opens the
 * document in a hidden BrowserWindow, renders the chosen pages on a real canvas, and always
 * destroys the window. `webSecurity` is off ONLY so the local harness can import the local
 * pdf.js module + spawn its module worker across node_modules dirs — the window loads no
 * remote content and no user script.
 */
export async function rasterizePdf(
  bytes: Uint8Array,
  pagesInput: unknown,
  scaleInput: unknown,
  signal?: AbortSignal
): Promise<RasterResult> {
  const scale = clampScale(scaleInput)
  const { pdfUrl, workerUrl } = pdfAssetUrls()
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, webSecurity: false }
  })
  try {
    const wc = win.webContents
    win
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(harnessHtml(pdfUrl, workerUrl)))
      .catch(() => {})
    await waitReady(wc)
    if (signal?.aborted) throw new Error('cancelled')
    const b64 = Buffer.from(bytes).toString('base64')
    const total = (await wc.executeJavaScript(`window.__open(${JSON.stringify(b64)})`)) as number
    const pages = parseRasterPages(pagesInput, total)
    if (signal?.aborted) throw new Error('cancelled')
    const dataUrls = (await wc.executeJavaScript(
      `window.__render(${JSON.stringify(pages)}, ${JSON.stringify(scale)})`
    )) as string[]
    return { total, pages, dataUrls: Array.isArray(dataUrls) ? dataUrls : [] }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
