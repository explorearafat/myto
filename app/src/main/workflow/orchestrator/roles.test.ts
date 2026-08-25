import { describe, expect, it } from 'vitest'
import {
  allRoles,
  getRole,
  hasRole,
  registerRole,
  resolveRole,
  roleDirective,
  roleIds
} from '@main/workflow/orchestrator/roles'

describe('role registry', () => {
  it('contains the four historical roles', () => {
    for (const id of ['lead', 'planner', 'builder', 'reviewer']) {
      expect(hasRole(id)).toBe(true)
    }
  })

  it('contains the new specialist roles', () => {
    for (const id of [
      'project-analyst',
      'frontend',
      'backend',
      'database',
      'security',
      'research',
      'devops',
      'testing',
      'docs',
      'integration'
    ]) {
      expect(hasRole(id)).toBe(true)
    }
  })

  it('resolves an unknown role to the builder fallback', () => {
    expect(getRole('does-not-exist')).toBeUndefined()
    expect(resolveRole('does-not-exist').id).toBe('builder')
  })

  it('gives the reviewer no filesystem capability (cannot write code it judges)', () => {
    expect(getRole('reviewer')!.capabilities).not.toContain('filesystem')
  })

  it('lets a new role be registered at runtime and immediately used', () => {
    registerRole({
      id: 'ml-engineer',
      title: 'ML Engineer',
      systemDirective: 'You are the ML specialist.',
      capabilities: ['filesystem', 'terminal', 'code-exec'],
      contextScope: 'scoped'
    })
    expect(hasRole('ml-engineer')).toBe(true)
    expect(roleIds()).toContain('ml-engineer')
    expect(resolveRole('ml-engineer').title).toBe('ML Engineer')
    expect(roleDirective('ml-engineer')).toBe('\n\nYou are the ML specialist.')
  })

  it('every role carries a non-empty capability set except the directive-less lead', () => {
    for (const def of allRoles()) {
      expect(def.capabilities.length).toBeGreaterThan(0)
    }
  })
})

describe('roleDirective (backward compatibility)', () => {
  it('prefixes the mandate with the historical double-newline separator', () => {
    expect(roleDirective('planner')).toBe(`\n\n${getRole('planner')!.systemDirective}`)
  })

  it('returns an empty string for the lead (its prompt is built by the engine)', () => {
    expect(roleDirective('lead')).toBe('')
  })

  it('keeps the historical planner mandate intact', () => {
    const d = roleDirective('planner')
    expect(d.startsWith('\n\nYou are the PLANNER subagent.')).toBe(true)
    expect(d).toContain('Produce or refine `plan.md`')
    expect(d).toContain('Do NOT implement the feature')
    expect(d.endsWith('summary of the plan for the lead.')).toBe(true)
  })

  it('keeps the historical builder mandate intact', () => {
    const d = roleDirective('builder')
    expect(d.startsWith('\n\nYou are the BUILDER subagent.')).toBe(true)
    expect(d).toContain('Implement exactly the slice')
    expect(d.endsWith('anything still open.')).toBe(true)
  })

  it('keeps the historical reviewer mandate intact', () => {
    const d = roleDirective('reviewer')
    expect(d.startsWith('\n\nYou are the REVIEWER subagent.')).toBe(true)
    expect(d).toContain('PASS or FAIL verdict')
    expect(d).toContain('Do NOT rewrite the feature')
  })
})
