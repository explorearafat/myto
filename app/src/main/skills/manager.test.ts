import { describe, it, expect, afterEach } from 'vitest'
import { skillSlug, skillToolName, syncSkills } from './manager'
import {
  clearExtensionTools,
  extensionToolNames,
  lookupTool,
  type ToolGate
} from '../tools/registry'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { SkillConfig } from '../../shared/types'

const skill = (over: Partial<SkillConfig> = {}): SkillConfig => ({
  id: 'x',
  name: 'Code Review',
  description: 'Review a diff',
  instructions: 'Look for bugs, then style.',
  enabled: true,
  ...over
})

const gate: ToolGate = { settings: DEFAULT_PROVIDER_SETTINGS, mode: 'chat', workspaceDir: null }
const ctx = { ...gate, signal: new AbortController().signal }

afterEach(() => clearExtensionTools())

describe('skillSlug', () => {
  it('slugifies a name, falling back to "skill"', () => {
    expect(skillSlug('PDF Forms')).toBe('pdf_forms')
    expect(skillSlug('!!!')).toBe('skill')
  })
})

describe('skillToolName', () => {
  it('prefixes with skill__', () => {
    expect(skillToolName('Code Review')).toBe('skill__code_review')
  })
})

describe('syncSkills', () => {
  it('registers a tool per enabled skill', () => {
    syncSkills([skill({ id: 'a', name: 'Alpha' }), skill({ id: 'b', name: 'Beta' })])
    expect(extensionToolNames()).toEqual(
      expect.arrayContaining(['skill__alpha', 'skill__beta'])
    )
  })

  it('skips disabled skills', () => {
    syncSkills([skill({ id: 'a', name: 'Alpha', enabled: false })])
    expect(lookupTool('skill__alpha')).toBeUndefined()
  })

  it('clears stale skill tools on re-sync (rename/disable/edit)', () => {
    syncSkills([skill({ id: 'a', name: 'Alpha' })])
    expect(lookupTool('skill__alpha')).toBeDefined()
    // Rename → the old tool must not linger.
    syncSkills([skill({ id: 'a', name: 'Renamed' })])
    expect(lookupTool('skill__alpha')).toBeUndefined()
    expect(lookupTool('skill__renamed')).toBeDefined()
  })

  it('the skill tool returns the instructions when run', async () => {
    syncSkills([skill({ name: 'Alpha', instructions: 'do the thing' })])
    const out = await lookupTool('skill__alpha')!.run({}, ctx)
    expect(out).toContain('do the thing')
    expect(out).toContain('Alpha')
  })

  it('the skill tool is read-only', () => {
    syncSkills([skill({ name: 'Alpha' })])
    expect(lookupTool('skill__alpha')!.sideEffect).toBeUndefined()
  })

  it('merges file-discovered skills alongside settings skills', () => {
    syncSkills([skill({ id: 's', name: 'Settings One' })], [skill({ id: 'file:disk', name: 'Disk One' })])
    expect(extensionToolNames()).toEqual(
      expect.arrayContaining(['skill__settings_one', 'skill__disk_one'])
    )
  })

  it('lets a settings skill win a slug collision with a discovered one (even if disabled)', () => {
    // Same slug "shared": the file must NOT shadow or re-enable the user's own skill.
    syncSkills(
      [skill({ id: 's', name: 'Shared', enabled: false, instructions: 'from settings' })],
      [skill({ id: 'file:x', name: 'Shared', enabled: true, instructions: 'from disk' })]
    )
    // The user disabled it → no tool registered, and the disk copy did not sneak in.
    expect(lookupTool('skill__shared')).toBeUndefined()
  })
})
