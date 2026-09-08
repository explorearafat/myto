import { describe, expect, it } from 'vitest'
import { REVEAL_MAX_CHARS, REVEAL_WHOLE_UNDER, revealCount, takeReveal } from './reveal'

/**
 * The two behaviours that matter are opposites, so they are tested as such: a live
 * token stream must come out exactly as it went in (no added lag on the one path
 * that already read as typing), and a whole block arriving in one delta must come
 * out over several ticks (the typewriter the user asked for).
 */
describe('revealCount (how much of the backlog to show this tick)', () => {
  it('passes a live token stream straight through, unmetered', () => {
    // Measured delta sizes from the user's gateway sit around 11–15 characters.
    for (const n of [1, 2, 5, 11, 15, 23, REVEAL_WHOLE_UNDER]) {
      expect(revealCount(n), `queued ${n}`).toBe(n)
    }
  })

  it('holds back a block, so a paragraph types instead of popping in', () => {
    expect(revealCount(200)).toBeLessThan(200)
    expect(revealCount(900)).toBeLessThan(900)
    // Geometric above the floor: a sixth of what is waiting…
    expect(revealCount(180)).toBe(30)
    expect(revealCount(600)).toBe(100)
    // …with the floor winning just past the passthrough threshold, so the tail of
    // a block never crawls out a character at a time.
    expect(revealCount(25)).toBe(REVEAL_WHOLE_UNDER)
    expect(revealCount(100)).toBe(REVEAL_WHOLE_UNDER)
  })

  it('caps the burst so even a long report is seen typing', () => {
    expect(revealCount(4000)).toBe(REVEAL_MAX_CHARS)
    expect(revealCount(50_000)).toBe(REVEAL_MAX_CHARS)
  })

  it('never offers more than is queued, and never a negative', () => {
    for (let n = 0; n <= 300; n++) {
      const take = revealCount(n)
      expect(take, `queued ${n}`).toBeLessThanOrEqual(n)
      expect(take, `queued ${n}`).toBeGreaterThanOrEqual(0)
    }
    expect(revealCount(0)).toBe(0)
    expect(revealCount(-5)).toBe(0)
    expect(revealCount(Number.NaN)).toBe(0)
  })

  it('always makes progress, so the queue provably drains', () => {
    // A 4,000-character closing report, drained tick by tick. It must finish, and
    // finish soon enough to feel live: at the store's 66ms cadence, 40 ticks is
    // ~2.6s of typing for a page of text.
    let queued = 4000
    let shown = 0
    let ticks = 0
    while (queued > 0) {
      const take = revealCount(queued)
      expect(take, `stalled at ${queued} queued`).toBeGreaterThan(0)
      queued -= take
      shown += take
      ticks++
      expect(ticks, 'drain did not terminate').toBeLessThan(200)
    }
    expect(shown).toBe(4000)
    expect(ticks).toBeLessThan(36)
  })

  it('does not fall behind a stream arriving faster than it types', () => {
    // 15 characters per tick — the measured arrival rate. The backlog must not grow
    // across a long answer, or the visible text would lag further behind every tick.
    let queued = 0
    for (let tick = 0; tick < 500; tick++) {
      queued += 15
      queued -= revealCount(queued)
      expect(queued, `backlog at tick ${tick}`).toBe(0)
    }
  })
})

describe('takeReveal (splitting the queue at a safe boundary)', () => {
  it('shows everything when the queue is short', () => {
    expect(takeReveal('streamed answer')).toEqual({ shown: 'streamed answer', rest: '' })
    expect(takeReveal('')).toEqual({ shown: '', rest: '' })
  })

  it('splits a block and loses nothing', () => {
    const text = 'A'.repeat(2000)
    const { shown, rest } = takeReveal(text)
    expect(shown.length).toBe(REVEAL_MAX_CHARS)
    expect(shown + rest).toBe(text)
  })

  it('never cuts through an emoji', () => {
    // The cut lands at index 24, which is the second half of the pair — taking it
    // alone would paint a replacement character until the next tick.
    const text = 'x'.repeat(23) + '🎨' + 'y'.repeat(30)
    const { shown, rest } = takeReveal(text)
    expect(shown).toBe('x'.repeat(23) + '🎨')
    expect(rest).toBe('y'.repeat(30))
    expect(shown + rest).toBe(text)
  })

  it('leaves a cut that already falls between code points alone', () => {
    const text = 'x'.repeat(24) + '🎨' + 'y'.repeat(30)
    const { shown, rest } = takeReveal(text)
    expect(shown).toBe('x'.repeat(24))
    expect(rest.startsWith('🎨')).toBe(true)
    expect(shown + rest).toBe(text)
  })
})
