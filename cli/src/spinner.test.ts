import { describe, it, expect } from 'vitest'
import { spinnerFrame, spinnerLine } from './spinner'
import { stripAnsi } from './ui'

describe('spinnerFrame', () => {
  it('cycles through frames and wraps both ways', () => {
    expect(spinnerFrame(0)).toBe(spinnerFrame(6)) // 6 frames → wraps to the first
    expect(spinnerFrame(-1)).toBe(spinnerFrame(5))
  })
  it('always returns a non-empty glyph', () => {
    for (let i = 0; i < 12; i++) expect(spinnerFrame(i).length).toBeGreaterThan(0)
  })
})

describe('spinnerLine', () => {
  it('renders the verb, elapsed seconds and hint', () => {
    const out = stripAnsi(spinnerLine('✻', 'Thinking', 3, 'esc to interrupt'))
    expect(out).toContain('Thinking')
    expect(out).toContain('3s')
    expect(out).toContain('esc to interrupt')
  })
  it('omits the seconds until one has elapsed', () => {
    const out = stripAnsi(spinnerLine('✻', 'Thinking', 0, 'hint'))
    expect(out).not.toContain('0s')
  })
})
