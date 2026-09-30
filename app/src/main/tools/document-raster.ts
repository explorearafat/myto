import { readFile } from 'node:fs/promises'
import { toErrorMessage } from '../providers/http'
import type { ToolDef, ToolContext } from './registry'
import { fsAvailable, resolveInWorkspaceReal } from './fs'
import { classifyByExtension } from './document-read-core'
import { dataUrlsToChatImages, rasterCaption, rasterResultNote } from './document-raster-core'
import type { ChatImage } from '../../shared/types'

/**
 * render_document (Cowork + Research): turn a page the model can't read as TEXT into a picture
 * it can SEE — the point-4 branch of the read_document spec (A2b). A scanned / image-only PDF
 * has no text layer, so read_document/read_pages come back blank; render_document rasterizes
 * its pages to PNGs on a real Chromium canvas (document-raster-runtime.ts) and feeds them to
 * the model as vision input. An image file is shown directly (no rasterization). All pure
 * logic lives in ./document-raster-core; the Electron canvas render is a ctx callback so this
 * file — and its unit test — never import Electron.
 */

/** Read a non-empty string field from a tool input object, else null. */
function readStr(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** The `pages` / `scale` fields verbatim (number or string), for the raster-core to interpret. */
function rawField(input: unknown, key: string): unknown {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
}

/** Image file extension → an `image/*` media type for the vision payload. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

/** Show an image file straight to the vision model — read it, wrap it as a {@link ChatImage}. */
async function showImageFile(abs: string, rel: string, ctx: ToolContext): Promise<string> {
  const ext = (/\.([a-z0-9]+)\s*$/i.exec(rel)?.[1] ?? '').toLowerCase()
  const mediaType = IMAGE_MIME[ext] ?? 'image/png'
  let dataBase64: string
  try {
    dataBase64 = (await readFile(abs)).toString('base64')
  } catch (err) {
    return `render_document: could not read "${rel}": ${toErrorMessage(err)}`
  }
  const image: ChatImage = { mediaType, dataBase64 }
  const hasVision = !!ctx.emitToolImages
  if (hasVision) ctx.emitToolImages?.([image], rel)
  if (!hasVision) {
    return `Loaded ${rel} as an image, but no vision input is wired for this turn, so it could not be shown. Use a vision-capable model to view it.`
  }
  return `Attached ${rel} as an image for you to view. Describe or answer from what you see.`
}

export const renderDocumentTool: ToolDef = {
  name: 'render_document',
  description:
    'See a page you cannot read as text: rasterize a scanned / image-only PDF (one with no text layer) to page images and read them visually, or view an image file directly. Use this after read_document reports a PDF has NO text layer. Optional "pages" ("3" or "3-5", default the first pages) and "scale" (1-3, default 2). Needs a vision-capable model.',
  usage: '{"path": "scan.pdf", "pages": "1-3"}',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working folder' },
      pages: {
        type: ['string', 'number'],
        description: 'Page or range to render, e.g. 3 or "3-5" (default: the first pages)'
      },
      scale: { type: 'number', description: 'Render scale 1-3 (default 2; higher = crisper, larger)' }
    },
    required: ['path']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const rel = readStr(input, 'path')
    if (!rel) return 'render_document needs {"path": "scan.pdf"} — a path relative to the working folder.'
    const abs = ctx.workspaceDir ? await resolveInWorkspaceReal(ctx.workspaceDir, rel) : null
    if (!abs) return `render_document: "${rel}" is outside the working folder and was refused.`
    const kind = classifyByExtension(rel)
    if (kind === 'image') return showImageFile(abs, rel, ctx)
    if (kind !== 'pdf') {
      return `render_document rasterizes PDF pages (and shows image files). "${rel}" is not one — for text/code use read_document.`
    }
    if (!ctx.rasterizeDocument) {
      return 'render_document needs the app runtime (the offscreen page renderer) and is not available here.'
    }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(abs))
    } catch (err) {
      return `render_document: could not read "${rel}": ${toErrorMessage(err)}`
    }
    let rendered: { total: number; pages: number[]; dataUrls: string[] }
    try {
      rendered = await ctx.rasterizeDocument(bytes, rawField(input, 'pages'), rawField(input, 'scale'), ctx.signal)
    } catch (err) {
      return `render_document failed to rasterize "${rel}": ${toErrorMessage(err)}`
    }
    const images = dataUrlsToChatImages(rendered.dataUrls)
    if (images.length === 0) {
      return `render_document rendered no page images from "${rel}". The file may be empty, encrypted, or corrupt.`
    }
    const hasVision = !!ctx.emitToolImages
    if (hasVision) ctx.emitToolImages?.(images, rasterCaption(rel, rendered.pages))
    const note = rasterResultNote(rel, rendered.pages, hasVision)
    const last = rendered.pages[rendered.pages.length - 1]
    const more = last < rendered.total ? ` (${rendered.total} pages total — call again with pages "${last + 1}-…" for later pages.)` : ''
    return note + more
  }
}
