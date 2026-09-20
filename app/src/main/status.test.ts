import { describe, expect, it } from 'vitest'
import { createStatusStripper, reasoningCaption, STATUS_SYSTEM_PROMPT } from './status'

/** Collect the visible text a sequence of deltas produces (tags removed). */
function runText(deltas: string[]): string {
  const s = createStatusStripper()
  let text = ''
  for (const d of deltas) text += s.push(d).text
  text += s.flush()
  return text
}

/** Collect the captions a sequence of deltas produces. */
function runStatuses(deltas: string[]): string[] {
  const s = createStatusStripper()
  const out: string[] = []
  for (const d of deltas) out.push(...s.push(d).statuses)
  s.flush()
  return out
}

describe('status system prompt', () => {
  it('tells the model to wrap captions in <status> tags', () => {
    expect(STATUS_SYSTEM_PROMPT).toContain('<status>')
    expect(STATUS_SYSTEM_PROMPT).toContain('</status>')
  })
})

describe('createStatusStripper — captions', () => {
  it('extracts a complete tag delivered in one delta and strips it from the text', () => {
    const s = createStatusStripper()
    const { text, statuses } = s.push('<status>Reading the question</status>Here is the answer.')
    expect(statuses).toEqual(['Reading the question'])
    expect(text).toBe('Here is the answer.')
  })

  it('reassembles a tag split across many deltas without leaking any of it', () => {
    // Worst case: the open tag itself is torn mid-token.
    const deltas = ['Answer ', '<sta', 'tus>Weigh', 'ing options', '</status>', ' continues']
    expect(runStatuses(deltas)).toEqual(['Weighing options'])
    expect(runText(deltas)).toBe('Answer  continues')
  })

  it('captures multiple captions in a single delta, in order', () => {
    expect(runStatuses(['<status>A</status>x<status>B</status>y'])).toEqual(['A', 'B'])
    expect(runText(['<status>A</status>x<status>B</status>y'])).toBe('xy')
  })

  it('keeps text on both sides of a mid-stream tag', () => {
    const s = createStatusStripper()
    const { text, statuses } = s.push('Hello <status>Thinking hard</status> world')
    expect(statuses).toEqual(['Thinking hard'])
    expect(text).toBe('Hello  world')
  })

  it('ignores an empty caption', () => {
    expect(runStatuses(['<status></status>hi'])).toEqual([])
    expect(runText(['<status></status>hi'])).toBe('hi')
  })
})

describe('createStatusStripper — literal text is never mistaken for a tag', () => {
  it('passes a stray "<" in prose straight through', () => {
    expect(runText(['if 5 < 10 then'])).toBe('if 5 < 10 then')
    expect(runStatuses(['if 5 < 10 then'])).toEqual([])
  })

  it('releases a "<" held at a delta boundary once it is clearly not a tag', () => {
    const s = createStatusStripper()
    // The trailing '<' could still start "<status>", so it is held this tick...
    expect(s.push('a <').text).toBe('a ')
    // ...and released as soon as the next char rules the tag out.
    expect(s.push('b').text).toBe('<b')
  })

  it('passes through a "<status"-looking prefix that then diverges', () => {
    expect(runText(['<statux> not a tag'])).toBe('<statux> not a tag')
  })

  it('leaves plain text completely untouched', () => {
    expect(runText(['no tags here', ' at all'])).toBe('no tags here at all')
    expect(runStatuses(['no tags here', ' at all'])).toEqual([])
  })
})

describe('createStatusStripper — end of stream', () => {
  it('drops an unterminated <status> tag instead of leaking it as text', () => {
    const s = createStatusStripper()
    const first = s.push('The answer<status>Still thinki')
    expect(first.text).toBe('The answer')
    expect(first.statuses).toEqual([])
    // Stream ends mid-status: the partial tag is discarded, not shown.
    expect(s.flush()).toBe('')
  })
})

describe('reasoningCaption', () => {
  it('returns empty for empty or whitespace-only reasoning', () => {
    expect(reasoningCaption('')).toBe('')
    expect(reasoningCaption('   \n\t  ')).toBe('')
  })

  it('collapses internal whitespace and newlines to single spaces', () => {
    expect(reasoningCaption('Let me   think\n\nabout   this')).toBe('Let me think about this')
  })

  it('returns the sentence currently under way (the run after the last terminator)', () => {
    expect(reasoningCaption('First I consider A. Now I weigh B')).toBe('Now I weigh B')
  })

  it('keeps a short completed final sentence intact, terminator and all', () => {
    expect(reasoningCaption('First one. Second one.')).toBe('Second one.')
  })

  it('returns a short single run unchanged, without an ellipsis', () => {
    expect(reasoningCaption('Considering the options')).toBe('Considering the options')
  })

  it('caps a long tail at 64 characters with a leading ellipsis', () => {
    const out = reasoningCaption('x'.repeat(100))
    expect(out).toBe(`…${'x'.repeat(64)}`)
    expect(out.length).toBe(65) // ellipsis (1) + 64 chars
  })

  it('tracks the end of a single long run as it grows (rolling window)', () => {
    const base =
      'thinking about the problem in great detail and considering all of the angles here'
    expect(base.length).toBeGreaterThan(64)
    expect(reasoningCaption(base)).toBe(`…${base.slice(-64)}`)
  })
})
