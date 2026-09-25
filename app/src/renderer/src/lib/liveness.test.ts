import { describe, it, expect } from 'vitest'
import { livenessNote, STALL_WARN_MS, STALL_ALARM_MS } from './liveness'

describe('livenessNote', () => {
  it('is null while output is flowing (idle below the warn threshold)', () => {
    expect(livenessNote(0)).toBeNull()
    expect(livenessNote(STALL_WARN_MS - 1)).toBeNull()
  })

  it('shows a calm "still working" note once output goes quiet', () => {
    const note = livenessNote(STALL_WARN_MS)
    expect(note).toMatch(/still working/i)
    expect(note).toMatch(/15s/)
  })

  it('reports the quiet duration in whole seconds', () => {
    expect(livenessNote(20_000)).toBe('still working · no new output for 20s')
    expect(livenessNote(42_500)).toBe('still working · no new output for 42s')
  })

  it('escalates to a stall warning past the alarm threshold', () => {
    const note = livenessNote(STALL_ALARM_MS)
    expect(note).toMatch(/may have stalled/i)
    expect(note).toMatch(/60s/)
    expect(note).not.toMatch(/still working/i)
  })

  it('keeps counting up in the alarm band', () => {
    expect(livenessNote(90_000)).toBe('no new output for 90s — the model may have stalled')
  })
})
