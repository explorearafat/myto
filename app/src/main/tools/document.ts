import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toErrorMessage } from '../providers/http'
import type { ToolDef } from './registry'
import { fsAvailable, resolveInWorkspace } from './fs'
import { documentHtml, slidesHtml, withExtension, type DocKind } from '../cowork-docgen'
import { checkArtifact } from '../cowork-artifacts'

/**
 * create_document (Cowork): the Claude-Code-style "make me a PDF / slides / doc" tool.
 * It turns Markdown into a polished, self-contained HTML page (document or slide deck)
 * with the pure {@link documentHtml}/{@link slidesHtml} generators, then — for a PDF —
 * prints that page with the app's own Chromium via {@link ToolContext.renderDocument}
 * (cowork-docgen-runtime.ts). No puppeteer, pandoc, or headless-chrome download; the one
 * rendering engine the app already ships does the work. Gated + sandboxed exactly like the
 * other filesystem tools; the generated PDF is byte-validated before we call it done.
 */

/** What the tool ultimately writes to disk. */
type OutFormat = 'pdf' | 'html'

/** First of `keys` that holds a trimmed non-empty string on the input, or null. */
function readStr(input: unknown, ...keys: string[]): string | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** The Markdown body: accept content / source / markdown / text, in that order. */
function readSource(input: unknown): string | null {
  return readStr(input, 'content', 'source', 'markdown', 'text')
}

/** True when the caller asked for a slide deck (slides:true, or kind/format "slides"/"deck"). */
function wantsSlides(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const o = input as Record<string, unknown>
  if (o.slides === true) return true
  const k = typeof o.kind === 'string' ? o.kind.toLowerCase() : ''
  const f = typeof o.format === 'string' ? o.format.toLowerCase() : ''
  return k === 'slides' || k === 'deck' || f === 'slides' || f === 'deck'
}

/** Output format: an explicit html/pdf `format` wins; else the path extension; else PDF. */
function resolveFormat(input: unknown, path: string): OutFormat {
  const f = readStr(input, 'format')
  if (f) {
    const lf = f.toLowerCase()
    if (lf === 'html' || lf === 'htm') return 'html'
    if (lf === 'pdf') return 'pdf'
    // 'slides'/'deck'/'document' describe LAYOUT, not file format — fall through.
  }
  return /\.html?$/i.test(path) ? 'html' : 'pdf'
}

/** Does a path already exist? (Decides whether a binary write is safely rewindable.) */
async function fileExists(abs: string): Promise<boolean> {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

export const createDocumentTool: ToolDef = {
  name: 'create_document',
  description:
    "Turn Markdown into a polished, ready-to-share DOCUMENT or SLIDE DECK — a real PDF (rendered with the app's built-in Chromium, no external tools) or a standalone HTML page. Use for reports, briefs, letters, one-pagers, and decks. Set \"slides\": true for a deck (split slides with a --- line on its own).",
  usage: '{"path": "report.pdf", "content": "# Title\\n\\nBody…", "slides": false, "title": "My Report"}',
  sideEffect: 'write',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Output file, relative to the working folder. Extension picks the format: .pdf (default) or .html.'
      },
      content: {
        type: 'string',
        description: 'The Markdown source. Headings, lists, GFM tables, fenced code, bold/italic, links, and images are supported.'
      },
      slides: {
        type: 'boolean',
        description: 'Render as a slide deck (one slide per section, split on a --- line). Default false.'
      },
      title: {
        type: 'string',
        description: 'Document/deck title for the page <title>. Defaults to the first heading in the Markdown.'
      },
      format: {
        type: 'string',
        enum: ['pdf', 'html'],
        description: 'Force the output format instead of inferring it from the path extension.'
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  available: fsAvailable,
  async run(input, ctx): Promise<string> {
    if (!ctx.workspaceDir) return 'create_document needs an open working folder (Cowork mode).'
    const rawPath = readStr(input, 'path')
    if (!rawPath) return 'create_document needs {"path": "report.pdf", "content": "# markdown…"}.'
    const markdown = readSource(input)
    if (markdown == null) return 'create_document needs a "content" string holding the Markdown to render.'

    const kind: DocKind = wantsSlides(input) ? 'slides' : 'document'
    const title = readStr(input, 'title') ?? undefined
    const html = kind === 'slides' ? slidesHtml({ title, markdown }) : documentHtml({ title, markdown })
    const label = kind === 'slides' ? 'slide deck' : 'document'

    // Decide the format, then normalise the extension so PDF bytes never land in a .md file.
    // If PDF rendering isn't wired up (no Electron — unit tests, or a degraded ctx), fall back
    // to an HTML page honestly rather than writing a broken/empty PDF.
    let format = resolveFormat(input, rawPath)
    if (format === 'pdf' && !ctx.renderDocument) format = 'html'
    const rel = withExtension(rawPath, format === 'html' ? 'html' : 'pdf')
    const abs = resolveInWorkspace(ctx.workspaceDir, rel)
    if (!abs) return `create_document: "${rel}" is outside the working folder and was refused.`

    try {
      await mkdir(dirname(abs), { recursive: true })

      if (format === 'html') {
        // Text output: full before/after snapshot so it is rewindable + shows in the diff viewer.
        let before: string | null = null
        try {
          before = await readFile(abs, 'utf8')
        } catch {
          before = null
        }
        await writeFile(abs, html, 'utf8')
        ctx.onFileSnapshot?.({ path: abs, before, after: html, kind: 'write', existed: before !== null })
        const note = ctx.renderDocument
          ? ''
          : " (PDF rendering isn't available here, so I wrote a standalone HTML page — open it in a browser and Print → Save as PDF.)"
        return `Wrote ${label} to ${rel} — ${html.length} characters of self-contained HTML.${note}`
      }

      // PDF: render the HTML to bytes with Chromium, validate the bytes, then write.
      const existedBefore = await fileExists(abs)
      const bytes = await ctx.renderDocument!(html, kind)
      const check = checkArtifact(rel, bytes)
      if (!check.ok) {
        return `create_document: the PDF render produced an invalid file — ${check.detail} Try format:"html" to get a page you can print to PDF from a browser instead.`
      }
      await writeFile(abs, bytes)
      // Binary snapshot is only safely rewindable as a *create*: rewind restores text, so an
      // overwrite of a pre-existing binary can't round-trip — skip the checkpoint in that case
      // rather than let a rewind blank the file. A brand-new file rewinds cleanly (delete).
      if (!existedBefore) {
        ctx.onFileSnapshot?.({ path: abs, before: null, after: null, kind: 'write', existed: false })
      }
      return `Created ${label} ${rel} — ${check.detail} Rendered from your Markdown with the app's built-in Chromium; no external tools needed.`
    } catch (err) {
      return `create_document failed for "${rel}": ${toErrorMessage(err)}`
    }
  }
}

