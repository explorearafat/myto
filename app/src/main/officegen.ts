import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType
} from 'docx'
import ExcelJS from 'exceljs'
import pptxgen from 'pptxgenjs'
import type { Block, Run, Slide } from './officegen-core'

/**
 * Runtime half of the create_file tool: turn the pure {@link Block}/{@link Slide}/row
 * models from officegen-core.ts into real .docx/.xlsx/.pptx bytes with the bundled,
 * pure-JS libraries (docx, exceljs, pptxgenjs) — no native binary, no headless browser,
 * no Office install. Each builder returns a Buffer/Uint8Array the caller byte-validates
 * with checkArtifact before writing, so a malformed render never lands on disk as a file.
 */

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6
]

/** One inline run → a docx TextRun (code spans render in a monospace font). */
function toRun(r: Run): TextRun {
  return new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined })
}

/** A GFM table block → a full-width docx Table with a bold header row. */
function toTable(header: string[], rows: string[][]): Table {
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1)
  const cell = (text: string, bold: boolean): TableCell =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] })
  const row = (cells: string[], bold: boolean): TableRow =>
    new TableRow({ children: Array.from({ length: cols }, (_, i) => cell(cells[i] ?? '', bold)) })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [row(header, true), ...rows.map((r) => row(r, false))]
  })
}

/** Build a .docx from parsed Markdown blocks. Returns the packed OOXML bytes. */
export async function buildDocx(blocks: Block[]): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = []
  for (const b of blocks) {
    if (b.type === 'heading') {
      children.push(new Paragraph({ heading: HEADINGS[Math.min(b.level, 6) - 1], children: b.runs.map(toRun) }))
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ children: b.runs.map(toRun) }))
    } else if (b.type === 'bullets') {
      b.items.forEach((item, i) => {
        // Ordered lists prefix an "n." into the text (reliable across Word without a
        // numbering-instance definition); unordered lists use a real bullet.
        const runs = b.ordered ? [new TextRun({ text: `${i + 1}. ` }), ...item.map(toRun)] : item.map(toRun)
        children.push(new Paragraph({ children: runs, bullet: b.ordered ? undefined : { level: 0 } }))
      })
    } else if (b.type === 'table') {
      children.push(toTable(b.header, b.rows))
    } else {
      for (const line of b.text.split('\n')) {
        children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }))
      }
    }
  }
  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}

/** Build an .xlsx from a grid of rows. Row 1 is styled as a bold header. */
export async function buildXlsx(rows: string[][], sheetName = 'Sheet1'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Myto'
  wb.created = new Date()
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Sheet1')
  for (const r of rows) ws.addRow(r)
  if (rows.length > 0) ws.getRow(1).font = { bold: true }
  // Roughly autosize each column to its widest cell (capped) so the sheet is readable.
  ws.columns.forEach((col) => {
    let max = 10
    col.eachCell?.({ includeEmpty: false }, (c) => {
      max = Math.max(max, String(c.value ?? '').length + 2)
    })
    col.width = Math.min(max, 60)
  })
  return Buffer.from(await wb.xlsx.writeBuffer() as unknown as Uint8Array)
}

/** Build a .pptx deck: one slide per {@link Slide}, title + bulleted body. */
export async function buildPptx(slides: Slide[]): Promise<Uint8Array> {
  const pptx = new pptxgen()
  pptx.author = 'Myto'
  for (const s of slides) {
    const slide = pptx.addSlide()
    slide.addText(s.title, { x: 0.5, y: 0.3, w: '90%', h: 0.8, fontSize: 28, bold: true })
    if (s.bullets.length > 0) {
      slide.addText(
        s.bullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
        { x: 0.6, y: 1.3, w: '85%', h: 4.5, fontSize: 16, valign: 'top' }
      )
    }
  }
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
}

