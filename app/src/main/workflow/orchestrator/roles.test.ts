import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPORT_WORDS,
  allRoles,
  effortForRole,
  getRole,
  hasRole,
  registerRole,
  reportWordBudget,
  resolveRole,
  roleDirective,
  roleIds
} from '@main/workflow/orchestrator/roles'
import { allowsTool } from '@main/workflow/orchestrator/capabilities'

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

  it('makes the reviewer a static read-only reviewer (no verdict tests, no edits)', () => {
    const d = roleDirective('reviewer')
    expect(d.startsWith('\n\nYou are the REVIEWER subagent.')).toBe(true)
    expect(d).toContain('Statically review')
    expect(d).toContain('do NOT run commands')
    expect(d).toContain('No issues found.')
  })
})

describe('core loop roles (explorer / editor / test-runner / reviewer)', () => {
  it('registers explorer, editor, and test-runner', () => {
    for (const id of ['explorer', 'editor', 'test-runner']) {
      expect(hasRole(id)).toBe(true)
    }
  })

  it('explorer is read-only — reads but cannot write or run commands', () => {
    const caps = getRole('explorer')!.capabilities
    expect(caps).not.toContain('filesystem')
    expect(caps).not.toContain('terminal')
    expect(allowsTool(caps, 'read')).toBe(true)
    expect(allowsTool(caps, 'write_file')).toBe(false)
    expect(allowsTool(caps, 'run_command')).toBe(false)
    expect(getRole('explorer')!.contextScope).toBe('full')
  })

  it('editor can write files but cannot run commands', () => {
    const caps = getRole('editor')!.capabilities
    expect(allowsTool(caps, 'write_file')).toBe(true)
    expect(allowsTool(caps, 'run_command')).toBe(false)
  })

  it('test-runner can run commands but cannot write files', () => {
    const caps = getRole('test-runner')!.capabilities
    expect(caps).not.toContain('filesystem')
    expect(allowsTool(caps, 'run_command')).toBe(true)
    expect(allowsTool(caps, 'write_file')).toBe(false)
  })

  it('reviewer is static — reads but cannot write or run commands', () => {
    const caps = getRole('reviewer')!.capabilities
    expect(allowsTool(caps, 'read')).toBe(true)
    expect(allowsTool(caps, 'write_file')).toBe(false)
    expect(allowsTool(caps, 'run_command')).toBe(false)
  })
})

describe('reportWordBudget (handoff caps)', () => {
  it('uses each core role’s declared budget', () => {
    expect(reportWordBudget('explorer')).toBe(350)
    expect(reportWordBudget('editor')).toBe(150)
    expect(reportWordBudget('test-runner')).toBe(120)
    expect(reportWordBudget('reviewer')).toBe(200)
  })

  it('falls back to the default for a role with no explicit budget', () => {
    expect(reportWordBudget('builder')).toBe(DEFAULT_REPORT_WORDS)
    expect(reportWordBudget('does-not-exist')).toBe(DEFAULT_REPORT_WORDS)
  })

  it('gives the explorer a larger finding detail cap than the tight default', () => {
    expect(getRole('explorer')!.detailChars).toBeGreaterThan(600)
    expect(getRole('editor')!.detailChars).toBeUndefined()
  })
})

describe('effortForRole (Principle 5 — role reasoning bands)', () => {
  it('bands only the mechanical and the deep roles; the rest run at base', () => {
    expect(getRole('reviewer')!.defaultEffort).toBe('low')
    expect(getRole('test-runner')!.defaultEffort).toBe('low')
    expect(getRole('project-analyst')!.defaultEffort).toBe('high')
    // The everyday builder and the directive-less lead carry no band.
    expect(getRole('builder')!.defaultEffort).toBeUndefined()
    expect(getRole('lead')!.defaultEffort).toBeUndefined()
  })

  it('caps a cheap role at its band, never raising it (reviewer/test-runner → low)', () => {
    // Even when the turn was forced to max, a review/test step stays low.
    expect(effortForRole('max', 'reviewer')).toBe('low')
    expect(effortForRole('high', 'reviewer')).toBe('low')
    expect(effortForRole('medium', 'test-runner')).toBe('low')
    // Base already at/below the cap → unchanged (the cap never raises).
    expect(effortForRole('low', 'reviewer')).toBe('low')
  })

  it('floors a deep role at its band, never lowering it (analyst → ≥ high)', () => {
    expect(effortForRole('low', 'project-analyst')).toBe('high')
    expect(effortForRole('medium', 'project-analyst')).toBe('high')
    // Base already above the floor → unchanged (the floor never lowers).
    expect(effortForRole('max', 'project-analyst')).toBe('max')
  })

  it('runs an un-banded role at exactly the base tier', () => {
    for (const base of ['low', 'medium', 'high', 'max'] as const) {
      expect(effortForRole(base, 'builder')).toBe(base)
      expect(effortForRole(base, 'lead')).toBe(base)
    }
  })

  it('preserves the invariant: a complex turn can still reach max for its hard steps', () => {
    // A complex turn's base is `max`; an un-banded specialist keeps it.
    expect(effortForRole('max', 'frontend')).toBe('max')
    expect(effortForRole('max', 'backend')).toBe('max')
    expect(effortForRole('max', 'builder')).toBe('max')
  })

  it('runs an unknown role (builder fallback, no band) at the base tier', () => {
    expect(effortForRole('high', 'does-not-exist')).toBe('high')
  })
})
