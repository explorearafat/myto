import { describe, it, expect, vi } from 'vitest'
import { updatePlanTool } from './plan'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext, ToolGate } from './registry'
import type { TodoItem } from '../../shared/types'

const gate = (over: Partial<ToolGate> = {}): ToolGate => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir: '/work',
  ...over
})

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  ...gate(),
  signal: new AbortController().signal,
  onPlan: vi.fn(),
  ...over
})

describe('updatePlanTool', () => {
  it('is a read-only tool (never asks for approval)', () => {
    expect(updatePlanTool.sideEffect).toBeUndefined()
  })

  it('is available only in cowork mode', () => {
    expect(updatePlanTool.available(gate({ mode: 'cowork' }))).toBe(true)
    expect(updatePlanTool.available(gate({ mode: 'chat' }))).toBe(false)
    // A URL/plan preview needs no folder — cowork alone arms it.
    expect(updatePlanTool.available(gate({ mode: 'cowork', workspaceDir: null }))).toBe(true)
  })

  it('reports when there is no plan panel to drive', async () => {
    const out = await updatePlanTool.run({ todos: [{ title: 'x', status: 'pending' }] }, ctx({ onPlan: undefined }))
    expect(out).toMatch(/not available/i)
  })

  it('publishes the parsed todos and summarizes progress', async () => {
    const onPlan = vi.fn()
    const todos = [
      { title: 'Scaffold', status: 'done' },
      { title: 'Write page', status: 'in_progress' },
      { title: 'Verify', status: 'pending' }
    ]
    const out = await updatePlanTool.run({ todos }, ctx({ onPlan }))
    expect(onPlan).toHaveBeenCalledTimes(1)
    const passed = onPlan.mock.calls[0][0] as TodoItem[]
    expect(passed).toEqual(todos)
    expect(out).toMatch(/1\/3 done/)
    expect(out).toMatch(/Write page/)
  })

  it('defaults an unknown status to pending and drops title-less items', async () => {
    const onPlan = vi.fn()
    await updatePlanTool.run(
      { todos: [{ title: 'A', status: 'weird' }, { status: 'done' }, { title: '  ' }, { title: 'B' }] },
      ctx({ onPlan })
    )
    expect(onPlan.mock.calls[0][0]).toEqual([
      { title: 'A', status: 'pending' },
      { title: 'B', status: 'pending' }
    ])
  })

  it('rejects a missing or empty todos array', async () => {
    expect(await updatePlanTool.run({}, ctx())).toMatch(/needs a "todos" array/i)
    expect(await updatePlanTool.run({ todos: 'nope' }, ctx())).toMatch(/needs a "todos" array/i)
    expect(await updatePlanTool.run({ todos: [] }, ctx())).toMatch(/no usable items/i)
  })

  it('caps a runaway plan at 40 items', async () => {
    const onPlan = vi.fn()
    const many = Array.from({ length: 100 }, (_, i) => ({ title: `step ${i}`, status: 'pending' }))
    await updatePlanTool.run({ todos: many }, ctx({ onPlan }))
    expect((onPlan.mock.calls[0][0] as TodoItem[]).length).toBe(40)
  })
})
