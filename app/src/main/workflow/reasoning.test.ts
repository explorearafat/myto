import { describe, expect, it } from 'vitest'
import { ReasoningStripper, stripReasoningTags } from '@main/workflow/reasoning'

/** Feeds a whole string through a fresh stripper in one push, then flushes. */
function run(input: string): string {
  const s = new ReasoningStripper()
  return s.push(input) + s.flush()
}

/** Feeds a string one character at a time to exercise chunk-boundary handling. */
function runByChar(input: string): string {
  const s = new ReasoningStripper()
  let out = ''
  for (const ch of input) out += s.push(ch)
  return out + s.flush()
}

describe('stripReasoningTags (pure)', () => {
  it('removes a complete <think> span', () => {
    expect(stripReasoningTags('<think>plan the thing</think>Hello')).toBe('Hello')
  })

  it('removes <thinking> spans and is case-insensitive', () => {
    expect(stripReasoningTags('<Thinking>x</THINKING>done')).toBe('done')
  })

  it('drops a leading unterminated block that runs to the end', () => {
    expect(stripReasoningTags('answer <think>still musing with no close')).toBe('answer ')
  })

  it('leaves ordinary text (and stray angle brackets) untouched', () => {
    expect(stripReasoningTags('if x < 10 and y > 2, ship it')).toBe('if x < 10 and y > 2, ship it')
  })

  it('handles several spans in one string', () => {
    expect(stripReasoningTags('<think>a</think>one<think>b</think>two')).toBe('onetwo')
  })
})

describe('ReasoningStripper (streaming)', () => {
  it('passes clean prose straight through', () => {
    expect(run('Just the answer, nothing hidden.')).toBe('Just the answer, nothing hidden.')
  })

  it('strips a leading think block, keeping the answer', () => {
    expect(run('<think>Wait — reconsider the layout</think>Here is the plan.')).toBe(
      'Here is the plan.'
    )
  })

  it('strips prose before and after a mid-stream block', () => {
    expect(run('Intro. <think>Ugh, redo it</think> Outro.')).toBe('Intro.  Outro.')
  })

  it('drops an unterminated block on flush (no answer leaks)', () => {
    expect(run('Prefix <think>I will rewrite... no, actually')).toBe('Prefix ')
  })

  it('reassembles a tag split across chunk boundaries', () => {
    const s = new ReasoningStripper()
    let out = ''
    out += s.push('Answer <thi')
    out += s.push('nk>secret rea')
    out += s.push('soning</thi')
    out += s.push('nk> tail')
    out += s.flush()
    expect(out).toBe('Answer  tail')
  })

  it('never flashes a partial tag: char-by-char matches whole-string', () => {
    const input = 'Lead <think>hidden bit</think> trail <thinking>more</thinking> end'
    expect(runByChar(input)).toBe(run(input))
    expect(run(input)).toBe('Lead  trail  end')
  })

  it('does not hold back a lone < that turns out to be prose', () => {
    expect(run('compare a < b then done')).toBe('compare a < b then done')
  })

  it('is case-insensitive across boundaries', () => {
    expect(run('x<THINK>y</Think>z')).toBe('xz')
  })
})
