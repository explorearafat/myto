/*
 * A small terminal markdown renderer for the Myto CLI — the final agent answer
 * (and MYTO.md) are printed as real markdown: headings, lists, quotes, rules,
 * fenced code with a tint pass, and inline bold/italic/code/links. Pure string
 * composition: colour degrades cleanly via the shared `paint` (NO_COLOR / non-TTY),
 * and every helper is testable through `stripAnsi`.
 */
import { paint as c, colorOn } from './ui'

/** A featherweight syntax tint for code lines (keywords + strings + numbers). */
export function tintCode(s: string): string {
  if (!colorOn) return s
  return s
    .replace(
      /\b(const|let|var|function|return|import|from|export|async|await|if|else|for|while|class|new|type|interface|def|public|private|true|false|null|undefined)\b/g,
      (m) => c.magenta(m)
    )
    .replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, (m) => c.green(m))
    .replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => c.amber(m))
}

/** Inline pass: bold, italic, inline code and links. Code spans skip other rules. */
export function renderInline(s: string): string {
  if (!s) return s
  // Split on inline code first so its contents are left untouched.
  const parts = s.split(/(`[^`]+`)/g)
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return c.magenta(part.slice(1, -1))
      }
      return part
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
          c.underline(text) + (colorOn ? c.dim(` (${url})`) : ` (${url})`)
        )
        .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => c.bold(t))
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, pre: string, t: string) => `${pre}${c.italic(t)}`)
        .replace(/(^|[\s(])_([^_\s][^_]*)_/g, (_, pre: string, t: string) => `${pre}${c.italic(t)}`)
    })
    .join('')
}

/** Wrap `text` to `width` visible columns on word boundaries (no ANSI input). */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text]
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (!line.length) line = w
    else if (line.length + 1 + w.length <= width) line += ' ' + w
    else {
      lines.push(line)
      line = w
    }
  }
  if (line.length) lines.push(line)
  return lines.length ? lines : ['']
}

/** Longest common indentation of a block's non-empty lines. */
function commonIndent(lines: string[]): number {
  let min = Infinity
  for (const l of lines) {
    if (!l.trim()) continue
    min = Math.min(min, l.length - l.trimStart().length)
  }
  return Number.isFinite(min) ? min : 0
}

/**
 * Render a markdown string for the terminal. Line-oriented: fenced blocks, ATX
 * headings, bullet/numbered lists, blockquotes, horizontal rules; everything
 * else is a wrapped paragraph.
 */
export function renderMarkdown(src: string, opts?: { width?: number }): string {
  const width = Math.max(40, Math.min(opts?.width ?? process.stdout.columns ?? 96, 104))
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length === 0) return
    const text = para.join(' ').trim()
    if (text) for (const l of wrapText(renderInline(text), width - 2)) out.push(l)
    para = []
  }

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trimEnd()

    // Fenced code block — collect until the closing fence.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      i++
      const code: string[] = []
      while (i < lines.length && !/^```\s*$/.test(lines[i].trimEnd())) {
        code.push(lines[i])
        i++
      }
      i++ // skip the closing fence (or run off the end for truncated input)
      if (code.length > 0) {
        const lang = fence[1] ? c.gray(fence[1]) : ''
        out.push(c.gray('  ┌' + (lang ? `─ ${lang} ` : '') + '─'.repeat(Math.max(0, width - (lang ? 8 : 4))) + '┐'))
        for (const l of code) {
          const body = l.length > width - 8 ? l.slice(0, Math.max(0, width - 9)) + '…' : l
          out.push(`  ${c.gray('│')} ${tintCode(body)}`)
        }
        out.push(c.gray('  └' + '─'.repeat(width - 4) + '┘'))
      }
      continue
    }

    // Heading.
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      i++
      const level = h[1].length
      const text = renderInline(h[2])
      if (level <= 1) out.push(`\n${c.bold(c.violet(text))}\n`)
      else if (level === 2) out.push(`\n${c.bold(c.cyan(text))}\n`)
      else out.push(`\n${c.bold(text)}\n`)
      continue
    }

    // Horizontal rule.
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      flushPara()
      i++
      out.push('\n' + c.gray('─'.repeat(Math.min(width, 48))) + '\n')
      continue
    }

    // Blockquote.
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      flushPara()
      i++
      for (const l of wrapText(renderInline(q[1]), width - 6)) out.push(`${c.violet('▏')} ${c.dim(l)}`)
      continue
    }

    // Bullet list (supports simple nesting by indentation).
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushPara()
      i++
      const depth = Math.min(2, Math.floor(bullet[1].length / 2))
      const text = renderInline(bullet[2])
      const pad = '  '.repeat(depth + 1)
      const wrapped = wrapText(text, width - pad.length - 2)
      out.push(`${pad}${c.cyan(depth ? '◦' : '•')} ${wrapped.shift() ?? ''}`)
      for (const extra of wrapped) out.push(pad + '  ' + extra)
      continue
    }

    // Numbered list.
    const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (num) {
      flushPara()
      i++
      const text = renderInline(num[3])
      const pad = '  '
      const wrapped = wrapText(text, width - pad.length - 4)
      out.push(`${pad}${c.cyan(num[2] + '.')} ${wrapped.shift() ?? ''}`)
      for (const extra of wrapped) out.push(pad + '    ' + extra)
      continue
    }

    // Blank line — close the paragraph.
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }

    // Indented block (4 spaces) is treated as plain code, like CommonMark.
    if (/^ {4,}\S/.test(raw)) {
      flushPara()
      i++
      const block: string[] = [raw.replace(/^ {4}/, '')]
      while (i + 1 < lines.length && /^ {4,}\S/.test(lines[i + 1])) {
        block.push(lines[i + 1].replace(/^ {4}/, ''))
        i++
      }
      const dedent = commonIndent(block)
      for (const l of block) out.push(`  ${c.gray('│')} ${tintCode(l.slice(dedent))}`)
      continue
    }

    para.push(line.trim())
    i++
  }
  flushPara()
  return out.join('\n')
}
