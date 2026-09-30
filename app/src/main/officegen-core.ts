/**
 * Pure core for the create_file tool: parse Markdown / tabular text into intermediate
 * models (blocks, slides, rows) with NO docx/exceljs/pptxgenjs, fs, or Electron import —
 * unit-tested in isolation, the same split as cowork-docgen (pure) vs its runtime. The
 * sibling officegen.ts turns these models into real .docx/.xlsx/.pptx bytes with the
 * bundled pure-JS libraries.
 */

/** An inline text run with optional emphasis. */
export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

/** A parsed Markdown block. */
export type Block =
  | { type: 'heading'; level: number; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'bullets'; items: Run[][]; ordered: boolean }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'code'; text: string }

/** One slide for a deck: a title plus bullet lines. */
export interface Slide {
  title: string
  bullets: string[]
}

/** File formats create_file can write. */
export type FileFormat =
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'txt'
  | 'md'
  | 'csv'
  | 'json'
  | 'html'
  | 'pdf'
  | 'unknown'

const FORMAT_BY_EXT: Record<string, FileFormat> = {
  docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', txt: 'txt', text: 'txt',
  md: 'md', markdown: 'md', csv: 'csv', tsv: 'csv', json: 'json',
  html: 'html', htm: 'html', pdf: 'pdf'
}

/** Classify the target file by its extension; 'unknown' when unrecognised. */
export function formatFromPath(path: string): FileFormat {
  const m = /\.([a-z0-9]+)\s*$/i.exec(path)
  return FORMAT_BY_EXT[(m ? m[1] : '').toLowerCase()] ?? 'unknown'
}

// One regex covering **bold**, __bold__, *italic*, _italic_, `code`.
const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/g

/** Split inline Markdown into runs, preserving bold / italic / code emphasis. */
export function parseInline(text: string): Run[] {
  const runs: Run[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) })
    if (m[2] != null) runs.push({ text: m[2], bold: true })
    else if (m[3] != null) runs.push({ text: m[3], bold: true })
    else if (m[4] != null) runs.push({ text: m[4], italic: true })
    else if (m[5] != null) runs.push({ text: m[5], italic: true })
    else if (m[6] != null) runs.push({ text: m[6], code: true })
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs.length ? runs : [{ text }]
}

/** Flatten inline Markdown to plain text (emphasis markers removed). */
export function stripInline(text: string): string {
  return parseInline(text).map((r) => r.text).join('')
}

/** Split a Markdown table row `| a | b |` into trimmed cells. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** True when `line` is a Markdown table separator row (`|---|:--:|`). */
function isTableSep(line: string): boolean {
  return line.includes('-') && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)
}

/** Match a list item, returning [marker, text] or null. */
const LIST_RE = /^([-*+]|\d+[.)])\s+(.*)$/

/**
 * Parse Markdown into a flat block list: headings, paragraphs, bullet/ordered lists,
 * GFM tables and fenced code. Pragmatic (not a full CommonMark parser) but covers the
 * elements a document generator needs to render faithfully into DOCX.
 */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) {
      blocks.push({ type: 'paragraph', runs: parseInline(para.join(' ').trim()) })
      para = []
    }
  }
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t === '') { flush(); i++; continue }
    if (t.startsWith('```')) {
      flush(); i++
      const buf: string[] = []
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++ }
      i++ // consume closing fence (if any)
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, runs: parseInline(h[2].trim()) }); i++; continue }
    if (t.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const header = splitRow(t)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i].trim())); i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }
    if (LIST_RE.test(t)) {
      flush()
      const ordered = /^\d/.test(t)
      const items: Run[][] = []
      while (i < lines.length) {
        const mm = LIST_RE.exec(lines[i].trim())
        if (!mm) break
        items.push(parseInline(mm[2].trim())); i++
      }
      blocks.push({ type: 'bullets', items, ordered })
      continue
    }
    para.push(t); i++
  }
  flush()
  return blocks
}

/**
 * Split Markdown into slides on `---` rules. Per slide, the first heading becomes the
 * title and every other non-blank line becomes a bullet (list markers and inline
 * emphasis stripped). A deck always has at least one slide.
 */
export function splitSlides(md: string): Slide[] {
  const parts = md.replace(/\r\n/g, '\n').split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean)
  return (parts.length ? parts : ['']).map((part) => {
    let title = ''
    const bullets: string[] = []
    for (const ln of part.split('\n')) {
      const t = ln.trim()
      if (!t) continue
      const h = /^(#{1,6})\s+(.*)$/.exec(t)
      if (h && !title) { title = stripInline(h[2].trim()); continue }
      const li = LIST_RE.exec(t)
      bullets.push(stripInline(li ? li[2].trim() : t))
    }
    return { title: title || 'Slide', bullets }
  })
}

/** Parse one CSV line into fields, honouring "quoted, fields" and "" escapes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/**
 * Parse tabular content into rows for a spreadsheet. A Markdown table (header + `|---|`
 * separator) is read as a grid; otherwise the text is treated as CSV, one row per line.
 */
export function parseTabular(content: string): string[][] {
  const lines = content.trim().split(/\r?\n/)
  if (lines.length >= 2 && lines[0].includes('|') && isTableSep(lines[1])) {
    return [
      splitRow(lines[0]),
      ...lines.slice(2).filter((l) => l.includes('|') && l.trim() !== '').map((l) => splitRow(l.trim()))
    ]
  }
  return lines.filter((l) => l.trim() !== '').map(parseCsvLine)
}


