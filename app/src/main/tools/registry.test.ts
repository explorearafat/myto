import { describe, it, expect, afterEach } from 'vitest'
import {
  TOOLS,
  availableTools,
  runTool,
  toolsSystemPrompt,
  registerExtensionTool,
  unregisterExtensionTools,
  clearExtensionTools,
  extensionToolNames,
  lookupTool,
  type ToolDef,
  type ToolGate
} from './registry'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ProviderSettings } from '../../shared/types'
import type { ToolCall } from './toolParser'

const settings = (enabled: boolean, codeExecution = false): ProviderSettings => ({
  ...DEFAULT_PROVIDER_SETTINGS,
  tools: { enabled, codeExecution }
})

/** A gate: chat mode with no working folder unless overridden. */
const gate = (s: ProviderSettings, over: Partial<ToolGate> = {}): ToolGate => ({
  settings: s,
  mode: 'chat',
  workspaceDir: null,
  ...over
})

/** A cowork gate with a working folder set (arms the filesystem tools). */
const coworkGate = (s: ProviderSettings): ToolGate =>
  gate(s, { mode: 'cowork', workspaceDir: '/work' })

const ctx = (g: ToolGate) => ({ ...g, signal: new AbortController().signal })

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
  it('registers the web, code, and filesystem tools', () => {
    expect(Object.keys(TOOLS).sort()).toEqual([
      'delete_file',
      'edit_file',
      'find_files',
      'list_dir',
      'preview',
      'read_file',
      'run_code',
      'run_command',
      'search_code',
      'spawn_agent',
      'update_plan',
      'web_fetch',
      'web_search',
      'wiki_search',
      'write_file'
    ])
  })
})

describe('availableTools', () => {
  it('is empty when tool use is off', () => {
    expect(availableTools(gate(settings(false)))).toHaveLength(0)
  })
  it('exposes the read-only web tools but hides run_code and the fs tools by default', () => {
    const names = availableTools(gate(settings(true))).map((t) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('wiki_search')
    expect(names).not.toContain('run_code')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('read_file')
  })
  it('includes run_code once code execution is enabled', () => {
    expect(availableTools(gate(settings(true, true))).map((t) => t.name)).toContain('run_code')
  })
  it('exposes the filesystem tools only in cowork mode with a working folder', () => {
    // Cowork but no folder chosen: still hidden.
    expect(
      availableTools(gate(settings(true), { mode: 'cowork', workspaceDir: null })).map((t) => t.name)
    ).not.toContain('write_file')
    // Cowork with a folder: all five fs tools appear.
    const names = availableTools(coworkGate(settings(true))).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['list_dir', 'read_file', 'write_file', 'edit_file', 'delete_file'])
    )
  })

  it('makes run_code available in cowork even when the code-execution toggle is off', () => {
    // Chat + toggle off: hidden. Cowork + toggle off: available (permission-gated).
    expect(availableTools(gate(settings(true))).map((t) => t.name)).not.toContain('run_code')
    expect(availableTools(coworkGate(settings(true))).map((t) => t.name)).toContain('run_code')
  })
  it('exposes the preview tool only in cowork mode', () => {
    // A URL preview needs no folder, so it appears in cowork even without one.
    expect(
      availableTools(gate(settings(true), { mode: 'cowork', workspaceDir: null })).map((t) => t.name)
    ).toContain('preview')
    expect(availableTools(gate(settings(true))).map((t) => t.name)).not.toContain('preview')
  })
  it('does not expose the filesystem tools in chat mode even with a folder set', () => {
    const names = availableTools(gate(settings(true), { workspaceDir: '/work' })).map((t) => t.name)
    expect(names).not.toContain('write_file')
  })
})

describe('toolsSystemPrompt', () => {
  it('is null when no tools are available', () => {
    expect(toolsSystemPrompt(gate(settings(false)))).toBeNull()
  })
  it('teaches the protocol and lists web tools without run_code or fs tools', () => {
    const p = toolsSystemPrompt(gate(settings(true)))!
    expect(p).toContain('```sylor:tool')
    expect(p).toContain('web_search')
    expect(p).not.toContain('run_code')
    expect(p).not.toContain('write_file')
  })
  it('lists run_code when enabled', () => {
    expect(toolsSystemPrompt(gate(settings(true, true)))!).toContain('run_code')
  })
  it('lists the filesystem tools in cowork mode with a folder', () => {
    const p = toolsSystemPrompt(coworkGate(settings(true)))!
    expect(p).toContain('write_file')
    expect(p).toContain('read_file')
    expect(p).toContain('list_dir')
    expect(p).toContain('edit_file')
  })
})

describe('runTool', () => {
  it('reports tool use being off', async () => {
    expect(await runTool(call({}), ctx(gate(settings(false))))).toMatch(/turned off/i)
  })
  it('surfaces a parse error as a recoverable message', async () => {
    const out = await runTool(call({ name: null, error: 'invalid JSON' }), ctx(gate(settings(true))))
    expect(out).toMatch(/did not parse/i)
    expect(out).toMatch(/invalid JSON/)
  })
  it('reports an unknown tool', async () => {
    expect(await runTool(call({ name: 'nope' }), ctx(gate(settings(true))))).toMatch(
      /Unknown tool "nope"/
    )
  })
  it('reports a gated-off tool', async () => {
    expect(
      await runTool(
        call({ name: 'run_code', input: { language: 'js', code: '1' } }),
        ctx(gate(settings(true)))
      )
    ).toMatch(/not available/i)
  })
  it('refuses a filesystem tool outside cowork mode', async () => {
    const out = await runTool(
      call({ name: 'write_file', input: { path: 'x.txt', content: 'hi' } }),
      ctx(gate(settings(true)))
    )
    expect(out).toMatch(/not available/i)
    expect(out).toMatch(/cowork/i)
  })
  it('dispatches to an available tool and passes the input through', async () => {
    inject({
      name: 'echo_test',
      description: 'echo',
      usage: '{}',
      available: () => true,
      run: async (input) => `echoed ${JSON.stringify(input)}`
    })
    const out = await runTool(call({ name: 'echo_test', input: { a: 1 } }), ctx(gate(settings(true))))
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
    const out = await runTool(call({ name: 'boom_test' }), ctx(gate(settings(true))))
    expect(out).toMatch(/boom_test.*failed/i)
    expect(out).toMatch(/kaboom/)
  })
})

describe('extension tools (connectors / skills / plugins)', () => {
  // Always start from a clean extension layer so one test can't leak into another.
  afterEach(() => clearExtensionTools())

  const extTool = (name: string, over: Partial<ToolDef> = {}): ToolDef => ({
    name,
    description: 'an extension tool',
    usage: '{}',
    available: () => true,
    run: async () => `ran ${name}`,
    ...over
  })

  it('does NOT change the built-in TOOLS catalogue', () => {
    const before = Object.keys(TOOLS).length
    registerExtensionTool(extTool('mcp__srv__do'))
    expect(Object.keys(TOOLS).length).toBe(before)
    expect(TOOLS['mcp__srv__do']).toBeUndefined()
  })

  it('registers, lists, and looks up an extension tool', () => {
    registerExtensionTool(extTool('mcp__srv__do'))
    expect(extensionToolNames()).toContain('mcp__srv__do')
    expect(lookupTool('mcp__srv__do')?.name).toBe('mcp__srv__do')
  })

  it('merges extension tools into availableTools when tool use is on', () => {
    registerExtensionTool(extTool('mcp__srv__do'))
    const names = availableTools(gate(settings(true))).map((t) => t.name)
    expect(names).toContain('mcp__srv__do')
    expect(names).toContain('web_search') // built-ins still present
  })

  it('honours an extension tool\'s own availability gate', () => {
    registerExtensionTool(extTool('mcp__srv__off', { available: () => false }))
    expect(availableTools(gate(settings(true))).map((t) => t.name)).not.toContain('mcp__srv__off')
  })

  it('hides extension tools when tool use is off', () => {
    registerExtensionTool(extTool('mcp__srv__do'))
    expect(availableTools(gate(settings(false)))).toHaveLength(0)
  })

  it('dispatches runTool to an extension tool', async () => {
    registerExtensionTool(extTool('mcp__srv__do'))
    const out = await runTool(call({ name: 'mcp__srv__do', input: {} }), ctx(gate(settings(true))))
    expect(out).toBe('ran mcp__srv__do')
  })

  it('unregisters extension tools by name', () => {
    registerExtensionTool(extTool('mcp__srv__a'))
    registerExtensionTool(extTool('mcp__srv__b'))
    unregisterExtensionTools(['mcp__srv__a'])
    expect(lookupTool('mcp__srv__a')).toBeUndefined()
    expect(lookupTool('mcp__srv__b')?.name).toBe('mcp__srv__b')
  })

  it('lets a built-in win over a same-named extension tool in lookup', () => {
    registerExtensionTool(extTool('web_search', { run: async () => 'shadow' }))
    // lookupTool checks the built-in map first.
    expect(lookupTool('web_search')).toBe(TOOLS['web_search'])
  })
})
