import { describe, it, expect } from 'vitest'
import { runCommandTool } from './command'
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
  ...over
})

describe('runCommandTool', () => {
  it('is an exec tool (permission-gated in cowork)', () => {
    expect(runCommandTool.sideEffect).toBe('exec')
  })

  it('is available only in cowork with a folder', () => {
    expect(runCommandTool.available(gate())).toBe(true)
    expect(runCommandTool.available(gate({ mode: 'chat' }))).toBe(false)
    expect(runCommandTool.available(gate({ workspaceDir: null }))).toBe(false)
  })

  it('needs a command string', async () => {
    expect(await runCommandTool.run({}, ctx())).toMatch(/needs a "command"/i)
    expect(await runCommandTool.run({ command: '   ' }, ctx())).toMatch(/needs a "command"/i)
  })

  it('refuses without a working folder', async () => {
    const out = await runCommandTool.run({ command: 'echo hi' }, ctx({ workspaceDir: null }))
    expect(out).toMatch(/no working folder/i)
  })
})
