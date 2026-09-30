import { describe, it, expect } from 'vitest'
import { buildDocx, buildXlsx, buildPptx } from './officegen'
import { parseBlocks, splitSlides, parseTabular } from './officegen-core'
import { checkArtifact } from './cowork-artifacts'

/**
 * Integration test: the real docx/exceljs/pptxgenjs engines must emit bytes that pass the
 * same {@link checkArtifact} byte validation the create_file tool runs before writing. This
 * is what proves "Myto builds a genuine Office file", not an empty stub — end to end.
 */
describe('officegen builders produce valid OOXML', () => {
  it('buildDocx → a real .docx', async () => {
    const bytes = await buildDocx(parseBlocks('# Report\n\nHello **world**.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |'))
    const check = checkArtifact('out.docx', bytes)
    expect(check.ok).toBe(true)
    expect(check.kind).toBe('docx')
  })

  it('buildXlsx → a real .xlsx', async () => {
    const bytes = await buildXlsx(parseTabular('Name,Score\nAda,99\nGrace,98'))
    const check = checkArtifact('out.xlsx', bytes)
    expect(check.ok).toBe(true)
    expect(check.kind).toBe('xlsx')
  })

  it('buildPptx → a real .pptx', async () => {
    const bytes = await buildPptx(splitSlides('# Intro\n\n- point one\n- point two\n\n---\n\n# Next\n\nbody'))
    const check = checkArtifact('out.pptx', bytes)
    expect(check.ok).toBe(true)
    expect(check.kind).toBe('pptx')
  })

  it('an empty deck still yields a valid single-slide .pptx', async () => {
    const bytes = await buildPptx(splitSlides(''))
    expect(checkArtifact('empty.pptx', bytes).ok).toBe(true)
  })
})
