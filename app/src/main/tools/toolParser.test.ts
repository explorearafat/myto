import { describe, it, expect } from 'vitest'
import { createToolCallParser, parseToolCall, parseInvokeBlock, fenceFor, toolResultBlock } from './toolParser'

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

  it('holds back a partial opening-fence prefix, then releases a non-tool fence', () => {
    // A partial backtick run could still grow into "```myto:tool", so it must not be
    // shown yet — whether it sits at a line start or is glued to prose.
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

  it('detects a fence glued to the end of a prose line (no newline before it)', () => {
    // Weak models routinely write the fence inline — "…reliably.```myto:tool" — rather
    // than breaking a line first. The prose must still be shown AND the call must run,
    // not leak into the chat as raw text with the turn ending on a no-op.
    const { text, calls } = run([
      'Switching to the compose view to fill the fields reliably.```myto:tool\n' +
        '{"tool":"browser_navigate","input":{"url":"https://mail.google.com/#compose"}}\n```\n'
    ])
    expect(text).toBe('Switching to the compose view to fill the fields reliably.')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('browser_navigate')
    expect(calls[0].input).toEqual({ url: 'https://mail.google.com/#compose' })
    expect(calls[0].error).toBeNull()
  })

  it('closes a tool block when prose is glued onto its closing fence (RC-6)', () => {
    // claude-opus-style close: the model puts the next sentence on the SAME line as
    // the closing ``` ("```Two files done…"). The block must still close at its own
    // backtick run — parse the call, release the glued prose — instead of holding
    // open and swallowing every following block (update_plan, the next write_file)
    // into one unparseable blob. That swallowing is why the plan stayed 0/4 across
    // every e2e run even when all files landed. See RC-6 in NOTES.md.
    const parser = createToolCallParser()
    const r = parser.push(
      '```myto:tool\n{"tool":"write_file","input":{"path":"a.css","content":"body{}"}}\n' +
        "```Two files done. Now I'll create app.js.\n"
    )
    expect(r.call?.name).toBe('write_file')
    expect(r.call?.error).toBeNull()
    expect((r.call?.input as { path: string }).path).toBe('a.css')
    expect(parser.holdingBlock).toBe(false) // closed, not held open

    // The glued prose is not lost, and the very next tool block still parses.
    const r2 = parser.push('```myto:tool\n{"tool":"update_plan","input":{"todos":[]}}\n```\n')
    expect(r.text + r2.text).toContain("Two files done. Now I'll create app.js.")
    expect(r2.call?.name).toBe('update_plan')
    expect(r2.call?.error).toBeNull()
  })

  it('splits a 6-backtick close fused to the next opener into two calls (RC-6)', () => {
    // Worse glued form: the model omits the newline between one block's closing ``` and
    // the next block's ```myto:tool opener, so they merge into a single ``````myto:tool run.
    // The greedy close match would eat all six backticks and swallow the opener, dropping
    // the batched call (the update_plan after a write — the plan-stays-0/4 bug). The close
    // must stop at its own three backticks and leave the opener for the next drain.
    const parser = createToolCallParser()
    const src =
      '```myto:tool\n{"tool":"write_file","input":{"path":"a.css","content":"body{}"}}\n' +
      '``````myto:tool\n{"tool":"update_plan","input":{"todos":[]}}\n```\n'
    const first = parser.push(src)
    expect(first.call?.name).toBe('write_file')
    expect(first.call?.error).toBeNull()
    // The fused opener was NOT swallowed — draining the parser pulls the second call out.
    const second = parser.push('')
    expect(second.call?.name).toBe('update_plan')
    expect(second.call?.error).toBeNull()
    expect(parser.holdingBlock).toBe(false)
  })

  it('keeps a glued fence intact when it splits across deltas at the backticks', () => {
    const parser = createToolCallParser()
    const first = parser.push('done it reliably.``')
    expect(first.text).toBe('done it reliably.') // the "``" is held — it could be a fence
    expect(first.call).toBeNull()
    const second = parser.push('`myto:tool\n{"tool":"browser_read","input":{}}\n```\n')
    expect(second.call?.name).toBe('browser_read')
    // The sentence surfaces exactly once, with no stray backticks leaking around it.
    expect(first.text + second.text).toBe('done it reliably.')
  })

  it('does not mistake a ```myto:tool_result wrapper for a call', () => {
    // The result wrapper starts with the same "```myto:tool" — but the "_result" suffix
    // (and, when the payload holds backticks, a 4-fence) must keep it plain text so it
    // renders on the call's card instead of firing a bogus, mis-parsed call.
    const { text, calls } = run(['```myto:tool_result web_search\nsome result body\n```\n'])
    expect(calls).toHaveLength(0)
    expect(text).toContain('```myto:tool_result web_search')
    expect(text).toContain('some result body')
  })

  it('requires a terminator after the marker (```myto:toolbar is not a call)', () => {
    const { text, calls } = run(['see the ```myto:toolbar helper for details'])
    expect(calls).toHaveLength(0)
    expect(text).toBe('see the ```myto:toolbar helper for details')
  })
})

describe('parseToolCall', () => {
  it('parses a whole block with fences', () => {
    const res = parseToolCall('```myto:tool\n{"tool":"web_fetch","input":{"url":"u"}}\n```')
    expect(res.name).toBe('web_fetch')
    expect(res.input).toEqual({ url: 'u' })
  })
})

describe('native <invoke> markup', () => {
  it('executes a native invoke call instead of leaking it as chat text', () => {
    const { text, calls, blocks } = run([
      'Let me run the build.\n',
      '<invoke name="run_command">\n<parameter name="command">npm run build</parameter>\n</invoke>'
    ])
    expect(text).toBe('Let me run the build.\n')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('run_command')
    expect(calls[0].input).toEqual({ command: 'npm run build' })
    expect(calls[0].error).toBeNull()
    // Folded into the canonical fenced shape so downstream code is format-agnostic.
    expect(blocks[0]).toContain('```myto:tool')
    expect(blocks[0]).toContain('run_command')
  })

  it('tolerates the antml namespace prefix on every tag', () => {
    // The colon is assembled at runtime so nothing here reads as a real directive.
    const ns = 'antml' + ':'
    const src =
      `<${ns}invoke name="write_file">` +
      `<${ns}parameter name="path">index.html</${ns}parameter>` +
      `</${ns}invoke>`
    const { calls } = run([src])
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('write_file')
    expect(calls[0].input).toEqual({ path: 'index.html' })
  })

  it('strips | DSML | token-pollution wedged into the markup', () => {
    const { text, calls } = run([
      '<invoke name="list_dir">| DSML |\n<parameter name="path">| DSML |src</parameter>\n</invoke>'
    ])
    expect(text).toBe('')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('list_dir')
    expect(calls[0].input).toEqual({ path: 'src' })
  })

  it('holds a native call split across many deltas until </invoke> arrives', () => {
    const src = '<invoke name="read_file"><parameter name="path">app.py</parameter></invoke>'
    const { text, calls } = run([...src])
    expect(text).toBe('')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
    expect(calls[0].input).toEqual({ path: 'app.py' })
  })

  it('JSON-parses a structured parameter value but keeps scalars as raw strings', () => {
    const src =
      '<invoke name="update_plan">' +
      '<parameter name="todos">[{"text":"build","status":"pending"}]</parameter>' +
      '<parameter name="note">go</parameter>' +
      '</invoke>'
    const { calls } = run([src])
    expect(calls[0].input).toEqual({
      todos: [{ text: 'build', status: 'pending' }],
      note: 'go'
    })
  })

  it('releases a nameless <invoke> as plain text instead of wedging the loop', () => {
    // A stray tag with no tool name must never become an errored call, or the reply
    // loop (which aborts on any detected call) would stall on prose.
    const src = 'see <invoke>the docs</invoke> for details'
    const { text, calls } = run([src])
    expect(calls).toHaveLength(0)
    expect(text).toBe(src)
  })

  it('parseInvokeBlock returns the canonical call for a whole block', () => {
    const call = parseInvokeBlock('<invoke name="web_search"><parameter name="query">webgpu</parameter></invoke>')
    expect(call).not.toBeNull()
    expect(call?.name).toBe('web_search')
    expect(call?.input).toEqual({ query: 'webgpu' })
    expect(call?.block).toContain('```myto:tool')
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

describe('createToolCallParser holdingBlock', () => {
  it('is false for plain prose, true once a tool fence opens but has not closed', () => {
    const parser = createToolCallParser()
    parser.push('just some prose ')
    expect(parser.holdingBlock).toBe(false)
    // Opener arrived, closing fence has not — the parser is mid-block.
    parser.push('```myto:tool\n{"tool":"write_file"')
    expect(parser.holdingBlock).toBe(true)
  })

  it('clears when the block closes, and flush() resets it', () => {
    const parser = createToolCallParser()
    const { call } = parser.push('```myto:tool\n{"tool":"web_search","input":{"query":"x"}}\n```\n')
    expect(call).not.toBeNull()
    expect(parser.holdingBlock).toBe(false)

    parser.push('```myto:tool\n{"tool":"write_file"') // reopen, unclosed
    expect(parser.holdingBlock).toBe(true)
    parser.flush()
    expect(parser.holdingBlock).toBe(false)
  })
})

describe('createToolCallParser holdingToolName', () => {
  it('is null with no open block, and null until the tool name has streamed in', () => {
    const parser = createToolCallParser()
    expect(parser.holdingToolName).toBeNull()
    // Fence opened but the JSON name has not arrived yet.
    parser.push('```myto:tool\n{"to')
    expect(parser.holdingBlock).toBe(true)
    expect(parser.holdingToolName).toBeNull()
  })

  it('reports the fenced tool name mid-stream, before the block closes', () => {
    const parser = createToolCallParser()
    parser.push('```myto:tool\n{"tool":"write_file","input":{"path":"index.html","content":"<!doc')
    expect(parser.holdingBlock).toBe(true)
    expect(parser.holdingToolName).toBe('write_file')
  })

  it('reports the native <invoke> tool name mid-stream', () => {
    const parser = createToolCallParser()
    parser.push('<invoke name="run_command">\n<parameter name="command">npm ')
    expect(parser.holdingBlock).toBe(true)
    expect(parser.holdingToolName).toBe('run_command')
  })

  it('is null again once the block closes', () => {
    const parser = createToolCallParser()
    const { call } = parser.push('```myto:tool\n{"tool":"web_search","input":{"query":"x"}}\n```\n')
    expect(call).not.toBeNull()
    expect(parser.holdingToolName).toBeNull()
  })
})

describe('native tool-name tags, streamed like a real token stream (RC-10)', () => {
  /**
   * Feed `full` through a fresh parser in `size`-char deltas with the reply loop's
   * drain (push the piece once, then '' until no further call surfaces) — the exact
   * cadence emitText uses, which a fixed-chunk harness without the drain does not
   * reproduce. Collects everything so each case can assert: every call parsed, no
   * raw markup leaked into text, and — critically — push() always terminates (the
   * old heldInvokePrefix spun forever on a buffer ending mid-word, e.g. '<pa').
   */
  function stream(full: string, size: number): { text: string; names: string[] } {
    const parser = createToolCallParser()
    let text = ''
    const names: string[] = []
    let guard = 0
    const push = (piece: string): void => {
      for (let first = true; ; first = false) {
        if (++guard > 10_000) throw new Error('push() did not terminate (held-prefix loop?)')
        const { text: t, call } = parser.push(first ? piece : '')
        text += t
        if (call) {
          names.push(call.name ?? `ERROR:${call.error}`)
          continue // drain: another call may be buffered behind this one
        }
        break
      }
    }
    for (let i = 0; i < full.length; i += size) push(full.slice(i, i + size))
    text += parser.flush()
    return { text, names }
  }

  // A Cowork-style build reply: fenced protocol call + prose + every native shape
  // seen leaking in the wild (tool-name tags with a space before the JSON body,
  // the bare <parameter name="tool"> wrapper, <run_dev_server>).
  const python = `{"language":"python","code":"import io,os,re,sys\nsys.stdout.reconfigure(encoding='utf-8')\nfor f,s in files.items():\n print(f'{f:18s} len={len(s):6d}')"}`
  const reply = [
    'Everything serves 200. Let me verify the theme wiring.',
    '```myto:tool\n{"tool":"run_command","input":{"command":"cd mykey-site && echo === sizes ==="}}\n```',
    'Theme PNGs exist. Checking swatches now.\n',
    `<run_code> ${python} </run_code> Let me verify the site's theme wiring.`,
    `<run_code> ${python} </run_code>`,
    `<parameter name="tool"> {"tool":"run","command":"cd mykey-site && echo === theme refs ==="} </parameter>`,
    `<run_dev_server> {"command":"cd mykey-site && npx --yes serve . -l 4173","port":4173} </run_dev_server>`,
    'Site is substantially built.'
  ].join('\n\n')
  const allNames = ['run_command', 'run_code', 'run_code', 'run', 'run_dev_server']

  for (const size of [1, 2, 3, 5, 7, 11, 13, 17, 31, 64, 127, 200, 512, 1024, 4096]) {
    it(`parses every call at ${size}-char deltas without leaking markup`, () => {
      const { text, names } = stream(reply, size)
      expect(names).toEqual(allNames)
      expect(text).not.toContain('<run_code')
      expect(text).not.toContain('<parameter')
      expect(text).not.toContain('<run_dev_server')
      expect(text).toContain('Everything serves 200')
      expect(text).toContain('Site is substantially built.')
    })
  }

  it('holds a mid-word <parameter tail instead of looping or leaking it', () => {
    // '<pa' is the exact state that sent the old heldInvokePrefix into an infinite
    // lastIndexOf('<', -1) === 0 loop, pegging the main process at 100% CPU.
    for (const tail of ['<p', '<pa', '<par', '<param', '<parameter', '<parameter name="to']) {
      const parser = createToolCallParser()
      const { text } = parser.push(`prose ${tail}`)
      expect(text, tail).toBe('prose ') // tail held, nothing leaked
      expect(parser.flush()).toBe(tail)
    }
  })

  it('releases ordinary markup and comparisons that merely start with <', () => {
    const { text, names } = stream('a < b and <div class="x">hi</div> stays', 3)
    expect(names).toEqual([])
    expect(text.replace(/\s+/g, ' ').trim()).toBe('a < b and <div class="x">hi</div> stays')
  })

  it('parses an antml-namespaced invoke split across tiny deltas', () => {
    const { text, names } = stream('<antml:invoke name="run_command">\n  <antml:parameter name="command">npm test</antml:parameter>\n</antml:invoke> done', 5)
    expect(names).toEqual(['run_command'])
    expect(text).not.toContain('<antml')
    expect(text).toContain('done')
  })
})
