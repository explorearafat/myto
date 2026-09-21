import { describe, it, expect, vi } from 'vitest'
import { spawnAgentTool } from './agent'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext, ToolGate } from './registry'

const gate = (over: Partial<ToolGate> = {}): ToolGate => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir: '/work',
  ...over
})
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  ...gate(),
  signal: new AbortController().signal,
  delegate: vi.fn(async () => 'findings'),
  ...over
})

describe('spawnAgentTool', () => {
  it('is read-only and cowork-only', () => {
    expect(spawnAgentTool.sideEffect).toBeUndefined()
    expect(spawnAgentTool.available(gate())).toBe(true)
    expect(spawnAgentTool.available(gate({ mode: 'chat' }))).toBe(false)
  })

  it('reports when delegation is unavailable', async () => {
    const out = await spawnAgentTool.run({ task: 'look into X' }, ctx({ delegate: undefined }))
    expect(out).toMatch(/not available/i)
  })

  it('delegates the task and returns the sub-agent report', async () => {
    const delegate = vi.fn(async () => '  the auth hook is used in 3 files  ')
    const out = await spawnAgentTool.run({ task: 'find auth usages' }, ctx({ delegate }))
    expect(delegate).toHaveBeenCalledWith('find auth usages')
    expect(out).toBe('the auth hook is used in 3 files')
  })

  it('needs a task', async () => {
    expect(await spawnAgentTool.run({}, ctx())).toMatch(/needs a "task"/i)
    expect(await spawnAgentTool.run({ task: '   ' }, ctx())).toMatch(/needs a "task"/i)
  })

  it('surfaces a sub-agent failure as a message rather than throwing', async () => {
    const delegate = vi.fn(async () => {
      throw new Error('boom')
    })
    const out = await spawnAgentTool.run({ task: 'x' }, ctx({ delegate }))
    expect(out).toMatch(/sub-agent failed/i)
    expect(out).toMatch(/boom/)
  })

  it('handles an empty report', async () => {
    const out = await spawnAgentTool.run({ task: 'x' }, ctx({ delegate: vi.fn(async () => '   ') }))
    expect(out).toMatch(/no findings/i)
  })
})
