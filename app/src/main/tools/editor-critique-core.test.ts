import { describe, it, expect } from 'vitest'
import {
  extractJsonObject,
  parseCritiqueResponse,
  buildCritiqueUser,
  CRITIQUE_SYSTEM
} from './editor-critique-core'
import type { StudioCritiqueRequest } from '../../shared/types'

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })
  it('reads an object wrapped in prose + fences', () => {
    const text = 'Sure!\n```json\n{"done": true, "note": "looks good"}\n```\nthanks'
    expect(extractJsonObject(text)).toBe('{"done": true, "note": "looks good"}')
  })
  it('handles nested braces and braces inside strings', () => {
    const text = 'x {"a": {"b": 2}, "s": "has } brace"} y'
    expect(extractJsonObject(text)).toBe('{"a": {"b": 2}, "s": "has } brace"}')
  })
  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{ unbalanced')).toBeNull()
  })
})

describe('parseCritiqueResponse (photo)', () => {
  it('reads done=true with no adjust', () => {
    const r = parseCritiqueResponse('photo', '{"done": true, "note": "warm and bright, matches"}')
    expect(r).not.toBeNull()
    expect(r!.done).toBe(true)
    expect(r!.note).toContain('matches')
    expect(r!.adjust).toBeUndefined()
  })
  it('reads a corrected full adjust when not done', () => {
    const text = '{"done": false, "note": "needs more warmth", "adjust": {"temp": 30, "exposure": 10, "vibrance": 20}}'
    const r = parseCritiqueResponse('photo', text)
    expect(r!.done).toBe(false)
    expect(r!.adjust).toBeDefined()
    expect(r!.adjust!.temp).toBe(30)
    expect(r!.adjust!.exposure).toBe(10)
    // Unspecified fields fall back to neutral (0) via validatePhotoAdjust.
    expect(r!.adjust!.contrast).toBe(0)
  })
  it('clamps out-of-range adjust values', () => {
    const r = parseCritiqueResponse('photo', '{"done": false, "adjust": {"temp": 999}}')
    expect(r!.adjust!.temp).toBe(100)
  })
  it('returns null on non-JSON', () => {
    expect(parseCritiqueResponse('photo', 'the image looks fine to me')).toBeNull()
  })
})

describe('parseCritiqueResponse (video)', () => {
  it('reads a corrected plan and injects the fallback input', () => {
    const text = '{"done": false, "note": "trim the start", "plan": {"operations": [{"op": "trim", "start": 2, "end": 10}]}}'
    const r = parseCritiqueResponse('video', text, 'clips/raw.mp4')
    expect(r!.done).toBe(false)
    expect(r!.plan).toBeDefined()
    expect(r!.plan!.input).toBe('clips/raw.mp4')
    expect(r!.plan!.operations[0]).toMatchObject({ op: 'trim', start: 2, end: 10 })
  })
  it('drops an invalid plan (no operations) but keeps the note', () => {
    const r = parseCritiqueResponse('video', '{"done": false, "note": "hmm", "plan": {"operations": []}}', 'a.mp4')
    expect(r!.note).toBe('hmm')
    expect(r!.plan).toBeUndefined()
  })
})

describe('buildCritiqueUser', () => {
  it('includes the goal, the pass number, and the current edit', () => {
    const req: StudioCritiqueRequest = {
      goal: 'make it cinematic',
      kind: 'photo',
      resultPreview: 'data:image/jpeg;base64,xxx',
      current: {
        exposure: 5, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
        temp: 0, tint: 0, vibrance: 0, saturation: 0, clarity: 0, sharpen: 0, vignette: 0
      },
      pass: 2
    }
    const user = buildCritiqueUser(req)
    expect(user).toContain('make it cinematic')
    expect(user).toContain('pass 2')
    expect(user).toContain('"exposure":5')
  })
  it('system prompt names the JSON contract', () => {
    expect(CRITIQUE_SYSTEM).toContain('done')
    expect(CRITIQUE_SYSTEM).toContain('adjust')
    expect(CRITIQUE_SYSTEM).toContain('plan')
  })
})
