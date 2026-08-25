import { describe, expect, it } from 'vitest'
import type { AgentRole, Finding, TaskNode } from '@shared/types'
import { SharedContext } from '@main/workflow/orchestrator/sharedContext'
import { TaskGraph } from '@main/workflow/orchestrator/taskGraph'

function node(id: string, role: AgentRole, dependsOn: string[] = []): TaskNode {
  return { id, role, description: id, dependsOn, state: 'pending', attempts: 0 }
}

function finding(taskId: string, role: AgentRole, detail: string): Finding {
  return { agentId: `agent-${taskId}`, taskId, role, detail }
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
