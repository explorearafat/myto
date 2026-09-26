import { describe, expect, it } from 'vitest'
import {
  looksLikeUnsavedCode,
  MIN_UNSAVED_CODE_LINES,
  detectOscillation,
  looksLikeContinuationRequest,
  OSCILLATION_WINDOW,
  OSCILLATION_MAX
} from './cowork-guards'

/**
 * Build a fenced code block whose *captured body* is exactly `segments` lines long
 * (the capture is everything between the opening fence's newline and the closing
 * fence). `looksLikeUnsavedCode` counts that body's `split('\n').length`, so this lets
 * a test sit exactly on the {@link MIN_UNSAVED_CODE_LINES} threshold.
 */
const fence = (segments: number, lang = ''): string => {
  const body = Array.from({ length: segments }, (_, i) => `line${i}`).join('\n')
  return '```' + lang + '\n' + body + '```'
}

describe('looksLikeUnsavedCode', () => {
  it('is true for a fenced block at the line threshold', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES))).toBe(true)
  })

  it('is true for a fenced block well over the threshold', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES + 20))).toBe(true)
  })

  it('is false for a fenced block one line under the threshold', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES - 1))).toBe(false)
  })

  it('is false for prose with no code fence', () => {
    expect(looksLikeUnsavedCode('Here is how I would approach it, step by step.')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(looksLikeUnsavedCode('')).toBe(false)
  })

  it('detects a block regardless of the language tag', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES, 'python'))).toBe(true)
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES, 'ts'))).toBe(true)
  })

  it('ignores several short blocks but catches one long block among them', () => {
    const short = `${fence(3)}\nsome prose in between\n${fence(4)}`
    expect(looksLikeUnsavedCode(short)).toBe(false)
    expect(looksLikeUnsavedCode(`${fence(3)}\n${fence(MIN_UNSAVED_CODE_LINES + 5)}`)).toBe(true)
  })

  it('does not leak regex state between calls (fresh matcher each time)', () => {
    const big = fence(MIN_UNSAVED_CODE_LINES + 5)
    expect(looksLikeUnsavedCode(big)).toBe(true)
    expect(looksLikeUnsavedCode(big)).toBe(true)
  })
})

describe('detectOscillation', () => {
  const opts = { window: OSCILLATION_WINDOW, maxRepeatsInWindow: OSCILLATION_MAX }

  it('returns null for an empty or too-short history', () => {
    expect(detectOscillation([], opts)).toBeNull()
    expect(detectOscillation(['a', 'a'], opts)).toBeNull() // below the max of 3
  })

  it('returns null when every call is distinct', () => {
    expect(detectOscillation(['a', 'b', 'c', 'd', 'e'], opts)).toBeNull()
  })

  it('detects three consecutive identical calls', () => {
    expect(detectOscillation(['a', 'a', 'a'], opts)).toEqual({ sig: 'a', count: 3 })
  })

  it('detects a NON-consecutive ping-pong the consecutive guard misses (A,B,A,B,A)', () => {
    expect(detectOscillation(['a', 'b', 'a', 'b', 'a'], opts)).toEqual({ sig: 'a', count: 3 })
  })

  it('never collides distinct targets — read_file a vs read_file b stays under the limit', () => {
    const sigs = ['read_file:{"path":"a"}', 'read_file:{"path":"b"}', 'read_file:{"path":"a"}', 'read_file:{"path":"b"}']
    expect(detectOscillation(sigs, opts)).toBeNull()
  })

  it('only counts within the window — old repeats scroll out of view', () => {
    // Two "a"s then a long run of distinct calls: "a" is no longer within the last 8.
    const sigs = ['a', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    expect(detectOscillation(sigs, opts)).toBeNull()
    // But a third "a" inside the window trips it.
    expect(detectOscillation(['a', 'a', 'c', 'd', 'e', 'f', 'g', 'a'], opts)).toEqual({ sig: 'a', count: 3 })
  })

  it('reports the worst offender when more than one signature qualifies', () => {
    expect(detectOscillation(['a', 'a', 'a', 'b', 'b', 'b', 'b'], opts)).toEqual({ sig: 'b', count: 4 })
  })
})

describe('looksLikeContinuationRequest', () => {
  it('is true for interrogative permission-to-continue asks', () => {
    expect(looksLikeContinuationRequest('Should I continue?')).toBe(true)
    expect(looksLikeContinuationRequest('Shall I proceed?')).toBe(true)
    expect(looksLikeContinuationRequest('Do you want me to continue?')).toBe(true)
    expect(looksLikeContinuationRequest('Would you like me to proceed with the next step?')).toBe(true)
    expect(looksLikeContinuationRequest('Want me to keep going?')).toBe(true)
    expect(looksLikeContinuationRequest("Let me know if you'd like me to continue.")).toBe(true)
  })

  it('is true when the ask closes a longer reply', () => {
    expect(
      looksLikeContinuationRequest('I set up the routes and the models.\n\nShould I continue with the tests?')
    ).toBe(true)
  })

  it('is false for first-person narration (verb after the subject, not a question)', () => {
    expect(looksLikeContinuationRequest('I should continue to the next file.')).toBe(false)
    expect(looksLikeContinuationRequest('I want to continue building the UI.')).toBe(false)
  })

  it('is false for a genuine either/or choice with no continue verb', () => {
    expect(looksLikeContinuationRequest('Should I use Postgres or MySQL?')).toBe(false)
  })

  it('is false for a normal sign-off and a delivered answer', () => {
    expect(looksLikeContinuationRequest('Let me know if you need any changes.')).toBe(false)
    expect(looksLikeContinuationRequest('The app is done. You can run it with npm start.')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(looksLikeContinuationRequest('')).toBe(false)
    expect(looksLikeContinuationRequest('   ')).toBe(false)
  })
})
