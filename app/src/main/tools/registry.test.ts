import { describe, it, expect, afterEach } from 'vitest'
import { TOOLS, availableTools, runTool, toolsSystemPrompt, type ToolDef } from './registry'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ProviderSettings } from '../../shared/types'
import type { ToolCall } from './toolParser'

const settings = (enabled: boolean, codeExecution = false): ProviderSettings => ({
  ...DEFAULT_PROVIDER_SETTINGS,
  tools: { enabled, codeExecution }
})

const ctx = (s: ProviderSettings) => ({ signal: new AbortController().signal, settings: s })

const call = (over: Partial<ToolCall>): ToolCall => ({
  block: '',
  name: 'web_search',
  input: {},
  error: null,
  ...over
})

// Injected fakes are removed after each test so the shared TOOLS map stays clean.
const injected: string[] = []
afterEach(() => {
  for (const name of injected) delete TOOLS[name]
  injected.length = 0
})
function inject(tool: ToolDef): void {
  TOOLS[tool.name] = tool
  injected.push(tool.name)
}

describe('TOOLS catalogue', () => {
  it('registers the four built-in tools', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(['run_code', 'web_fetch', 'web_search', 'wiki_search'])
  })
})

describe('availableTools', () => {
  it('is empty when tool use is off', () => {
    expect(availableTools(settings(false))).toHaveLength(0)
  })
  it('exposes the read-only web tools but hides run_code by default', () => {
    const names = availableTools(settings(true)).map((t) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('wiki_search')
    expect(names).not.toContain('run_code')
  })
  it('includes run_code once code execution is enabled', () => {
    expect(availableTools(settings(true, true)).map((t) => t.name)).toContain('run_code')
  })
})

describe('toolsSystemPrompt', () => {
  it('is null when no tools are available', () => {
    expect(toolsSystemPrompt(settings(false))).toBeNull()
  })
  it('teaches the protocol and lists web tools without run_code', () => {
    const p = toolsSystemPrompt(settings(true))!
    expect(p).toContain('```sylor:tool')
    expect(p).toContain('web_search')
    expect(p).not.toContain('run_code')
  })
  it('lists run_code when enabled', () => {
    expect(toolsSystemPrompt(settings(true, true))!).toContain('run_code')
  })
})

describe('runTool', () => {
  it('reports tool use being off', async () => {
    expect(await runTool(call({}), ctx(settings(false)))).toMatch(/turned off/i)
  })
  it('surfaces a parse error as a recoverable message', async () => {
    const out = await runTool(call({ name: null, error: 'invalid JSON' }), ctx(settings(true)))
    expect(out).toMatch(/did not parse/i)
    expect(out).toMatch(/invalid JSON/)
  })
  it('reports an unknown tool', async () => {
    expect(await runTool(call({ name: 'nope' }), ctx(settings(true)))).toMatch(/Unknown tool "nope"/)
  })
  it('reports a gated-off tool', async () => {
    expect(await runTool(call({ name: 'run_code', input: { language: 'js', code: '1' } }), ctx(settings(true)))).toMatch(
      /not available/i
    )
  })
  it('dispatches to an available tool and passes the input through', async () => {
    inject({
      name: 'echo_test',
      description: 'echo',
      usage: '{}',
      available: () => true,
      run: async (input) => `echoed ${JSON.stringify(input)}`
    })
    const out = await runTool(call({ name: 'echo_test', input: { a: 1 } }), ctx(settings(true)))
    expect(out).toBe('echoed {"a":1}')
  })
  it('turns a thrown error into a message rather than rejecting', async () => {
    inject({
      name: 'boom_test',
      description: 'boom',
      usage: '{}',
      available: () => true,
      run: async () => {
        throw new Error('kaboom')
      }
    })
    const out = await runTool(call({ name: 'boom_test' }), ctx(settings(true)))
    expect(out).toMatch(/boom_test.*failed/i)
    expect(out).toMatch(/kaboom/)
  })
})
