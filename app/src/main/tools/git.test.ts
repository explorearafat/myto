import { describe, it, expect } from 'vitest'
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitTool,
  gitTools
} from './git'
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

describe('git tool permission tiers', () => {
  it('makes the read-only tools carry no side effect (never prompt)', () => {
    expect(gitStatusTool.sideEffect).toBeUndefined()
    expect(gitDiffTool.sideEffect).toBeUndefined()
    expect(gitLogTool.sideEffect).toBeUndefined()
  })
  it('makes git_commit a write-tier action', () => {
    expect(gitCommitTool.sideEffect).toBe('write')
  })
  it('makes the arbitrary git escape hatch an exec-tier action', () => {
    expect(gitTool.sideEffect).toBe('exec')
  })
})

describe('git tool availability', () => {
  it('is available only in cowork with a working folder', () => {
    for (const t of gitTools) {
      expect(t.available(gate())).toBe(true)
      expect(t.available(gate({ mode: 'chat' }))).toBe(false)
      expect(t.available(gate({ workspaceDir: null }))).toBe(false)
    }
  })
})

describe('git tool input validation (before any spawn)', () => {
  it('git_commit refuses an empty/missing message', async () => {
    expect(await gitCommitTool.run({}, ctx())).toMatch(/needs a non-empty "message"/i)
    expect(await gitCommitTool.run({ message: '   ' }, ctx())).toMatch(/needs a non-empty "message"/i)
  })

  it('git refuses missing args', async () => {
    expect(await gitTool.run({}, ctx())).toMatch(/needs an "args"/i)
    expect(await gitTool.run({ args: [] }, ctx())).toMatch(/needs an "args"/i)
    expect(await gitTool.run({ args: '   ' }, ctx())).toMatch(/needs an "args"/i)
  })

  it('git treats a bare "git" as no args (leading git is dropped)', async () => {
    expect(await gitTool.run({ args: 'git' }, ctx())).toMatch(/needs an "args"/i)
  })
})

describe('gitTools catalogue', () => {
  it('advertises the five tools in a stable order', () => {
    expect(gitTools.map((t) => t.name)).toEqual([
      'git_status',
      'git_diff',
      'git_log',
      'git_commit',
      'git'
    ])
  })
})
