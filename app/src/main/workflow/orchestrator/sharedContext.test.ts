import { describe, expect, it } from 'vitest'
import type { AgentRole, Evidence, Finding, TaskNode } from '@shared/types'
import { SharedContext } from '@main/workflow/orchestrator/sharedContext'
import { TaskGraph } from '@main/workflow/orchestrator/taskGraph'

function node(id: string, role: AgentRole, dependsOn: string[] = []): TaskNode {
  return { id, role, description: id, dependsOn, state: 'pending', attempts: 0 }
}

function finding(taskId: string, role: AgentRole, detail: string): Finding {
  return { agentId: `agent-${taskId}`, taskId, role, detail }
}

function ev(path: string, range: [number, number], excerpt: string, sha = 'abc123def456'): Evidence {
  return { path, range, sha, excerpt }
}

function findingWithEvidence(
  taskId: string,
  role: AgentRole,
  detail: string,
  evidence: Evidence[]
): Finding {
  return { ...finding(taskId, role, detail), evidence }
}

describe('SharedContext scoping', () => {
  it('gives a scoped role only its upstream dependency findings', () => {
    const graph = new TaskGraph([
      node('t1', 'database'),
      node('t2', 'frontend'),
      node('t3', 'backend', ['t1']) // depends on t1 only
    ])
    const ctx = new SharedContext('build the app', { graph })
    ctx.addFinding(finding('t1', 'database', 'schema: users table ready'))
    ctx.addFinding(finding('t2', 'frontend', 'ui uses the design system'))

    const digest = ctx.summarizeForAgent(graph.get('t3')!)
    expect(digest).toContain('schema: users table ready')
    expect(digest).not.toContain('ui uses the design system')
  })

  it('gives a full-scope role every finding', () => {
    const graph = new TaskGraph([
      node('t1', 'database'),
      node('t2', 'frontend'),
      node('i', 'integration', ['t1', 't2'])
    ])
    const ctx = new SharedContext('build the app', { graph })
    ctx.addFinding(finding('t1', 'database', 'schema ready'))
    ctx.addFinding(finding('t2', 'frontend', 'ui ready'))

    const digest = ctx.summarizeForAgent(graph.get('i')!)
    expect(digest).toContain('schema ready')
    expect(digest).toContain('ui ready')
  })

  it('gives a minimal-scope reviewer the plan but not the raw finding firehose', () => {
    const graph = new TaskGraph([node('t1', 'database')])
    const ctx = new SharedContext('build the app', { graph, plan: 'Goal: ship the feature' })
    ctx.addFinding(finding('t1', 'database', 'internal schema detail'))

    const digest = ctx.summarizeForAgent({ id: 'r', role: 'reviewer', dependsOn: [] })
    expect(digest).toContain('Goal: ship the feature')
    expect(digest).not.toContain('internal schema detail')
  })

  it('clamps an over-long finding detail', () => {
    const ctx = new SharedContext('x')
    ctx.addFinding(finding('t1', 'backend', 'y'.repeat(1000)))
    expect(ctx.allFindings()[0].detail.length).toBeLessThanOrEqual(601)
  })
})

/**
 * Evidence handoff (Principle 3): a scoped agent inherits the EXACT excerpts its
 * upstream dependencies read, so it builds on them instead of re-reading.
 */
describe('SharedContext evidence handoff', () => {
  it('hands a scoped role the exact excerpts its upstream dependencies read', () => {
    const graph = new TaskGraph([node('t1', 'explorer'), node('t3', 'editor', ['t1'])])
    const ctx = new SharedContext('build the app', { graph })
    ctx.addFinding(
      findingWithEvidence('t1', 'explorer', 'located the sign-in flow', [
        ev('src/auth.ts', [10, 24], 'export function signIn() { return broker.start() }', 'deadbeef1234')
      ])
    )

    const digest = ctx.summarizeForAgent(graph.get('t3')!)
    expect(digest).toContain('### Evidence')
    expect(digest).toContain('src/auth.ts')
    expect(digest).toContain('lines 10–24')
    expect(digest).toContain('deadbeef1234')
    expect(digest).toContain('export function signIn()')
  })

  it('does not hand a minimal reviewer the evidence excerpts', () => {
    const graph = new TaskGraph([node('t1', 'explorer')])
    const ctx = new SharedContext('build', { graph, plan: 'Goal: ship' })
    ctx.addFinding(
      findingWithEvidence('t1', 'explorer', 'found it', [
        ev('src/secret.ts', [1, 5], 'DISTINCTIVE-EXCERPT-BODY', 'aaa')
      ])
    )

    const digest = ctx.summarizeForAgent({ id: 'r', role: 'reviewer', dependsOn: [] })
    expect(digest).not.toContain('### Evidence')
    expect(digest).not.toContain('DISTINCTIVE-EXCERPT-BODY')
  })

  it('renders no Evidence section when upstream findings carry none', () => {
    const graph = new TaskGraph([node('t1', 'explorer'), node('t3', 'editor', ['t1'])])
    const ctx = new SharedContext('build', { graph })
    ctx.addFinding(finding('t1', 'explorer', 'plain prose, no excerpts'))

    const digest = ctx.summarizeForAgent(graph.get('t3')!)
    expect(digest).toContain('plain prose, no excerpts')
    expect(digest).not.toContain('### Evidence')
  })

  it('shows a repeated path+range once across findings', () => {
    const graph = new TaskGraph([
      node('t1', 'explorer'),
      node('t2', 'explorer'),
      node('t3', 'editor', ['t1', 't2'])
    ])
    const ctx = new SharedContext('build', { graph })
    ctx.addFinding(
      findingWithEvidence('t1', 'explorer', 'a', [ev('shared.ts', [1, 3], 'UNIQUE-EXCERPT', 's1')])
    )
    ctx.addFinding(
      findingWithEvidence('t2', 'explorer', 'b', [ev('shared.ts', [1, 3], 'UNIQUE-EXCERPT', 's1')])
    )

    const digest = ctx.summarizeForAgent(graph.get('t3')!)
    expect(digest.split('UNIQUE-EXCERPT').length - 1).toBe(1)
  })

  it('keeps the digest bounded even with many large excerpts', () => {
    const producers = Array.from({ length: 20 }, (_, i) => node(`t${i}`, 'explorer'))
    const editor = node(
      'e',
      'editor',
      producers.map((p) => p.id)
    )
    const graph = new TaskGraph([...producers, editor])
    const ctx = new SharedContext('build', { graph })
    producers.forEach((p, i) =>
      ctx.addFinding(
        findingWithEvidence(p.id, 'explorer', `f${i}`, [ev(`file${i}.ts`, [1, 100], 'X'.repeat(1_000), `sha${i}`)])
      )
    )

    const digest = ctx.summarizeForAgent(graph.get('e')!)
    expect(digest.length).toBeLessThanOrEqual(6_000) // MAX_DIGEST
  })
})
