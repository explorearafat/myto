import { describe, it, expect } from 'vitest'
import { createToolCallParser, parseToolCall, fenceFor, toolResultBlock } from './toolParser'

/** Feed `chunks` through a fresh parser; collect emitted text and any calls. */
function run(chunks: string[]): { text: string; calls: ReturnType<typeof parseToolCall>[]; blocks: string[] } {
  const parser = createToolCallParser()
  let text = ''
  const calls: ReturnType<typeof parseToolCall>[] = []
  const blocks: string[] = []
  for (const c of chunks) {
    const { text: t, call } = parser.push(c)
    text += t
    if (call) {
      calls.push({ name: call.name, input: call.input, error: call.error })
      blocks.push(call.block)
    }
  }
  text += parser.flush()
  return { text, calls, blocks }
}

describe('createToolCallParser', () => {
  it('passes ordinary prose through untouched', () => {
    const { text, calls } = run(['Hello ', 'world, no tools here.'])
    expect(text).toBe('Hello world, no tools here.')
    expect(calls).toHaveLength(0)
  })

  it('detects a complete tool call and does not leak its block into text', () => {
    const { text, calls, blocks } = run([
      'Let me search.\n',
      '```myto:tool\n{"tool":"web_search","input":{"query":"webgpu"}}\n```\n'
    ])
    expect(text).toBe('Let me search.\n')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('web_search')
    expect(calls[0].input).toEqual({ query: 'webgpu' })
    expect(calls[0].error).toBeNull()
    expect(blocks[0]).toContain('```myto:tool')
  })

  it('holds a call split across many deltas until the closing fence arrives', () => {
    // Emit the block one character at a time; nothing of it should surface as text.
    const src = '```myto:tool\n{"tool":"web_fetch","input":{"url":"https://x.dev"}}\n```'
    const { text, calls } = run([...src])
    expect(text).toBe('')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('web_fetch')
    expect(calls[0].input).toEqual({ url: 'https://x.dev' })
  })

  it('holds back a partial opening-fence prefix at a line start, then releases a non-tool fence', () => {
    // A tool fence only opens at a line start, so "``" right after a newline could
    // still grow into "```myto:tool" and must not be shown yet.
    const parser = createToolCallParser()
    const first = parser.push('answer\n``')
    expect(first.text).toBe('answer\n')
    expect(first.call).toBeNull()
    // It turns out to be an ordinary ```bash fence, not a tool fence: everything is
    // released as prose (across this push and the final flush), nothing is lost.
    const second = parser.push('`bash\nls\n```')
    expect(second.call).toBeNull()
    expect(first.text + second.text + parser.flush()).toBe('answer\n```bash\nls\n```')
  })

  it('surfaces malformed JSON as an error rather than throwing', () => {
    const { calls } = run(['```myto:tool\n{not json}\n```\n'])
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBeNull()
    expect(calls[0].error).toMatch(/invalid JSON/i)
  })

  it('flags a missing tool field', () => {
    const { calls } = run(['```myto:tool\n{"input":{"query":"x"}}\n```\n'])
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBeNull()
    expect(calls[0].error).toMatch(/missing "tool"/i)
  })

  it('flushes an unclosed tool block as text so nothing is lost', () => {
    const { text, calls } = run(['```myto:tool\n{"tool":"web_search"'])
    expect(calls).toHaveLength(0)
    expect(text).toContain('```myto:tool')
    expect(text).toContain('web_search')
  })

  it('emits prose before a fence immediately, holding only the block', () => {
    const parser = createToolCallParser()
    const r = parser.push('Here we go.\n```myto:tool\n{"tool":"wiki_search",')
    expect(r.text).toBe('Here we go.\n')
    expect(r.call).toBeNull()
    const r2 = parser.push('"input":{"query":"Ada Lovelace"}}\n```\n')
    expect(r2.call?.name).toBe('wiki_search')
  })
})

describe('parseToolCall', () => {
  it('parses a whole block with fences', () => {
    const res = parseToolCall('```myto:tool\n{"tool":"web_fetch","input":{"url":"u"}}\n```')
    expect(res.name).toBe('web_fetch')
    expect(res.input).toEqual({ url: 'u' })
  })
})

describe('fenceFor', () => {
  it('returns three backticks for text with no backtick runs', () => {
    expect(fenceFor('plain text')).toBe('```')
  })

  it('widens past the longest internal backtick run', () => {
    expect(fenceFor('a ``` b')).toBe('````')
    expect(fenceFor('a ```` b')).toBe('`````')
  })
})

describe('toolResultBlock', () => {
  it('wraps a result in a fence that its own backticks cannot close early', () => {
    const block = toolResultBlock('web_fetch', 'text with ``` inside')
    expect(block).toContain('````myto:tool_result web_fetch')
    // The closing fence is the same width and cannot be the internal run.
    const parsed = createToolCallParser()
    // A result block is not a call; the parser should pass it through as text.
    const { text, call } = parsed.push(block)
    expect(call).toBeNull()
    expect(text + parsed.flush()).toContain('text with ``` inside')
  })
})
