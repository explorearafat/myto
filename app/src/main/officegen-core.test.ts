import { describe, it, expect } from 'vitest'
import {
  formatFromPath, parseInline, stripInline, parseBlocks, splitSlides, parseTabular, parseCsvLine
} from './officegen-core'

describe('formatFromPath', () => {
  it('maps known extensions (case-insensitive) and aliases', () => {
    expect(formatFromPath('a/b/report.DOCX')).toBe('docx')
    expect(formatFromPath('data.tsv')).toBe('csv')
    expect(formatFromPath('notes.markdown')).toBe('md')
    expect(formatFromPath('page.htm')).toBe('html')
  })
  it('returns unknown for missing/odd extensions', () => {
    expect(formatFromPath('Makefile')).toBe('unknown')
    expect(formatFromPath('archive.rar')).toBe('unknown')
  })
})

describe('parseInline', () => {
  it('splits bold / italic / code, keeping plain runs between', () => {
    expect(parseInline('a **b** c *d* `e`')).toEqual([
      { text: 'a ' }, { text: 'b', bold: true }, { text: ' c ' },
      { text: 'd', italic: true }, { text: ' ' }, { text: 'e', code: true }
    ])
  })
  it('returns a single plain run when there is no emphasis', () => {
    expect(parseInline('just text')).toEqual([{ text: 'just text' }])
  })
})

describe('stripInline', () => {
  it('removes emphasis markers', () => {
    expect(stripInline('**bold** and _italic_ and `code`')).toBe('bold and italic and code')
  })
})

describe('parseBlocks', () => {
  it('parses headings, paragraphs, and both list kinds', () => {
    const blocks = parseBlocks('# Title\n\nA para\nline two\n\n- one\n- two\n\n1. first\n2. second')
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, runs: [{ text: 'Title' }] })
    expect(blocks[1]).toEqual({ type: 'paragraph', runs: [{ text: 'A para line two' }] })
    expect(blocks[2]).toMatchObject({ type: 'bullets', ordered: false })
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2)
    expect(blocks[3]).toMatchObject({ type: 'bullets', ordered: true })
  })

  it('parses a GFM table and a fenced code block', () => {
    const blocks = parseBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode line\n```')
    expect(blocks[0]).toEqual({ type: 'table', header: ['A', 'B'], rows: [['1', '2']] })
    expect(blocks[1]).toEqual({ type: 'code', text: 'code line' })
  })
})

describe('splitSlides', () => {
  it('splits on --- and takes the first heading as the title', () => {
    const slides = splitSlides('# One\n\n- a\n- b\n\n---\n\n# Two\n\nbody line')
    expect(slides).toEqual([
      { title: 'One', bullets: ['a', 'b'] },
      { title: 'Two', bullets: ['body line'] }
    ])
  })
  it('always yields at least one slide with a fallback title', () => {
    expect(splitSlides('')).toEqual([{ title: 'Slide', bullets: [] }])
  })
})

describe('parseCsvLine', () => {
  it('honours quoted fields and "" escapes', () => {
    expect(parseCsvLine('a,"b,c","d""e"')).toEqual(['a', 'b,c', 'd"e'])
  })
})

describe('parseTabular', () => {
  it('reads a Markdown table as a grid', () => {
    expect(parseTabular('| A | B |\n|---|---|\n| 1 | 2 |')).toEqual([['A', 'B'], ['1', '2']])
  })
  it('falls back to CSV rows', () => {
    expect(parseTabular('a,b\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })
})
