import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '@shared/types'

// The MEDIUM/COMPLEX path asks the model for a plan; intercept the provider so
// each test scripts the exact JSON (or failure) the planner has to survive.
const { getCompletion } = vi.hoisted(() => ({ getCompletion: vi.fn() }))

vi.mock('@main/providers', () => ({
  providerFromSettings: () => ({
    streamCompletion: vi.fn(),
    getCompletion,
    listModels: vi.fn(),
    testConnection: vi.fn()
  })
}))

import { buildPlan, renderPlanMarkdown } from '@main/workflow/orchestrator/planner'

const settings = {} as ProviderSettings
const plan = (tasks: unknown): string => JSON.stringify({ tasks })

afterEach(() => {
  getCompletion.mockReset()
})

describe('buildPlan — SIMPLE', () => {
  it('collapses to a single builder node with NO LLM call', async () => {
    const res = await buildPlan('fix the typo', 'simple', settings)
    expect(res.usedLlm).toBe(false)
    expect(getCompletion).not.toHaveBeenCalled()
    expect(res.tasks).toHaveLength(1)
    expect(res.tasks[0]).toMatchObject({ role: 'builder', dependsOn: [], state: 'pending', attempts: 0 })
    expect(res.tasks[0].description).toContain('fix the typo')
  })
})

describe('buildPlan — LLM plan parsing', () => {
  it('parses a valid dependency graph into task nodes (one completion)', async () => {
    getCompletion.mockResolvedValue(
      plan([
        { id: 't1', role: 'database', description: 'create the schema', dependsOn: [], filesHint: ['db.ts'] },
        { id: 't2', role: 'backend', description: 'build the API', dependsOn: ['t1'], filesHint: ['api.ts'] },
        { id: 't3', role: 'frontend', description: 'build the UI', dependsOn: ['t2'] }
      ])
    )
    const res = await buildPlan('build the app', 'complex', settings)
    expect(getCompletion).toHaveBeenCalledTimes(1)
    expect(res.usedLlm).toBe(true)
    expect(res.tasks.map((t) => t.role)).toEqual(['database', 'backend', 'frontend'])
    expect(res.tasks[1].dependsOn).toEqual(['t1'])
    expect(res.tasks[2].dependsOn).toEqual(['t2'])
  })

  it('parses a fenced ```json plan', async () => {
    getCompletion.mockResolvedValue(
      '```json\n' + plan([{ id: 'a', role: 'backend', description: 'do it', dependsOn: [] }]) + '\n```'
    )
    const res = await buildPlan('do the backend', 'medium', settings)
    expect(res.tasks).toHaveLength(1)
    expect(res.tasks[0].role).toBe('backend')
  })

  it('maps an unknown role to the generalist builder', async () => {
    getCompletion.mockResolvedValue(plan([{ id: 't1', role: 'wizard', description: 'cast a spell' }]))
    const res = await buildPlan('do magic', 'medium', settings)
    expect(res.tasks[0].role).toBe('builder')
  })

  it('drops a dependency that references a non-existent task', async () => {
    getCompletion.mockResolvedValue(
      plan([{ id: 't1', role: 'backend', description: 'x', dependsOn: ['ghost'] }])
    )
    const res = await buildPlan('do x', 'medium', settings)
    expect(res.tasks[0].dependsOn).toEqual([])
  })

  it('serializes two tasks that write the same file', async () => {
    getCompletion.mockResolvedValue(
      plan([
        { id: 't1', role: 'backend', description: 'edit shared', filesHint: ['shared.ts'] },
        { id: 't2', role: 'frontend', description: 'also edit shared', filesHint: ['shared.ts'] }
      ])
    )
    const res = await buildPlan('touch shared', 'complex', settings)
    // Later writer (t2) is made to depend on the earlier one (t1).
    expect(res.tasks[1].dependsOn).toContain('t1')
  })

  it('caps the plan at the task ceiling', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i + 1}`,
      role: 'builder',
      description: `task ${i + 1}`
    }))
    getCompletion.mockResolvedValue(plan(many))
    const res = await buildPlan('do lots', 'complex', settings)
    expect(res.tasks.length).toBeLessThanOrEqual(8)
  })
})

describe('buildPlan — robustness fallbacks', () => {
  it('falls back to a single node when the response is unparseable', async () => {
    getCompletion.mockResolvedValue('here is my plan: do everything, trust me')
    const res = await buildPlan('build stuff', 'medium', settings)
    expect(res.tasks).toHaveLength(1)
    expect(res.tasks[0].role).toBe('builder')
    expect(res.usedLlm).toBe(true) // a completion was still spent
  })

  it('falls back to a single node when the provider throws', async () => {
    getCompletion.mockRejectedValue(new Error('provider down'))
    const res = await buildPlan('build stuff', 'complex', settings)
    expect(res.tasks).toHaveLength(1)
    expect(res.tasks[0].role).toBe('builder')
  })

  it('falls back to a single node when the plan contains a dependency cycle', async () => {
    getCompletion.mockResolvedValue(
      plan([
        { id: 't1', role: 'backend', description: 'a', dependsOn: ['t2'] },
        { id: 't2', role: 'frontend', description: 'b', dependsOn: ['t1'] }
      ])
    )
    const res = await buildPlan('cyclic', 'complex', settings)
    expect(res.tasks).toHaveLength(1)
    expect(res.tasks[0].role).toBe('builder')
  })

  it('falls back when every task is missing a description', async () => {
    getCompletion.mockResolvedValue(plan([{ id: 't1', role: 'backend' }, { role: 'frontend' }]))
    const res = await buildPlan('empty', 'medium', settings)
    expect(res.tasks).toHaveLength(1)
  })
})

describe('buildPlan — degradation is reported, not hidden', () => {
  // A fallback turns a multi-domain request into one generalist node. That is a
  // real loss of fidelity, so it has to reach the user rather than look like the
  // plan they asked for.
  it('reports the provider error behind a fallback', async () => {
    getCompletion.mockRejectedValue(new Error('Request timed out after 600000ms'))
    const onDegraded = vi.fn()
    await buildPlan('build stuff', 'complex', settings, { onDegraded })
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded.mock.calls[0][0]).toMatch(/timed out/i)
  })

  it('reports an answer that parsed to nothing usable', async () => {
    getCompletion.mockResolvedValue('here is my plan: do everything, trust me')
    const onDegraded = vi.fn()
    await buildPlan('build stuff', 'medium', settings, { onDegraded })
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded.mock.calls[0][0]).toMatch(/task graph/i)
  })

  it('stays quiet when a user Stop cancelled the planner', async () => {
    // A cancellation is not a degradation — the user already knows.
    getCompletion.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const onDegraded = vi.fn()
    await buildPlan('build stuff', 'complex', settings, { onDegraded })
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it('stays quiet on a plan that parsed fine', async () => {
    getCompletion.mockResolvedValue(plan([{ id: 't1', role: 'backend', description: 'do it' }]))
    const onDegraded = vi.fn()
    const res = await buildPlan('do it', 'medium', settings, { onDegraded })
    expect(res.tasks).toHaveLength(1)
    expect(onDegraded).not.toHaveBeenCalled()
  })
})

describe('buildPlan — explicit task cap (Principle 1)', () => {
  const many = (n: number): unknown =>
    plan(
      Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, role: 'builder', description: `task ${i + 1}` }))
    )

  it('honours a maxTasks below the default ceiling', async () => {
    getCompletion.mockResolvedValue(many(12))
    const res = await buildPlan('do lots', 'complex', settings, { maxTasks: 3 })
    expect(res.tasks).toHaveLength(3)
  })

  it('tells the planner the exact ceiling in its prompt', async () => {
    getCompletion.mockResolvedValue(many(2))
    await buildPlan('do it', 'medium', settings, { maxTasks: 3 })
    const system = getCompletion.mock.calls[0][1][0].content as string
    expect(system).toContain('at most 3')
  })

  it('cannot be used to raise the ceiling above the runaway guard', async () => {
    getCompletion.mockResolvedValue(many(12))
    const res = await buildPlan('do lots', 'complex', settings, { maxTasks: 50 })
    expect(res.tasks.length).toBeLessThanOrEqual(8)
  })

  it('restates the user scope to the planner as a hard constraint', async () => {
    getCompletion.mockResolvedValue(many(2))
    await buildPlan('do it', 'medium', settings, {
      maxTasks: 4,
      constraintsNote: 'Explicit scope set by the user — honour it exactly: use at most 4 tasks.'
    })
    const system = getCompletion.mock.calls[0][1][0].content as string
    expect(system).toContain('HARD CONSTRAINTS')
    expect(system).toContain('use at most 4 tasks')
    expect(system).toContain('no more than 4 tasks in total')
  })
})

describe('plan persistence + rendering', () => {
  it('hands the rendered markdown to the writePlan callback', async () => {
    const writePlan = vi.fn()
    await buildPlan('fix the typo', 'simple', settings, { writePlan })
    expect(writePlan).toHaveBeenCalledTimes(1)
    expect(writePlan.mock.calls[0][0]).toContain('# Plan')
  })

  it('renders a checkable task list in the existing plan.md convention', () => {
    const md = renderPlanMarkdown('medium', [
      { id: 't1', role: 'backend', description: 'build the API', dependsOn: [], state: 'pending', attempts: 0 },
      { id: 't2', role: 'frontend', description: 'build the UI', dependsOn: ['t1'], state: 'pending', attempts: 0 }
    ])
    expect(md).toContain('- [ ] **t1** (backend) build the API')
    expect(md).toContain('_(depends on: t1)_')
    expect(md).toContain('**Complexity:** medium')
  })
})
