import type { ChatImage } from '../../shared/types'

/**
 * Pure helpers for the `render_document` tool (A2b) — deciding WHICH pages to rasterize, and
 * turning the runtime's PNG data-URLs into {@link ChatImage}s for the model. The actual
 * rasterization (pdf.js on a real Chromium canvas in an offscreen window) lives in the
 * Electron-backed runtime; everything testable without a packaged app lives here.
 *
 * Rasterizing a scanned page to an image is the point-4 branch of the read_document spec:
 * a page with no text layer can't be read as text, so we turn it into a picture the vision
 * model can actually see (or, when vision is unavailable, the honest fallback note the tool
 * returns).
 */

/** Hard cap on pages rasterized in one call — each page is a full image in the vision
 * payload, so an unbounded range would blow the request size. The model can call again for
 * a later window, exactly like read_pages. */
export const MAX_RASTER_PAGES = 8

/** Device-scale for rasterization. 2× keeps small scanned text legible without ballooning
 * the PNG the way 3×+ would. */
export const DEFAULT_RASTER_SCALE = 2

/** Clamp a rasterization scale request into a sane range (defends against a silly input). */
export function clampScale(scale: unknown): number {
  const n = typeof scale === 'number' && isFinite(scale) ? scale : DEFAULT_RASTER_SCALE
  return Math.min(3, Math.max(1, n))
}

/**
 * The 1-based page numbers to rasterize, from the tool's `pages` input and the document's
 * total page count. Accepts a single number (`4`), a string number (`"4"`) or a range
 * (`"3-5"`, `"3:5"`); anything else (or nothing) means "from page 1". Always returns a
 * non-empty, ascending, de-duplicated list within `[1, totalPages]` and capped at
 * {@link MAX_RASTER_PAGES}.
 */
export function parseRasterPages(input: unknown, totalPages: number): number[] {
  const total = Math.max(1, Math.floor(totalPages) || 1)
  let start = 1
  let end = 0 // 0 → "fill up to the cap from start"
  if (typeof input === 'number' && isFinite(input)) {
    start = Math.floor(input)
    end = start
  } else if (typeof input === 'string' && input.trim()) {
    const m = /^(\d+)\s*(?:[-:]\s*(\d+))?$/.exec(input.trim())
    if (m) {
      start = parseInt(m[1], 10)
      end = m[2] ? parseInt(m[2], 10) : start
    }
  }
  if (start < 1) start = 1
  if (start > total) start = total
  if (end === 0) end = Math.min(total, start + MAX_RASTER_PAGES - 1)
  if (end < start) end = start
  if (end > total) end = total
  const pages: number[] = []
  for (let p = start; p <= end && pages.length < MAX_RASTER_PAGES; p++) pages.push(p)
  return pages
}

/** Parse one `data:<mime>;base64,<bytes>` URL into a {@link ChatImage}; null if malformed. */
export function dataUrlToChatImage(dataUrl: string): ChatImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/is.exec(dataUrl.trim())
  if (!m) return null
  const mediaType = m[1].trim().toLowerCase()
  const dataBase64 = m[2].trim()
  if (!dataBase64) return null
  return { mediaType, dataBase64 }
}

/** Map a batch of data-URLs to {@link ChatImage}s, dropping any that don't parse. */
export function dataUrlsToChatImages(dataUrls: readonly string[]): ChatImage[] {
  const out: ChatImage[] = []
  for (const u of dataUrls) {
    const img = dataUrlToChatImage(u)
    if (img) out.push(img)
  }
  return out
}

/** A short human caption for the rasterized batch, e.g. `scan.pdf — page 3` / `pages 3–5`. */
export function rasterCaption(rel: string, pages: readonly number[]): string {
  if (pages.length === 0) return rel
  if (pages.length === 1) return `${rel} — page ${pages[0]}`
  return `${rel} — pages ${pages[0]}–${pages[pages.length - 1]}`
}

/**
 * The tool-result text the model reads after a successful rasterization. It must make clear
 * that the pages are attached as IMAGES (vision), so the model answers from what it sees
 * rather than claiming it can't read the file.
 */
export function rasterResultNote(rel: string, pages: readonly number[], hasVision: boolean): string {
  const cap = rasterCaption(rel, pages)
  if (!hasVision) {
    return `Rendered ${cap} to image(s), but the active model has no vision input wired for this turn, so they could not be shown to it. OCR fallback is not bundled. Use a vision-capable model to read this scanned document.`
  }
  return `Rendered ${cap} to image(s) and attached them as vision input for you to read. Describe or answer from what you see in the page image(s). If you need later pages, call render_document again with the next range.`
}
