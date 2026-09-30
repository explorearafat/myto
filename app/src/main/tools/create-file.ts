import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toErrorMessage } from '../providers/http'
import type { ToolDef, ToolContext } from './registry'
import { fsAvailable, resolveInWorkspaceReal } from './fs'
import { checkArtifact } from '../cowork-artifacts'
import { formatFromPath, parseBlocks, splitSlides, parseTabular, type FileFormat } from '../officegen-core'
import { buildDocx, buildXlsx, buildPptx } from '../officegen'

/**
 * create_file (Cowork/Research): "make me a file of ANY type" — Word .docx, Excel .xlsx,
 * PowerPoint .pptx, or a plain .txt/.md/.csv/.json/.html. The Office formats are produced
 * with the app's bundled pure-JS engines (docx / exceljs / pptxgenjs), so there is no
 * Python, LibreOffice, or headless-browser dependency: Myto writes real OOXML bytes
 * itself, then byte-validates them with {@link checkArtifact} before the file lands.
 * Complements create_document (styled PDF / HTML decks) and write_file (raw text).
 */

/** Which bundled engine builds each binary format — surfaced in the success message. */
const ENGINE: Record<'docx' | 'xlsx' | 'pptx', string> = {
  docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint'
}

/** First of `keys` holding a string on the input (empty allowed only for `content`), or null. */
function readStr(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' ? raw : null
}

/** Does the target file already exist? (Decides whether a binary write is rewindable.) */
async function fileExists(abs: string): Promise<boolean> {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

/** Explicit `format` (validated) wins over the path extension. */
function resolveFormat(input: unknown, path: string): FileFormat {
  const f = readStr(input, 'format')?.trim().toLowerCase()
  if (f && f in { docx: 1, xlsx: 1, pptx: 1, txt: 1, md: 1, csv: 1, json: 1, html: 1, pdf: 1 }) {
    return f as FileFormat
  }
  return formatFromPath(path)
}

/** Render the content to OOXML bytes for a binary format. */
async function buildBinary(format: 'docx' | 'xlsx' | 'pptx', content: string, sheet: string): Promise<Uint8Array> {
  if (format === 'docx') return buildDocx(parseBlocks(content))
  if (format === 'pptx') return buildPptx(splitSlides(content))
  return buildXlsx(parseTabular(content), sheet)
}

/** Write one of the binary Office formats: build → validate → write (rewind on create). */
async function writeBinary(
  format: 'docx' | 'xlsx' | 'pptx', content: string, sheet: string,
  abs: string, rel: string, ctx: ToolContext
): Promise<string> {
  if (!content.trim()) return `create_file: "${rel}" (${format}) needs a "content" string to render.`
  const bytes = await buildBinary(format, content, sheet)
  const check = checkArtifact(rel, bytes)
  if (!check.ok) return `create_file: the ${format.toUpperCase()} render produced an invalid file — ${check.detail}`
  const existed = await fileExists(abs)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  // Binary snapshot is only safely rewindable as a create (rewind restores text, so an
  // overwrite of a pre-existing binary can't round-trip). A brand-new file rewinds cleanly.
  if (!existed) ctx.onFileSnapshot?.({ path: abs, before: null, after: null, kind: 'write', existed: false })
  return `Created ${rel} — ${check.detail} Built with Myto's bundled ${ENGINE[format]} engine; no external tools needed.`
}

/** Write a text-based format (txt/md/csv/json/html); JSON is pretty-printed when valid. */
async function writeText(
  format: FileFormat, content: string, abs: string, rel: string, ctx: ToolContext
): Promise<string> {
  let text = content
  if (format === 'json') {
    try { text = JSON.stringify(JSON.parse(content), null, 2) } catch { /* not valid JSON — keep verbatim */ }
  }
  await mkdir(dirname(abs), { recursive: true })
  let before: string | null = null
  try { before = await readFile(abs, 'utf8') } catch { before = null }
  await writeFile(abs, text, 'utf8')
  ctx.onFileSnapshot?.({ path: abs, before, after: text, kind: 'write', existed: before !== null })
  return `Wrote ${rel} — ${text.length} character${text.length === 1 ? '' : 's'}.`
}

export const createFileTool: ToolDef = {
  name: 'create_file',
  description:
    'Create a real file of ANY common type from your content: Word .docx, Excel .xlsx, PowerPoint .pptx, or a plain .txt/.md/.csv/.json/.html. Word & PowerPoint take Markdown (headings, lists, GFM tables, bold/italic; split slides with a --- line on its own); Excel takes CSV or a Markdown table. Office files are built with bundled pure-JS engines (no Python/Office install) and byte-validated. For a styled PDF or HTML slide deck use create_document instead.',
  usage: '{"path": "report.docx", "content": "# Title\\n\\nBody paragraph…\\n\\n- point one\\n- point two"}',
  sideEffect: 'write',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Output file, relative to the working folder. The extension picks the type (.docx/.xlsx/.pptx/.txt/.md/.csv/.json/.html).'
      },
      content: {
        type: 'string',
        description: 'The source. Markdown for .docx/.pptx; CSV or a Markdown table for .xlsx; the literal text for .txt/.md/.csv/.json/.html.'
      },
      format: {
        type: 'string',
        enum: ['docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'html'],
        description: 'Force the file type instead of inferring it from the path extension.'
      },
      sheet: {
        type: 'string',
        description: 'Worksheet name for .xlsx (default "Sheet1").'
      }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  available: fsAvailable,
  async run(input, ctx): Promise<string> {
    if (!ctx.workspaceDir) return 'create_file needs an open working folder (Cowork or Research mode).'
    const rel = readStr(input, 'path')?.trim()
    if (!rel) return 'create_file needs {"path": "report.docx", "content": "…"}.'
    const content = readStr(input, 'content')
    if (content == null) return 'create_file needs a "content" string (the file body).'

    const format = resolveFormat(input, rel)
    if (format === 'pdf') {
      return 'create_file does not render PDF — use create_document, which turns Markdown into a styled PDF with the built-in Chromium.'
    }
    if (format === 'unknown') {
      return `create_file: don't know the type of "${rel}". Use a .docx/.xlsx/.pptx/.txt/.md/.csv/.json/.html path, or pass "format".`
    }

    const abs = await resolveInWorkspaceReal(ctx.workspaceDir, rel)
    if (!abs) return `create_file: "${rel}" is outside the working folder and was refused.`

    try {
      if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
        const sheet = readStr(input, 'sheet')?.trim() || 'Sheet1'
        return await writeBinary(format, content, sheet, abs, rel, ctx)
      }
      return await writeText(format, content, abs, rel, ctx)
    } catch (err) {
      return `create_file failed for "${rel}": ${toErrorMessage(err)}`
    }
  }
}


