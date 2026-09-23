import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { McpServerStatus, ProviderSettings } from '../../shared/types'
import type { ToolContext, ToolGate } from './registry'

// In-memory settings the tools read/write through the mocked settings module.
let stored: ProviderSettings
const saveSpy = vi.fn((s: ProviderSettings) => {
  stored = s
  return s
})
vi.mock('../settings', () => ({
  getSettings: () => stored,
  saveSettings: (s: ProviderSettings) => saveSpy(s)
}))

// Connector sync + live status, resolved via install.ts's dynamic imports.
let statuses: McpServerStatus[] = []
const syncConnectors = vi.fn(async () => {
  // Mimic a successful connect: expose the saved servers as 'connected'.
  statuses = stored.mcpServers.map((s) => ({
    id: s.id,
    state: 'connected',
    toolCount: 2,
    toolNames: [`mcp__${s.name.toLowerCase()}__a`, `mcp__${s.name.toLowerCase()}__b`]
  }))
})
vi.mock('../mcp-ipc', () => ({ syncConnectors: () => syncConnectors() }))
vi.mock('../mcp/manager', () => ({ mcpManager: { statuses: () => statuses } }))

import { installConnectorTool, installSkillTool } from './install'

const gate = (over: Partial<ToolGate> = {}): ToolGate => ({
  settings: stored,
  mode: 'cowork',
  workspaceDir: '/work',
  ...over
})
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  ...gate(),
  signal: new AbortController().signal,
  ...over
})

beforeEach(() => {
  stored = { ...DEFAULT_PROVIDER_SETTINGS, mcpServers: [], skills: [] }
  statuses = []
  saveSpy.mockClear()
  syncConnectors.mockClear()
})

describe('installSkillTool', () => {
  it('is a write side effect gated on the tool switch', () => {
    expect(installSkillTool.sideEffect).toBe('write')
    expect(installSkillTool.available(gate())).toBe(true)
    expect(
      installSkillTool.available(
        gate({ settings: { ...stored, tools: { enabled: false, codeExecution: false } } })
      )
    ).toBe(false)
  })

  it('rejects a spec missing name or instructions', async () => {
    expect(await installSkillTool.run({ instructions: 'do a thing' }, ctx())).toMatch(/name/i)
    expect(await installSkillTool.run({ name: 'PDF forms' }, ctx())).toMatch(/instructions/i)
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('saves an enabled skill and names its tool', async () => {
    const out = await installSkillTool.run(
      { name: 'PDF forms', description: 'Fill PDF forms', instructions: 'Step 1 …' },
      ctx()
    )
    expect(saveSpy).toHaveBeenCalledOnce()
    expect(stored.skills).toHaveLength(1)
    expect(stored.skills[0]).toMatchObject({
      name: 'PDF forms',
      description: 'Fill PDF forms',
      instructions: 'Step 1 …',
      enabled: true
    })
    expect(stored.skills[0].id).toBeTruthy()
    expect(out).toMatch(/skill__pdf_forms/)
  })

  it('replaces a same-named skill rather than duplicating it', async () => {
    stored.skills = [
      { id: 'old', name: 'PDF forms', description: 'old', instructions: 'old', enabled: true }
    ]
    await installSkillTool.run({ name: 'pdf forms', instructions: 'new instructions' }, ctx())
    expect(stored.skills).toHaveLength(1)
    expect(stored.skills[0].instructions).toBe('new instructions')
    expect(stored.skills[0].id).not.toBe('old')
  })
})

describe('installConnectorTool', () => {
  it('is a write side effect', () => {
    expect(installConnectorTool.sideEffect).toBe('write')
  })

  it('requires a name', async () => {
    expect(await installConnectorTool.run({ transport: 'stdio', command: 'npx' }, ctx())).toMatch(
      /name/i
    )
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('requires a command for stdio and a url for http', async () => {
    expect(await installConnectorTool.run({ name: 'X', transport: 'stdio' }, ctx())).toMatch(
      /command/i
    )
    expect(await installConnectorTool.run({ name: 'X', transport: 'http' }, ctx())).toMatch(/url/i)
    expect(await installConnectorTool.run({ name: 'X', transport: 'http', url: 'not a url' }, ctx())).toMatch(
      /valid URL/i
    )
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('saves a stdio connector, syncs, and reports the connected tools', async () => {
    const out = await installConnectorTool.run(
      { name: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { T: '1' } },
      ctx()
    )
    expect(saveSpy).toHaveBeenCalledOnce()
    expect(stored.mcpServers).toHaveLength(1)
    expect(stored.mcpServers[0]).toMatchObject({
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { T: '1' },
      enabled: true
    })
    expect(syncConnectors).toHaveBeenCalledOnce()
    expect(out).toMatch(/connected/i)
    expect(out).toMatch(/2 tool/i)
  })

  it('reports a connection failure without losing the saved config', async () => {
    syncConnectors.mockImplementationOnce(async () => {
      statuses = stored.mcpServers.map((s) => ({
        id: s.id,
        state: 'error',
        toolCount: 0,
        toolNames: [],
        error: 'spawn failed'
      }))
    })
    const out = await installConnectorTool.run(
      { name: 'Broken', transport: 'stdio', command: 'nope' },
      ctx()
    )
    expect(stored.mcpServers).toHaveLength(1)
    expect(out).toMatch(/failed to connect/i)
    expect(out).toMatch(/spawn failed/i)
  })
})
