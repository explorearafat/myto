import { describe, it, expect } from 'vitest'
import { tokenize, scoreBlocks, recallMemory } from './memory-recall'

// Step 4 (Gap A3): local, offline relevance recall. The memory readers inject only a
// recency TAIL, so a long project drops useful EARLY notes. recallMemory surfaces the
// task-relevant ones alongside the tail — deterministic, no network, purely additive.

describe('tokenize', () => {
  it('lowercases, splits on non-alnum, drops stopwords and 1-char tokens', () => {
    // 'the' and 'at' are stopwords; '2' is a 1-char token; run_command splits on '_'.
    expect(tokenize('The run_command Guard, at POSITION 2!')).toEqual([
      'run', 'command', 'guard', 'position',
    ])
  })
  it('returns [] for punctuation/stopwords only', () => {
    expect(tokenize('the a of to — !!!')).toEqual([])
  })
})

describe('scoreBlocks', () => {
  it('is all-zero for an empty query', () => {
    expect(scoreBlocks(['anything here'], '')).toEqual([0])
  })
  it('weights a RARE shared term above a common one (idf)', () => {
    const blocks = ['alpha shared', 'beta shared', 'gamma unique']
    const s = scoreBlocks(blocks, 'shared unique')
    expect(s[2]).toBeGreaterThan(s[0]) // 'unique' (df 1) beats 'shared' (df 2)
    expect(s[0]).toBeGreaterThan(0)
  })
  it('scores a non-overlapping block 0', () => {
    expect(scoreBlocks(['no overlap at all'], 'kubernetes ingress')[0]).toBe(0)
  })
})

// A journal that has overflowed its cap: one highly relevant EARLY note, then filler
// that fills the recency tail. The early note is NOT in the tail, so today's reader
// would drop it entirely.
const EARLY = 'decided kubernetes ingress terminates tls for the payments service'
const FILLER = Array.from({ length: 80 }, (_, i) => `routine step ${i} touched miscellaneous alpha beta`).join('\n')
const TEXT = `${EARLY}\n${FILLER}`
const CAP = 300

describe('recallMemory', () => {
  it('returns short text unchanged (byte-identical) when it fits the cap', () => {
    const small = 'just one short note'
    expect(recallMemory(small, 'anything', { cap: CAP })).toBe(small)
  })

  it('with NO query reproduces the old recency tail exactly', () => {
    const out = recallMemory(TEXT, '', { cap: CAP })
    expect(out).toBe(`…(earlier entries trimmed)\n${TEXT.slice(-CAP)}`)
    expect(out).not.toContain(EARLY) // proves the early note is otherwise lost
  })

  it('honours a custom trimmed marker on the no-query path', () => {
    const out = recallMemory(TEXT, '', { cap: CAP, trimmedMarker: '…(earlier notes trimmed)' })
    expect(out.startsWith('…(earlier notes trimmed)\n')).toBe(true)
  })

  it('surfaces a RELEVANT older note that the tail would have dropped', () => {
    const out = recallMemory(TEXT, 'kubernetes ingress tls', { cap: CAP })
    expect(out).toContain(EARLY)
    expect(out).toContain('most relevant earlier notes')
    expect(out.endsWith(TEXT.slice(-(CAP - Math.floor(CAP * 0.4))))).toBe(true) // tail still present
  })

  it('falls back to the plain tail when the query matches nothing older', () => {
    const out = recallMemory(TEXT, 'wildly unrelated vocabulary xylophone', { cap: CAP })
    expect(out).toBe(`…(earlier entries trimmed)\n${TEXT.slice(-CAP)}`)
  })

  it('respects the reserved budget and topK when many notes are relevant', () => {
    const relevant = Array.from({ length: 12 }, (_, i) => `note ${i} about kubernetes ingress tls payments`)
    const bulk = Array.from({ length: 200 }, () => 'x'.repeat(30)).join('\n')
    const text = `${relevant.join('\n')}\n${bulk}`
    const out = recallMemory(text, 'kubernetes ingress tls payments', { cap: 400, topK: 3 })
    const header = out.split('\n…(other earlier entries trimmed')[0]
    const picked = header.split('\n').slice(1) // drop the header line
    expect(picked.length).toBeLessThanOrEqual(3) // topK enforced
    expect(picked.join('\n').length).toBeLessThanOrEqual(Math.floor(400 * 0.4))
  })
})
