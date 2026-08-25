import { describe, expect, it, vi } from 'vitest'
import type { TaskNode } from '@shared/types'
import { TaskGraph, linkOverlappingWriters, runScheduler } from '@main/workflow/orchestrator/taskGraph'

/** Builds a task node with sensible defaults. */
function node(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return { id, role: 'builder', description: id, dependsOn: [], state: 'pending', attempts: 0, ...overrides }
}

describe('TaskGraph construction + validation', () => {
  it('throws on a duplicate task id', () => {
    expect(() => new TaskGraph([node('a'), node('a')])).toThrow(/duplicate/i)
  })

  it('throws on a dependency that references an unknown task', () => {
    expect(() => new TaskGraph([node('a', { dependsOn: ['ghost'] })])).toThrow(/unknown task/i)
  })

  it('throws on a dependency cycle', () => {
    expect(
      () => new TaskGraph([node('a', { dependsOn: ['b'] }), node('b', { dependsOn: ['a'] })])
    ).toThrow(/cycle/i)
  })

  it('accepts a valid DAG', () => {
    expect(() => new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])).not.toThrow()
  })
})

describe('TaskGraph ready set + state derivation', () => {
  it('computes the initial ready set from dependency-free nodes', () => {
    const graph = new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])
    expect(graph.ready().map((n) => n.id)).toEqual(['a'])
    expect(graph.get('a')!.state).toBe('ready')
    expect(graph.get('b')!.state).toBe('pending')
  })

  it('promotes a dependent to ready once its dependency completes', () => {
    const graph = new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])
    graph.markRunning('a')
    graph.markCompleted('a')
    const changed = graph.recompute()
    expect(changed.map((n) => n.id)).toEqual(['b'])
    expect(graph.get('b')!.state).toBe('ready')
  })

  it('blocks a dependent when its dependency fails', () => {
    const graph = new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])
    graph.markRunning('a')
    graph.markFailed('a', 'boom')
    graph.recompute()
    expect(graph.get('b')!.state).toBe('blocked')
    expect(graph.hasBlocked()).toBe(true)
  })
})

describe('runScheduler', () => {
  it('runs a dependent only after its dependency completes', async () => {
    const graph = new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])
    const order: string[] = []
    await runScheduler(graph, async (n) => {
      order.push(n.id)
      return { ok: true, result: `${n.id} done` }
    })
    expect(order).toEqual(['a', 'b'])
    expect(graph.get('b')!.state).toBe('completed')
    expect(graph.get('a')!.result).toBe('a done')
  })

  it('runs independent nodes in parallel', async () => {
    const graph = new TaskGraph([node('a'), node('b')])
    let running = 0
    let maxRunning = 0
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    await runScheduler(graph, async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      started++
      if (started === 2) release() // both are in flight → let them finish
      await gate
      running--
      return { ok: true }
    })
    expect(maxRunning).toBe(2)
  })

  it('respects the concurrency bound', async () => {
    const graph = new TaskGraph([node('a'), node('b'), node('c')])
    let running = 0
    let maxRunning = 0
    await runScheduler(
      graph,
      async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await Promise.resolve()
        running--
        return { ok: true }
      },
      { concurrency: 1 }
    )
    expect(maxRunning).toBe(1)
    expect(graph.all.every((n) => n.state === 'completed')).toBe(true)
  })

  it('does not dispatch a node whose dependency failed', async () => {
    const graph = new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])
    const execute = vi.fn(async (n: TaskNode) =>
      n.id === 'a' ? { ok: false, error: 'nope' } : { ok: true }
    )
    await runScheduler(graph, execute)
    expect(execute).toHaveBeenCalledTimes(1) // only 'a' ran
    expect(graph.get('a')!.state).toBe('failed')
    expect(graph.get('b')!.state).toBe('blocked')
  })

  it('retries a failed node up to maxAttempts then succeeds', async () => {
    const graph = new TaskGraph([node('a')])
    let calls = 0
    await runScheduler(
      graph,
      async () => {
        calls++
        return calls < 2 ? { ok: false, error: 'transient' } : { ok: true }
      },
      { maxAttempts: 2 }
    )
    expect(calls).toBe(2)
    expect(graph.get('a')!.state).toBe('completed')
    expect(graph.get('a')!.attempts).toBe(2)
  })

  it('marks a node failed after exhausting retries', async () => {
    const graph = new TaskGraph([node('a')])
    await runScheduler(graph, async () => ({ ok: false, error: 'always' }), { maxAttempts: 2 })
    expect(graph.get('a')!.state).toBe('failed')
    expect(graph.get('a')!.attempts).toBe(2)
  })

  it('cancels everything when the signal is already aborted', async () => {
    const graph = new TaskGraph([node('a'), node('b')])
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn(async () => ({ ok: true }))
    await runScheduler(graph, execute, { signal: controller.signal })
    expect(execute).not.toHaveBeenCalled()
    expect(graph.all.every((n) => n.state === 'cancelled')).toBe(true)
  })

  it('cancels remaining nodes when aborted mid-run', async () => {
    const graph = new TaskGraph([node('a'), node('b', { dependsOn: ['a'] })])
    const controller = new AbortController()
    await runScheduler(
      graph,
      async (n) => {
        if (n.id === 'a') controller.abort()
        return { ok: true }
      },
      { signal: controller.signal }
    )
    expect(graph.get('b')!.state).toBe('cancelled')
  })

  it('emits a state-change callback for lifecycle transitions', async () => {
    const graph = new TaskGraph([node('a')])
    const states: string[] = []
    await runScheduler(graph, async () => ({ ok: true }), {
      onStateChange: (n) => states.push(n.state)
    })
    expect(states).toContain('running')
    expect(states).toContain('completed')
  })
})

describe('linkOverlappingWriters', () => {
  it('serializes two writers that touch the same file', () => {
    const nodes = [node('a', { filesHint: ['x.ts'] }), node('b', { filesHint: ['x.ts'] })]
    linkOverlappingWriters(nodes)
    expect(nodes[1].dependsOn).toContain('a')
    expect(nodes[0].dependsOn).not.toContain('b')
  })

  it('leaves non-overlapping writers independent', () => {
    const nodes = [node('a', { filesHint: ['x.ts'] }), node('b', { filesHint: ['y.ts'] })]
    linkOverlappingWriters(nodes)
    expect(nodes[1].dependsOn).toEqual([])
  })

  it('never reverses an existing dependency into a cycle', () => {
    const nodes = [node('a', { filesHint: ['x.ts'], dependsOn: ['b'] }), node('b', { filesHint: ['x.ts'] })]
    linkOverlappingWriters(nodes)
    expect(nodes[1].dependsOn).not.toContain('a')
    expect(() => new TaskGraph(nodes)).not.toThrow()
  })
})
