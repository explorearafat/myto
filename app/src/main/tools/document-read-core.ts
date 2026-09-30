/**
 * Pure core for the read_document / read_pages / search_document tools: everything
 * that turns already-extracted page text into a model-facing result, with NO pdfjs,
 * fs, or Electron import. Kept separate so it is unit-tested in isolation — the same
 * split as cowork-browser.ts (pure) vs cowork-browser-runtime.ts (GUI/typecheck-only).
 * The tool file (./document-read.ts) does the real extraction and calls into here.
 */

/** A readable document class, inferred from the file extension. */
export type ReadableKind = 'pdf' | 'text' | 'docx' | 'xlsx' | 'pptx' | 'image' | 'unknown'

/** One page: a real PDF page, or a virtual ~PAGE_CHARS slice of a text file. */
export interface PageText {
  /** 1-based page number. */
  page: number
  /** The page's extracted text ('' when the page has no text layer — e.g. scanned). */
  text: string
}

/** Cheap facts about a document, produced before any large extraction. */
export interface DocInventory {
  kind: ReadableKind
  /** Total page count (virtual pages for text files). */
  pages: number
  /** Total extracted characters across all pages. */
  chars: number
  /** False when (almost) every page has an empty text layer — a scanned/image PDF. */
  hasTextLayer: boolean
}

/** ~4 chars per token — the rough estimate used elsewhere for budgeting. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Virtual page size for text files, in characters. */
export const PAGE_CHARS = 3000
/** A doc is "small" (extract in full) at or below this many pages. */
export const SMALL_MAX_PAGES = 10
/** Token budget for a single tool result before truncation kicks in. */
export const TOKEN_BUDGET = 20_000
/** Character ceiling on one result body (TOKEN_BUDGET × ~4 chars/token). */
export const RESULT_CHAR_CAP = TOKEN_BUDGET * 4
/** Characters of context shown on each side of a search hit. */
export const SEARCH_CONTEXT = 120
/** Most pages previewed in an outline before it is cut with a note. */
export const OUTLINE_MAX_PAGES = 400

/** Extension → readable class. Text covers plain/markup/code; the rest are explicit. */
const EXT_MAP: Record<string, ReadableKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  txt: 'text', md: 'text', markdown: 'text', csv: 'text', tsv: 'text', json: 'text',
  log: 'text', xml: 'text', html: 'text', htm: 'text', yaml: 'text', yml: 'text', toml: 'text', ini: 'text',
  js: 'text', mjs: 'text', cjs: 'text', ts: 'text', tsx: 'text', jsx: 'text', py: 'text', java: 'text',
  c: 'text', h: 'text', cpp: 'text', hpp: 'text', cc: 'text', cs: 'text', go: 'text', rs: 'text', rb: 'text',
  php: 'text', sh: 'text', bash: 'text', sql: 'text', css: 'text', scss: 'text', kt: 'text', swift: 'text'
}

/** Classify a file by its extension (lower-cased); 'unknown' when unrecognised. */
export function classifyByExtension(path: string): ReadableKind {
  const m = /\.([a-z0-9]+)\s*$/i.exec(path)
  return EXT_MAP[(m ? m[1] : '').toLowerCase()] ?? 'unknown'
}

/** Split a text blob into uniform virtual pages so read_pages works on text too. */
export function paginateText(text: string, pageChars = PAGE_CHARS): PageText[] {
  if (text.length === 0) return [{ page: 1, text: '' }]
  const pages: PageText[] = []
  for (let i = 0, p = 1; i < text.length; i += pageChars, p++) {
    pages.push({ page: p, text: text.slice(i, i + pageChars) })
  }
  return pages
}

/** Build inventory facts from already-extracted pages. */
export function inventory(kind: ReadableKind, pages: PageText[]): DocInventory {
  const chars = pages.reduce((n, p) => n + p.text.length, 0)
  const nonEmpty = pages.filter((p) => p.text.trim().length > 0).length
  // A PDF with pages but (almost) no text on any of them is scanned/image-only.
  const hasTextLayer = pages.length === 0 ? false : nonEmpty / pages.length > 0.15
  return { kind, pages: pages.length, chars, hasTextLayer }
}

/** True when the whole document is small enough to hand back in one extract. */
export function isSmallDoc(inv: DocInventory): boolean {
  return inv.pages <= SMALL_MAX_PAGES && estimateTokens(inv.chars) <= TOKEN_BUDGET
}

/** Shown in place of a page with no text layer, telling the model how to recover it. */
const EMPTY_PAGE = '(no text layer on this page — likely scanned/image; ask Myto to read it visually)'

/** 1-based inclusive page slice; clamps to range and swaps reversed bounds. */
export function pageWindow(pages: PageText[], start: number, end: number): PageText[] {
  const n = pages.length
  let s = Number.isFinite(start) ? Math.trunc(start) : 1
  let e = Number.isFinite(end) ? Math.trunc(end) : s
  if (s > e) [s, e] = [e, s]
  s = Math.max(1, s)
  e = Math.min(n, e)
  return pages.filter((p) => p.page >= s && p.page <= e)
}

/**
 * Join pages with `--- Page N ---` markers, capping the body at `cap` characters and
 * appending a "call read_pages for more" hint when it had to stop early. `label` is the
 * inventory header (e.g. "report.pdf — 12 pages").
 */
export function formatPages(pages: PageText[], label: string, cap = RESULT_CHAR_CAP): string {
  const header = `[${label}]`
  const body: string[] = []
  let used = header.length
  let truncatedAt = 0
  for (const p of pages) {
    const chunk = `\n\n--- Page ${p.page} ---\n${p.text.trim() ? p.text.trim() : EMPTY_PAGE}`
    if (used + chunk.length > cap && body.length > 0) {
      truncatedAt = p.page
      break
    }
    body.push(chunk)
    used += chunk.length
  }
  let out = header + body.join('')
  if (truncatedAt > 0) {
    out += `\n\n…[truncated at page ${truncatedAt} to stay under ~${TOKEN_BUDGET} tokens — call read_pages with a start/end range to read further].`
  }
  return out
}

/**
 * A page-by-page outline (TOC) for a big document: page number + a one-line preview of
 * its text. Capped at {@link OUTLINE_MAX_PAGES} pages so a 1000-page PDF's map stays small.
 */
export function outline(pages: PageText[], previewChars = 90): string {
  const shown = pages.slice(0, OUTLINE_MAX_PAGES)
  const lines = shown.map((p) => {
    const preview = p.text.replace(/\s+/g, ' ').trim().slice(0, previewChars)
    return `  p${p.page}: ${preview || '(no text — scanned/image page)'}`
  })
  const more = pages.length > OUTLINE_MAX_PAGES ? `\n  …and ${pages.length - OUTLINE_MAX_PAGES} more pages` : ''
  return lines.join('\n') + more
}

/** Case-insensitive substring search across pages; returns page + a context snippet. */
export function searchPages(
  pages: PageText[],
  query: string,
  maxHits = 20
): Array<{ page: number; snippet: string }> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: Array<{ page: number; snippet: string }> = []
  for (const p of pages) {
    const hay = p.text.toLowerCase()
    let from = 0
    while (hits.length < maxHits) {
      const at = hay.indexOf(q, from)
      if (at === -1) break
      const s = Math.max(0, at - SEARCH_CONTEXT)
      const e = Math.min(p.text.length, at + q.length + SEARCH_CONTEXT)
      const snippet =
        (s > 0 ? '…' : '') +
        p.text.slice(s, e).replace(/\s+/g, ' ').trim() +
        (e < p.text.length ? '…' : '')
      hits.push({ page: p.page, snippet })
      from = at + q.length
    }
    if (hits.length >= maxHits) break
  }
  return hits
}

/** Stable cache key for an extracted document (path + mtime + size). */
export function cacheKey(path: string, mtimeMs: number, size: number): string {
  return `${path}::${Math.round(mtimeMs)}::${size}`
}
