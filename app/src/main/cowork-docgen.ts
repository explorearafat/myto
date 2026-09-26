/**
 * Native document generation — PURE, dependency-free generators that turn Markdown
 * into print-ready HTML (a flowing document or a slide deck) plus the CSS templates
 * and PDF options the Electron runtime consumes. No fs, no electron imports, so the
 * whole module is unit-testable — the same "extract the pure core" pattern as
 * cowork-scaffold.ts and cowork-artifacts.ts.
 *
 * Why this exists: give Myto Claude-Code-style PDF / slides / HTML output WITHOUT any
 * external library (no puppeteer, pandoc, pdfkit, or a headless-chrome download).
 * tools/document.ts converts Markdown to HTML here, then hands that HTML to Electron's
 * built-in Chromium via webContents.printToPDF (cowork-docgen-runtime.ts) to get a
 * real, valid PDF — the one rendering engine the app already ships.
 */

/** What create_document can emit. 'slides' is an HTML deck; both can be printed to PDF. */
export type DocKind = 'document' | 'slides'

/** Options passed through to Electron's webContents.printToPDF (kept lib-agnostic). */
export interface PdfRenderOptions {
  landscape: boolean
  printBackground: boolean
  pageSize: 'A4' | 'Letter'
  /** Page margins in inches. Zero all round — the CSS owns the framing for both kinds. */
  margins: { top: number; bottom: number; left: number; right: number }
}

/** Print options per kind: documents portrait, slides landscape; CSS handles inner spacing. */
export function pdfOptionsFor(kind: DocKind): PdfRenderOptions {
  const margins = { top: 0, bottom: 0, left: 0, right: 0 }
  return kind === 'slides'
    ? { landscape: true, printBackground: true, pageSize: 'A4', margins }
    : { landscape: false, printBackground: true, pageSize: 'A4', margins }
}

/** HTML-escape text so it is safe in element bodies AND double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Inline Markdown over an already HTML-escaped string: code spans first (their body is
 * protected from further formatting), then images, links, bold, and italic. Because the
 * text was escaped upstream, a URL or code body can never inject markup.
 */
function inlineMd(escaped: string): string {
  const parts = escaped.split(/(`[^`]+`)/g)
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) return `<code>${seg.slice(1, -1)}</code>`
      return seg
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
    })
    .join('')
}

/** A GFM table separator row like `|---|:--:|` (needs a dash and at least one pipe). */
function isTableSep(line: string | undefined): boolean {
  return !!line && /-/.test(line) && /\|/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
}

/** Lines that begin a new block, so a paragraph gather stops before them (tables handled separately). */
function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
  )
}

/** Split a GFM table row into trimmed cell strings (outer pipes optional). */
function tableCells(row: string): string[] {
  return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
}

/** Column alignment from a separator cell like `:--`, `--:`, or `:--:`. */
function colAlign(cell: string): string {
  const l = /^\s*:/.test(cell)
  const r = /:\s*$/.test(cell)
  return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
}

/** Parse a GFM table starting at `start` (header + separator + rows), or null if it isn't one. */
function parseTable(lines: string[], start: number): { html: string; next: number } | null {
  if (!/\|/.test(lines[start]) || !isTableSep(lines[start + 1])) return null
  const heads = tableCells(lines[start])
  const align = tableCells(lines[start + 1]).map(colAlign)
  const cell = (tag: string, text: string, k: number): string => {
    const style = align[k] ? ` style="text-align:${align[k]}"` : ''
    return `<${tag}${style}>${inlineMd(escapeHtml(text))}</${tag}>`
  }
  const th = heads.map((h, k) => cell('th', h, k)).join('')
  let i = start + 2
  const rows: string[] = []
  while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
    rows.push(`<tr>${tableCells(lines[i]).map((c, k) => cell('td', c, k)).join('')}</tr>`)
    i++
  }
  return { html: `<table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table>`, next: i }
}

/** Parse a flat unordered/ordered list starting at `start`. Nested lists are flattened. */
function parseList(lines: string[], start: number, ordered: boolean): { html: string; next: number } {
  const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
  const items: string[] = []
  let i = start
  for (let m = re.exec(lines[i]); i < lines.length && m; m = re.exec(lines[i])) {
    items.push(`<li>${inlineMd(escapeHtml(m[1].trim()))}</li>`)
    i++
  }
  const tag = ordered ? 'ol' : 'ul'
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i }
}

/**
 * Convert a Markdown string to an HTML fragment. A deliberately small, robust subset —
 * headings, fenced code, blockquotes, unordered/ordered lists, GFM tables, horizontal
 * rules, images/links, bold/italic/inline-code, and paragraphs — chosen to cover what an
 * agent actually emits in a report or deck. Everything is HTML-escaped; unknown syntax
 * degrades to plain text rather than throwing.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i++; continue }
    const fence = /^```(.*)$/.exec(line)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // skip the closing fence
      const cls = fence[1].trim() ? ` class="language-${escapeHtml(fence[1].trim())}"` : ''
      out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push(`<h${h[1].length}>${inlineMd(escapeHtml(h[2].trim()))}</h${h[1].length}>`); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`)
      continue
    }
    const table = parseTable(lines, i)
    if (table) { out.push(table.html); i = table.next; continue }
    if (/^\s*[-*+]\s+/.test(line)) { const r = parseList(lines, i, false); out.push(r.html); i = r.next; continue }
    if (/^\s*\d+\.\s+/.test(line)) { const r = parseList(lines, i, true); out.push(r.html); i = r.next; continue }
    // Paragraph: always consume the current line (parseTable already ruled it out as a
    // table header), then gather following lines until a blank, a new block, or a table.
    const buf: string[] = [lines[i]]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i]) && !isTableSep(lines[i + 1])) {
      buf.push(lines[i]); i++
    }
    out.push(`<p>${inlineMd(escapeHtml(buf.join(' ')))}</p>`)
  }
  return out.join('\n')
}

/** Print + screen CSS for a flowing document (report, letter, article). Warm-paper palette. */
const DOCUMENT_CSS = `:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#181818;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.doc{max-width:720px;margin:0 auto;padding:44px 48px}
h1,h2,h3,h4,h5,h6{line-height:1.25;font-weight:650;margin:1.6em 0 .55em}
h1{font-size:2em;margin-top:0}h2{font-size:1.5em}h3{font-size:1.22em}
p,ul,ol,blockquote,table,pre{margin:0 0 1em}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
code{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:#f3f2ee;padding:.12em .38em;border-radius:4px}
pre{background:#f6f5f1;padding:15px 18px;border-radius:8px;overflow:auto;border:1px solid #ece9e1}
pre code{background:none;padding:0}
blockquote{border-left:3px solid #d9d5cc;padding-left:16px;margin-left:0;color:#55514a}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e3ded4;padding:8px 12px;text-align:left}
th{background:#f6f5f1}
img{max-width:100%}
ul,ol{padding-left:1.4em}li{margin:.25em 0}
hr{border:none;border-top:1px solid #e3ded4;margin:2em 0}
@page{margin:0}`

/** Print + screen CSS for a slide deck: one full page per .slide, page-break between. */
const SLIDES_CSS = `:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#14110f;color:#181818;font:28px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.slide{width:100vw;height:100vh;padding:8vmin 10vmin;display:flex;flex-direction:column;justify-content:center;background:#fff;overflow:hidden;page-break-after:always;break-after:page}
.slide:last-child{page-break-after:auto;break-after:auto}
.slide h1{font-size:2.4em;line-height:1.1;margin:0 0 .35em}
.slide h2{font-size:1.7em;margin:0 0 .45em}
.slide h3{font-size:1.3em;margin:0 0 .4em}
.slide p{margin:0 0 .55em}
.slide ul,.slide ol{margin:.2em 0 0;padding-left:1.2em}.slide li{margin:.3em 0}
.slide code{font-family:"JetBrains Mono",ui-monospace,monospace;background:#f3f2ee;padding:.1em .3em;border-radius:4px;font-size:.82em}
.slide pre{background:#f6f5f1;padding:.7em 1em;border-radius:8px;overflow:auto;font-size:.66em}
.slide a{color:#2563eb}.slide img{max-width:100%}
@page{size:landscape;margin:0}`

/** A complete, self-contained HTML page: doctype, meta, an inline <style>, and body. */
function htmlDocument(title: string, styles: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${styles}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>'
  ].join('\n')
}

/** First ATX heading text in the markdown, for a default document/deck title. Empty if none. */
export function firstHeading(md: string): string {
  const m = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(md)
  return m ? m[1].trim() : ''
}

/** Render a flowing document (report/article/letter) to a full, print-ready HTML page. */
export function documentHtml(opts: { title?: string; markdown: string }): string {
  const title = (opts.title || firstHeading(opts.markdown) || 'Document').trim()
  const body = `<main class="doc">${markdownToHtml(opts.markdown)}</main>`
  return htmlDocument(title, DOCUMENT_CSS, body)
}

/**
 * Split slide-deck markdown into per-slide chunks on a horizontal-rule line
 * (`---`, `***`, or `___`, three-plus, alone on its line). Line-based so a leading,
 * trailing, or doubled separator collapses to nothing rather than a blank slide.
 */
export function splitSlides(markdown: string): string[] {
  const isRule = (l: string): boolean => /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(l)
  const chunks: string[] = []
  let buf: string[] = []
  for (const l of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (isRule(l)) {
      chunks.push(buf.join('\n'))
      buf = []
    } else {
      buf.push(l)
    }
  }
  chunks.push(buf.join('\n'))
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0)
}

/** Render a slide deck to a full, print-ready HTML page: one <section class="slide"> per chunk. */
export function slidesHtml(opts: { title?: string; markdown: string }): string {
  const chunks = splitSlides(opts.markdown)
  const slides = (chunks.length ? chunks : ['']).map(
    (c) => `<section class="slide">${markdownToHtml(c)}</section>`
  )
  const title = (opts.title || firstHeading(opts.markdown) || 'Slides').trim()
  return htmlDocument(title, SLIDES_CSS, slides.join('\n'))
}

/** Replace (or add) a path's extension: withExtension('a/b.md', 'pdf') → 'a/b.pdf'. Handles \\ and /. */
export function withExtension(path: string, ext: string): string {
  const clean = ext.replace(/^\./, '')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return `${path.slice(0, slash + 1)}${stem}.${clean}`
}




