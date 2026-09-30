import { describe, it, expect } from 'vitest'
import {
  classifyByExtension,
  paginateText,
  inventory,
  isSmallDoc,
  pageWindow,
  formatPages,
  outline,
  searchPages,
  cacheKey,
  estimateTokens,
  PAGE_CHARS,
  SMALL_MAX_PAGES,
  TOKEN_BUDGET,
  OUTLINE_MAX_PAGES,
  type PageText
} from './document-read-core'

/** Build N virtual pages each filled with `per` chars of the letter 'a'. */
function pages(n: number, per = 10): PageText[] {
  return Array.from({ length: n }, (_, i) => ({ page: i + 1, text: 'a'.repeat(per) }))
}

describe('classifyByExtension', () => {
  it('maps known extensions, case-insensitively, ignoring trailing space', () => {
    expect(classifyByExtension('report.pdf')).toBe('pdf')
    expect(classifyByExtension('/a/b/NOTES.MD')).toBe('text')
    expect(classifyByExtension('data.CSV ')).toBe('text')
    expect(classifyByExtension('sheet.xlsx')).toBe('xlsx')
    expect(classifyByExtension('deck.pptx')).toBe('pptx')
    expect(classifyByExtension('memo.docx')).toBe('docx')
    expect(classifyByExtension('photo.JPEG')).toBe('image')
    expect(classifyByExtension('main.ts')).toBe('text')
  })
  it('returns unknown for no/odd extension', () => {
    expect(classifyByExtension('Makefile')).toBe('unknown')
    expect(classifyByExtension('archive.tar.zst')).toBe('unknown')
  })
})

describe('paginateText', () => {
  it('slices into uniform PAGE_CHARS pages, 1-based', () => {
    const text = 'x'.repeat(PAGE_CHARS * 2 + 5)
    const p = paginateText(text)
    expect(p).toHaveLength(3)
    expect(p[0]).toEqual({ page: 1, text: 'x'.repeat(PAGE_CHARS) })
    expect(p[2]).toEqual({ page: 3, text: 'x'.repeat(5) })
  })
  it('returns a single empty page for empty input', () => {
    expect(paginateText('')).toEqual([{ page: 1, text: '' }])
  })
})

describe('inventory + isSmallDoc', () => {
  it('sums chars and flags a text layer when enough pages have text', () => {
    const inv = inventory('pdf', pages(4, 100))
    expect(inv).toMatchObject({ kind: 'pdf', pages: 4, chars: 400, hasTextLayer: true })
    expect(isSmallDoc(inv)).toBe(true)
  })
  it('marks a mostly-blank PDF as having no text layer (scanned)', () => {
    const scanned: PageText[] = [
      { page: 1, text: 'title' },
      ...Array.from({ length: 9 }, (_, i) => ({ page: i + 2, text: '' }))
    ]
    expect(inventory('pdf', scanned).hasTextLayer).toBe(false)
  })
  it('is not small when it has too many pages', () => {
    expect(isSmallDoc(inventory('pdf', pages(SMALL_MAX_PAGES + 1, 1)))).toBe(false)
  })
  it('is not small when it exceeds the token budget', () => {
    const big = [{ page: 1, text: 'a'.repeat((TOKEN_BUDGET + 1) * 4) }]
    expect(isSmallDoc(inventory('text', big))).toBe(false)
  })
  it('empty page set has no text layer', () => {
    expect(inventory('pdf', []).hasTextLayer).toBe(false)
  })
})

describe('pageWindow', () => {
  const p = pages(10)
  it('clamps to range and is inclusive', () => {
    expect(pageWindow(p, 3, 5).map((x) => x.page)).toEqual([3, 4, 5])
    expect(pageWindow(p, -2, 2).map((x) => x.page)).toEqual([1, 2])
    expect(pageWindow(p, 8, 999).map((x) => x.page)).toEqual([8, 9, 10])
  })
  it('swaps reversed bounds and defaults end to start', () => {
    expect(pageWindow(p, 5, 3).map((x) => x.page)).toEqual([3, 4, 5])
    expect(pageWindow(p, 4, NaN).map((x) => x.page)).toEqual([4])
  })
})

describe('formatPages', () => {
  it('joins pages with markers under the label', () => {
    const out = formatPages(pages(2, 5), 'doc.pdf — 2 pages')
    expect(out).toContain('[doc.pdf — 2 pages]')
    expect(out).toContain('--- Page 1 ---')
    expect(out).toContain('--- Page 2 ---')
  })
  it('truncates and hints read_pages when over the cap', () => {
    const out = formatPages(pages(50, 500), 'big.pdf — 50 pages', 600)
    expect(out).toContain('truncated at page')
    expect(out).toContain('read_pages')
  })
  it('notes an empty (scanned) page', () => {
    const out = formatPages([{ page: 1, text: '   ' }], 'scan.pdf — 1 page')
    expect(out).toContain('no text layer')
  })
})

describe('outline', () => {
  it('previews each page and caps the list with a note', () => {
    const out = outline(pages(OUTLINE_MAX_PAGES + 5, 3))
    expect(out).toContain('p1: aaa')
    expect(out).toContain(`and 5 more pages`)
  })
})

describe('searchPages', () => {
  const docs: PageText[] = [
    { page: 1, text: 'The refund policy is generous.' },
    { page: 2, text: 'No mention here.' },
    { page: 3, text: 'Another refund note follows.' }
  ]
  it('finds case-insensitive hits with page + snippet', () => {
    const hits = searchPages(docs, 'REFUND')
    expect(hits.map((h) => h.page)).toEqual([1, 3])
    expect(hits[0].snippet.toLowerCase()).toContain('refund')
  })
  it('returns nothing for an empty query or no match', () => {
    expect(searchPages(docs, '   ')).toEqual([])
    expect(searchPages(docs, 'zzz')).toEqual([])
  })
})

describe('estimateTokens + cacheKey', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(10)).toBe(3)
  })
  it('builds a stable key from path+mtime+size, rounding mtime', () => {
    expect(cacheKey('/a/b.pdf', 123.7, 42)).toBe('/a/b.pdf::124::42')
  })
})
