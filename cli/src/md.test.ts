import { describe, it, expect } from 'vitest'
import { stripAnsi } from './ui'
import { renderMarkdown, renderInline, wrapText, tintCode } from './md'

const plain = (s: string): string => stripAnsi(s)

describe('renderMarkdown', () => {
  it('renders headings as standalone emphasised lines', () => {
    const out = plain(renderMarkdown('# Title\n\n## Section\n\nbody'))
    expect(out).toContain('Title')
    expect(out).toContain('Section')
    expect(out).toContain('body')
  })

  it('renders fenced code between rules with the language tag', () => {
    const out = plain(renderMarkdown('```ts\nconst a = 1\n```'))
    expect(out).toContain('ts')
    expect(out).toContain('const a = 1')
    expect(out).toContain('┌')
    expect(out).toContain('└')
  })

  it('renders bullet and numbered lists', () => {
    const out = plain(renderMarkdown('- first\n- second\n\n1. one\n2. two'))
    expect(out).toContain('•')
    expect(out).toContain('first')
    expect(out).toContain('1.')
    expect(out).toContain('two')
  })

  it('renders blockquotes with a bar', () => {
    const out = plain(renderMarkdown('> quoted thought'))
    expect(out).toContain('▏')
    expect(out).toContain('quoted thought')
  })

  it('keeps inline code verbatim inside fences', () => {
    const out = plain(renderMarkdown('```\n**not bold** `x`\n```'))
    expect(out).toContain('**not bold**')
    expect(out).toContain('`x`')
  })

  it('applies inline styles to paragraphs', () => {
    const out = plain(renderMarkdown('this is **bold** and `code` here'))
    expect(out).toContain('bold')
    expect(out).toContain('code')
  })

  it('wraps long paragraphs to the width', () => {
    const out = renderMarkdown('word '.repeat(60), { width: 40 })
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(40)
  })
})

describe('renderInline', () => {
  it('styles bold and italic but keeps text', () => {
    expect(stripAnsi(renderInline('a **b** c'))).toBe('a b c')
    expect(stripAnsi(renderInline('an *it* word'))).toBe('an it word')
  })
  it('extracts links as text + dim url', () => {
    const out = plain(renderInline('[docs](https://x.y)'))
    expect(out).toContain('docs')
    expect(out).toContain('https://x.y')
  })
  it('leaves inline code untouched by other rules', () => {
    expect(stripAnsi(renderInline('`a *b* c`'))).toBe('a *b* c')
  })
})

describe('wrapText', () => {
  it('returns one line when short', () => {
    expect(wrapText('short', 40)).toEqual(['short'])
  })
  it('splits on words within the width', () => {
    const lines = wrapText('aaa bbb ccc ddd', 7)
    expect(lines.length).toBe(2)
    expect(lines[0].length).toBeLessThanOrEqual(7)
  })
})

describe('tintCode', () => {
  it('keeps plain text readable without colour', () => {
    expect(stripAnsi(tintCode('const x = 1'))).toBe('const x = 1')
  })
})
