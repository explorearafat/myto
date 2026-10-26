import { describe, it, expect } from 'vitest'
import { faceRows, faceLines, faceLinesBlink, dashboardLine } from './face'
import { stripAnsi } from './ui'

describe('faceRows', () => {
  it('draws a face of dots, hashes and slashes with MYTO in the middle', () => {
    const rows = faceRows()
    const joined = rows.join('\n')
    expect(rows.length).toBeGreaterThan(6)
    expect(joined).toContain('·') // halo dots
    expect(joined).toContain('######') // hash eyes
    expect(joined).toContain('\\') // slash smile
    expect(joined).toContain('M  Y  T  O') // the wordmark mid-face
    // The wordmark sits between the eyes and the smile.
    const eyes = rows.findIndex((r) => r.includes('######'))
    const word = rows.findIndex((r) => r.includes('M  Y  T  O'))
    const mouth = rows.findIndex((r) => r.includes('\\─'))
    expect(eyes).toBeLessThan(word)
    expect(word).toBeLessThan(mouth)
  })
  it('has uniform visible width per row (a clean box)', () => {
    const widths = new Set(faceRows().map((r) => r.length))
    expect(widths.size).toBe(1)
  })
})

describe('faceLines', () => {
  it('keeps the visible text identical to the plain rows', () => {
    const colored = faceLines().map(stripAnsi)
    expect(colored).toEqual(faceRows())
  })
  it('blink closes the eyes and opens them again', () => {
    const open = stripAnsi(faceLines()[3])
    const shut = stripAnsi(faceLinesBlink()[3])
    expect(open).toContain('######')
    expect(shut).not.toContain('######')
  })
})

describe('dashboardLine', () => {
  it('shows folder, model and provider — and nothing else', () => {
    const out = stripAnsi(dashboardLine({ workspace: '/work/project', model: 'gpt-4o-mini', provider: 'gateway' }))
    expect(out).toContain('/work/project')
    expect(out).toContain('gpt-4o-mini')
    expect(out).toContain('gateway')
  })
})
