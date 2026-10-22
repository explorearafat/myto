import { describe, it, expect } from 'vitest'
import { buildVideoPlan } from './useStudioBake'
import { neutralVideoEdit, type ManualVideoEdit } from '../store/useEditorStore'

function edit(patch: Partial<ManualVideoEdit>): ManualVideoEdit {
  return { ...neutralVideoEdit(20), ...patch }
}

describe('buildVideoPlan', () => {
  it('emits no ops for a neutral edit of the whole clip', () => {
    const plan = buildVideoPlan('clips/raw.mp4', neutralVideoEdit(20), 20)
    expect(plan.input).toBe('clips/raw.mp4')
    expect(plan.operations).toEqual([])
  })

  it('emits a trim only when the range is tightened', () => {
    const plan = buildVideoPlan('a.mp4', edit({ trim: { start: 2, end: 10 } }), 20)
    expect(plan.operations).toContainEqual({ op: 'trim', start: 2, end: 10 })
  })

  it('emits speed, filter, reframe, mute, and captions', () => {
    const v = edit({
      speed: 1.5,
      filter: 'cinematic',
      aspect: '9:16',
      mute: true,
      texts: [{ id: 't1', text: 'Hi', startSec: 0, endSec: 3, y: 'bottom', box: true, color: '#fff' }]
    })
    const plan = buildVideoPlan('a.mp4', v, 20)
    const ops = plan.operations.map((o) => o.op)
    expect(ops).toContain('speed')
    expect(ops).toContain('filter')
    expect(ops).toContain('resize')
    expect(ops).toContain('mute')
    expect(ops).toContain('text')
    // Mute wins over an explicit volume (never both).
    expect(ops).not.toContain('volume')
  })

  it('emits volume when not muted and volume ≠ 100', () => {
    const plan = buildVideoPlan('a.mp4', edit({ volume: 50 }), 20)
    expect(plan.operations).toContainEqual({ op: 'volume', factor: 0.5 })
  })

  it('skips blank captions', () => {
    const plan = buildVideoPlan('a.mp4', edit({ texts: [{ id: 't', text: '   ', startSec: 0, endSec: 3, y: 'top', box: false, color: '#fff' }] }), 20)
    expect(plan.operations.find((o) => o.op === 'text')).toBeUndefined()
  })
})
