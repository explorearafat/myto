import { describe, it, expect } from 'vitest'
import { checkArtifact, kindFromPath, type ArtifactKind } from './cowork-artifacts'

/**
 * Build a byte buffer from a list of ASCII chunks and/or raw byte arrays — lets a
 * test assemble a minimal fake OOXML/PDF/zip without a real library.
 */
function bytes(...parts: Array<string | number[]>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0) & 0xff) : p))
  return Uint8Array.from(chunks.flat())
}

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04] // PK\x03\x04
const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06] // PK\x05\x06

/** A minimal but structurally-valid OOXML package for the given kind. */
function ooxml(mainPart: string): Uint8Array {
  return bytes(ZIP_LOCAL, '[Content_Types].xml', '...', mainPart, '...', ZIP_EOCD)
}

describe('kindFromPath', () => {
  const cases: Array<[string, ArtifactKind]> = [
    ['report.xlsx', 'xlsx'],
    ['deck.PPTX', 'pptx'],
    ['C:/work/Letter.docx', 'docx'],
    ['out/summary.pdf', 'pdf'],
    ['bundle.zip', 'zip'],
    ['notes.txt', 'unknown'],
    ['README', 'unknown']
  ]
  for (const [path, kind] of cases) {
    it(`maps ${path} → ${kind}`, () => expect(kindFromPath(path)).toBe(kind))
  }
})

describe('checkArtifact — empty & unknown', () => {
  it('rejects an empty file', () => {
    const r = checkArtifact('report.xlsx', new Uint8Array(0))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/empty/i)
  })
  it('passes an unknown type as present-and-non-empty without deep-checking', () => {
    const r = checkArtifact('notes.txt', bytes('hello world'))
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('unknown')
    expect(r.detail).toMatch(/non-empty/i)
  })
})

describe('checkArtifact — PDF', () => {
  it('accepts a header + %%EOF trailer', () => {
    const r = checkArtifact('out.pdf', bytes('%PDF-1.7\n', 'body', '\n%%EOF\n'))
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/Valid PDF/)
  })
  it('rejects a missing %%EOF as truncated', () => {
    const r = checkArtifact('out.pdf', bytes('%PDF-1.7\n', 'body but never closed'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/Truncated PDF/i)
  })
  it('rejects a wrong header', () => {
    const r = checkArtifact('out.pdf', bytes('not a pdf at all'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/Not a PDF/i)
  })
  it('names a saved traceback as the reason', () => {
    const r = checkArtifact('out.pdf', bytes('Traceback (most recent call last):\n  File ...\nModuleNotFoundError: reportlab'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/Traceback/)
  })
})

describe('checkArtifact — OOXML', () => {
  it('accepts a valid xlsx', () => {
    const r = checkArtifact('report.xlsx', ooxml('xl/workbook.xml'))
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/Valid xlsx/)
  })
  it('accepts a valid pptx and docx', () => {
    expect(checkArtifact('deck.pptx', ooxml('ppt/presentation.xml')).ok).toBe(true)
    expect(checkArtifact('letter.docx', ooxml('word/document.xml')).ok).toBe(true)
  })
  it('rejects non-zip bytes under an .xlsx name', () => {
    const r = checkArtifact('report.xlsx', bytes('<html>oops, wrote a webpage</html>'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/missing the ZIP signature|Office/i)
  })
  it('names the Store-alias stub piped into the file', () => {
    const r = checkArtifact('report.xlsx', bytes('Python was not found; run without arguments to install from the Microsoft Store'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/was not found/)
  })
  it('rejects an empty zip container', () => {
    const r = checkArtifact('report.xlsx', bytes(ZIP_EOCD))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/Empty xlsx/i)
  })
  it('rejects a zip that is truncated before its central directory', () => {
    const r = checkArtifact('report.xlsx', bytes(ZIP_LOCAL, '[Content_Types].xml', 'xl/workbook.xml'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/Truncated xlsx/i)
  })
  it('rejects a zip with no [Content_Types].xml', () => {
    const r = checkArtifact('report.xlsx', bytes(ZIP_LOCAL, 'xl/workbook.xml', ZIP_EOCD))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/\[Content_Types\]\.xml/)
  })
  it('flags a mislabelled type (docx bytes named .xlsx)', () => {
    const r = checkArtifact('report.xlsx', ooxml('word/document.xml'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/actually a docx/i)
  })
  it('rejects an OOXML package missing its main part entirely', () => {
    const r = checkArtifact('report.xlsx', bytes(ZIP_LOCAL, '[Content_Types].xml', 'docProps/core.xml', ZIP_EOCD))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/missing its main part/i)
  })
})

describe('checkArtifact — zip', () => {
  it('accepts a plain zip with an end-of-central-directory record', () => {
    const r = checkArtifact('bundle.zip', bytes(ZIP_LOCAL, 'a.txt', 'contents', ZIP_EOCD))
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/Valid ZIP/i)
  })
})
