import { readFile, stat } from 'node:fs/promises'
import { toErrorMessage } from '../providers/http'
import type { ToolDef, ToolContext } from './registry'
import { fsAvailable, resolveInWorkspaceReal } from './fs'
import {
  classifyByExtension,
  inventory,
  isSmallDoc,
  outline,
  paginateText,
  pageWindow,
  formatPages,
  searchPages,
  cacheKey,
  estimateTokens,
  type PageText,
  type ReadableKind,
  type DocInventory
} from './document-read-core'

/**
 * read_document / read_pages / search_document (Cowork + Research): fast, model-agnostic
 * reading of PDFs and large text/code files — the "read a document the way Claude does"
 * path. read_document inventories first (type, pages, has-text-layer), hands a small doc
 * back in full and a big one back as a page outline; read_pages/search_document then drill
 * in without re-extracting (per-doc cache). All extraction logic that can be tested without
 * Electron lives in ./document-read-core; this file adds the fs + pdf.js runtime.
 */

/** Minimal structural view of the pdf.js surface used here (avoids a hard type dep; the
 * library is imported lazily so the pure core and its tests never pull it in). */
interface PdfTextItem {
  str?: string
}
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>
}
interface PdfDoc {
  numPages: number
  getPage(n: number): Promise<PdfPage>
}
/** getDocument returns a loading task; teardown (worker + doc) is task.destroy(). */
interface PdfLoadingTask {
  promise: Promise<PdfDoc>
  destroy(): Promise<void>
}
interface PdfjsModule {
  getDocument(src: {
    data: Uint8Array
    isEvalSupported?: boolean
    useSystemFonts?: boolean
  }): PdfLoadingTask
}

/** Small LRU of extracted pages, keyed by path+mtime+size (point #6: never re-extract). */
const CACHE = new Map<string, PageText[]>()
const CACHE_MAX = 8

function remember(key: string, pages: PageText[]): void {
  CACHE.delete(key)
  CACHE.set(key, pages)
  while (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next().value
    if (oldest === undefined) break
    CACHE.delete(oldest)
  }
}

/** Extract every page's text with pdf.js — text layer only, no worker/canvas. */
async function extractPdf(abs: string): Promise<PageText[]> {
  // The legacy build is the Node/headless-safe entry (no browser-only globals); a
  // computed specifier keeps TS from resolving deep-path types — the structural cast below
  // is the contract we actually rely on.
  const spec = 'pdfjs-dist/legacy/build/pdf.mjs'
  const pdfjs = (await import(/* @vite-ignore */ spec)) as unknown as PdfjsModule
  const data = new Uint8Array(await readFile(abs))
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true })
  const doc = await task.promise
  try {
    const pages: PageText[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push({ page: i, text: content.items.map((it) => it.str ?? '').join(' ') })
    }
    return pages
  } finally {
    await task.destroy()
  }
}

/** Read a non-empty string field from a tool input object, else null. */
function readStr(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** Read a finite number field (accepts numeric strings), else undefined. */
function readNum(input: unknown, key: string): number | undefined {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) ? n : undefined
}

interface Loaded {
  rel: string
  abs: string
  kind: ReadableKind
  pages: PageText[]
  inv: DocInventory
}

/** Resolve a path in the sandbox and extract (or cache-hit) its pages; else a model-facing error. */
async function loadPages(input: unknown, ctx: ToolContext, tool: string): Promise<Loaded | string> {
  const rel = readStr(input, 'path')
  if (!rel) return `${tool} needs {"path": "report.pdf"} — a path relative to the working folder.`
  const abs = ctx.workspaceDir ? await resolveInWorkspaceReal(ctx.workspaceDir, rel) : null
  if (!abs) return `${tool}: "${rel}" is outside the working folder and was refused.`
  const kind = classifyByExtension(rel)
  if (kind === 'image') {
    return `${tool}: "${rel}" is an image. This tool extracts TEXT; to read what an image shows, ask Myto to view it — a vision-capable model sees the picture directly.`
  }
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    return `${tool}: Office files (.${kind}) aren't text-extractable here yet — convert to PDF first, then read that.`
  }
  if (kind === 'unknown') {
    return `${tool}: don't know how to read "${rel}". Supported: PDF and text/code files (txt, md, csv, json, source code, …).`
  }
  const info = await stat(abs).catch(() => null)
  if (!info) return `${tool}: could not open "${rel}".`
  const key = cacheKey(abs, info.mtimeMs, info.size)
  let pages = CACHE.get(key)
  if (!pages) {
    try {
      pages = kind === 'pdf' ? await extractPdf(abs) : paginateText(await readFile(abs, 'utf8'))
    } catch (err) {
      return `${tool} failed to extract "${rel}": ${toErrorMessage(err)}`
    }
    remember(key, pages)
  }
  return { rel, abs, kind, pages, inv: inventory(kind, pages) }
}

export const readDocumentTool: ToolDef = {
  name: 'read_document',
  description:
    'Read a PDF or a large text/code file FAST, the way Claude reads a document. Returns an inventory first (type, page count, whether it has a real text layer). A small doc comes back in full with page markers; a big one comes back as a page-by-page outline — then use read_pages to read a range and search_document to find text. Works in Cowork/Research on files in the working folder.',
  usage: '{"path": "docs/spec.pdf"}',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path relative to the working folder' } },
    required: ['path']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const r = await loadPages(input, ctx, 'read_document')
    if (typeof r === 'string') return r
    const { rel, inv, pages } = r
    const scanned = inv.kind === 'pdf' && !inv.hasTextLayer
    const label = `${rel} — ${inv.pages} page${inv.pages === 1 ? '' : 's'}, ~${estimateTokens(inv.chars)} tokens${scanned ? ', NO text layer (scanned/image)' : ''}`
    if (scanned) {
      return `[${label}]\nThis PDF has no extractable text — it looks scanned/image-only, so read_pages would only return blank text. Call render_document {"path": "${rel}", "pages": "1-3"} to rasterize the pages to images and read them visually (needs a vision-capable model).`
    }
    if (isSmallDoc(inv)) return formatPages(pages, label)
    return [
      `[${label}]`,
      'Large document — page outline below. Use read_pages {"path","start","end"} to read a range, or search_document {"path","query"} to find text.',
      '',
      outline(pages)
    ].join('\n')
  }
}

export const readPagesTool: ToolDef = {
  name: 'read_pages',
  description:
    'Read an inclusive, 1-based page range of a document already located with read_document — for stepping through a big PDF or text file a section at a time.',
  usage: '{"path": "docs/spec.pdf", "start": 5, "end": 12}',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working folder' },
      start: { type: 'number', description: 'First page (1-based)' },
      end: { type: 'number', description: 'Last page (inclusive); defaults to start' }
    },
    required: ['path', 'start']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const r = await loadPages(input, ctx, 'read_pages')
    if (typeof r === 'string') return r
    const start = readNum(input, 'start') ?? 1
    const end = readNum(input, 'end') ?? start
    const slice = pageWindow(r.pages, start, end)
    if (slice.length === 0) {
      return `read_pages: no pages in range ${start}-${end}; "${r.rel}" has ${r.pages.length} page${r.pages.length === 1 ? '' : 's'}.`
    }
    const first = slice[0].page
    const last = slice[slice.length - 1].page
    return formatPages(slice, `${r.rel} — pages ${first}-${last} of ${r.pages.length}`)
  }
}

export const searchDocumentTool: ToolDef = {
  name: 'search_document',
  description:
    'Find a phrase inside a document (case-insensitive) and return the pages it appears on with a snippet of surrounding context — use it to jump to the right pages of a big file, then read_pages there.',
  usage: '{"path": "docs/spec.pdf", "query": "refund policy"}',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working folder' },
      query: { type: 'string', description: 'Text to find (case-insensitive)' }
    },
    required: ['path', 'query']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const r = await loadPages(input, ctx, 'search_document')
    if (typeof r === 'string') return r
    const query = readStr(input, 'query')
    if (!query) return 'search_document needs a "query" string, e.g. {"path": "spec.pdf", "query": "refund"}.'
    const hits = searchPages(r.pages, query)
    if (hits.length === 0) return `search_document: "${query}" not found in ${r.rel} (${r.pages.length} pages).`
    const lines = hits.map((h) => `  p${h.page}: ${h.snippet}`)
    return `[${r.rel}] ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}":\n${lines.join('\n')}\n\nUse read_pages to read a page in full.`
  }
}

/** The three reading tools, registered together in the tool registry. */
export const documentReadTools: readonly ToolDef[] = [
  readDocumentTool,
  readPagesTool,
  searchDocumentTool
]
