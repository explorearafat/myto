import { describe, it, expect } from 'vitest'
import {
  MAX_RASTER_PAGES,
  DEFAULT_RASTER_SCALE,
  clampScale,
  parseRasterPages,
  dataUrlToChatImage,
  dataUrlsToChatImages,
  rasterCaption,
  rasterResultNote
} from './document-raster-core'

describe('clampScale', () => {
  it('keeps a value already in range', () => {
    expect(clampScale(2)).toBe(2)
    expect(clampScale(1)).toBe(1)
    expect(clampScale(3)).toBe(3)
    expect(clampScale(2.5)).toBe(2.5)
  })
  it('clamps below 1 and above 3', () => {
    expect(clampScale(0.2)).toBe(1)
    expect(clampScale(0)).toBe(1)
    expect(clampScale(9)).toBe(3)
  })
  it('falls back to the default for non-numbers', () => {
    expect(clampScale(undefined)).toBe(DEFAULT_RASTER_SCALE)
    expect(clampScale('2')).toBe(DEFAULT_RASTER_SCALE)
    expect(clampScale(NaN)).toBe(DEFAULT_RASTER_SCALE)
    expect(clampScale(Infinity)).toBe(DEFAULT_RASTER_SCALE)
  })
})

describe('parseRasterPages', () => {
  it('renders a single numeric page', () => {
    expect(parseRasterPages(4, 10)).toEqual([4])
  })
  it('accepts a numeric string', () => {
    expect(parseRasterPages('4', 10)).toEqual([4])
  })
  it('accepts a hyphen range', () => {
    expect(parseRasterPages('3-5', 10)).toEqual([3, 4, 5])
  })
  it('accepts a colon range', () => {
    expect(parseRasterPages('3:5', 10)).toEqual([3, 4, 5])
  })
  it('defaults to the first window when nothing is given', () => {
    expect(parseRasterPages(undefined, 100)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(parseRasterPages('', 100)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(parseRasterPages('junk', 100)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('never exceeds the total page count', () => {
    expect(parseRasterPages('1-50', 3)).toEqual([1, 2, 3])
    expect(parseRasterPages(9, 3)).toEqual([3])
  })
  it('caps the window at MAX_RASTER_PAGES', () => {
    const out = parseRasterPages('1-1000', 1000)
    expect(out).toHaveLength(MAX_RASTER_PAGES)
    expect(out[0]).toBe(1)
    expect(out[out.length - 1]).toBe(MAX_RASTER_PAGES)
  })
  it('clamps a start below 1 up to 1', () => {
    // A "0-2" range clamps the start to 1 while keeping the explicit end.
    expect(parseRasterPages('0-2', 10)).toEqual([1, 2])
    // A bare "-3" is not a valid range token, so it falls back to the default window.
    expect(parseRasterPages('-3', 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('collapses a reversed range to the start page', () => {
    // The regex only matches ascending "a-b"; a reversed "5-3" fails to match end<start guard.
    expect(parseRasterPages('5-3', 10)).toEqual([5])
  })
  it('always returns at least one page even for a 1-page doc', () => {
    expect(parseRasterPages(undefined, 1)).toEqual([1])
    expect(parseRasterPages(1, 1)).toEqual([1])
  })
  it('treats a zero/garbage total as a 1-page doc', () => {
    expect(parseRasterPages(1, 0)).toEqual([1])
    expect(parseRasterPages(3, Number.NaN)).toEqual([1])
  })
})

describe('dataUrlToChatImage', () => {
  it('parses a well-formed PNG data URL', () => {
    expect(dataUrlToChatImage('data:image/png;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      dataBase64: 'AAAA'
    })
  })
  it('lower-cases the media type and trims', () => {
    expect(dataUrlToChatImage('  data:image/JPEG;base64,ZZZZ  ')).toEqual({
      mediaType: 'image/jpeg',
      dataBase64: 'ZZZZ'
    })
  })
  it('returns null for a non-data URL', () => {
    expect(dataUrlToChatImage('https://example.com/x.png')).toBeNull()
    expect(dataUrlToChatImage('data:image/png;base64,')).toBeNull()
    expect(dataUrlToChatImage('')).toBeNull()
  })
})

describe('dataUrlsToChatImages', () => {
  it('maps the valid URLs and drops the malformed', () => {
    const out = dataUrlsToChatImages([
      'data:image/png;base64,AAAA',
      'nope',
      'data:image/png;base64,BBBB'
    ])
    expect(out).toEqual([
      { mediaType: 'image/png', dataBase64: 'AAAA' },
      { mediaType: 'image/png', dataBase64: 'BBBB' }
    ])
  })
  it('returns an empty array when none parse', () => {
    expect(dataUrlsToChatImages(['nope', ''])).toEqual([])
  })
})

describe('rasterCaption', () => {
  it('names a single page', () => {
    expect(rasterCaption('scan.pdf', [3])).toBe('scan.pdf — page 3')
  })
  it('names a page span', () => {
    expect(rasterCaption('scan.pdf', [3, 4, 5])).toBe('scan.pdf — pages 3–5')
  })
  it('falls back to the name for no pages', () => {
    expect(rasterCaption('scan.pdf', [])).toBe('scan.pdf')
  })
})

describe('rasterResultNote', () => {
  it('tells the model the pages are attached as vision', () => {
    const note = rasterResultNote('scan.pdf', [1, 2], true)
    expect(note).toMatch(/attached/i)
    expect(note).toMatch(/vision/i)
    expect(note).toContain('pages 1–2')
  })
  it('is honest when no vision input is wired', () => {
    const note = rasterResultNote('scan.pdf', [1], false)
    expect(note).toMatch(/no vision input|could not be shown/i)
    expect(note).toMatch(/vision-capable/i)
  })
})
