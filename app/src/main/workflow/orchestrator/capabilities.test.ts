import { describe, expect, it } from 'vitest'
import type { McpCategory, McpToolInfo, SkillInfo } from '@shared/types'
import {
  allowsTool,
  mcpCategoriesFor,
  scopeMcpTools,
  scopeSkills,
  serverCategoryMap
} from '@main/workflow/orchestrator/capabilities'

const tool = (server: string, name: string): McpToolInfo => ({ server, name, description: '' })

const skill = (name: string, category?: SkillInfo['category']): SkillInfo => ({
  name,
  description: '',
  whenToUse: '',
  instructions: 'do the thing',
  source: 'global',
  path: '',
  category
})

const SERVERS: { name: string; category: McpCategory }[] = [
  { name: 'git', category: 'git' },
  { name: 'fetch', category: 'web' },
  { name: 'playwright', category: 'browser' },
  { name: 'sequential-thinking', category: 'core' }
]

describe('mcpCategoriesFor', () => {
  it('maps a capability to its categories and always adds core when non-empty', () => {
    expect([...mcpCategoriesFor(['web'])].sort()).toEqual(['core', 'web'])
  })

  it('is empty for a capability set with no MCP grant', () => {
    expect(mcpCategoriesFor(['terminal']).size).toBe(0)
  })

  it('grants every category for the broad mcp capability', () => {
    const cats = mcpCategoriesFor(['mcp'])
    expect(cats.has('git')).toBe(true)
    expect(cats.has('external')).toBe(true)
    expect(cats.has('database')).toBe(true)
  })
})

describe('scopeMcpTools', () => {
  const map = serverCategoryMap(SERVERS)
  const tools = [tool('git', 'commit'), tool('fetch', 'get'), tool('playwright', 'click')]

  it('shows a git-capable role only git tools', () => {
    expect(scopeMcpTools(tools, ['git'], map).map((t) => t.server)).toEqual(['git'])
  })

  it('shows a web-capable role only web tools', () => {
    expect(scopeMcpTools(tools, ['web'], map).map((t) => t.server)).toEqual(['fetch'])
  })

  it('shows a broad mcp role every tool', () => {
    expect(scopeMcpTools(tools, ['mcp'], map)).toHaveLength(3)
  })

  it('shows a role with no MCP grant nothing', () => {
    expect(scopeMcpTools(tools, ['terminal'], map)).toEqual([])
  })

  it('treats an unknown server as external (only broad mcp roles see it)', () => {
    const unknown = [tool('mystery', 'do')]
    expect(scopeMcpTools(unknown, ['git'], map)).toEqual([])
    expect(scopeMcpTools(unknown, ['mcp'], map)).toHaveLength(1)
  })
})

describe('allowsTool', () => {
  it('lets every role read the project, whatever it is scoped to', () => {
    // A reviewer that could not read files could not review. Scoping is about
    // what an agent may CHANGE.
    expect(allowsTool(['terminal', 'testing'], 'read')).toBe(true)
    expect(allowsTool([], 'read')).toBe(true)
  })

  it('lets a filesystem role write files', () => {
    expect(allowsTool(['filesystem'], 'write_file')).toBe(true)
  })

  it('forbids a reviewer (terminal/testing only) from writing files', () => {
    expect(allowsTool(['terminal', 'testing', 'code-exec'], 'write_file')).toBe(false)
  })

  it('lets terminal/code-exec/testing roles run commands', () => {
    expect(allowsTool(['terminal'], 'run_command')).toBe(true)
    expect(allowsTool(['code-exec'], 'run_command')).toBe(true)
    expect(allowsTool(['testing'], 'run_command')).toBe(true)
  })

  it('forbids run_command for a filesystem-only role', () => {
    expect(allowsTool(['filesystem'], 'run_command')).toBe(false)
  })

  it('lets any MCP-granting role call mcp', () => {
    expect(allowsTool(['web'], 'mcp_call')).toBe(true)
    expect(allowsTool(['mcp'], 'mcp_call')).toBe(true)
  })

  it('forbids mcp_call for a role with no MCP grant', () => {
    expect(allowsTool(['terminal'], 'mcp_call')).toBe(false)
  })
})

describe('scopeSkills', () => {
  const skills = [
    skill('git-workflow', 'git'),
    skill('web-research', 'web'),
    skill('code-helper', 'coding'),
    skill('unlabeled')
  ]

  it('drops an off-domain skill a role lacks the capability for', () => {
    expect(scopeSkills(skills, ['filesystem']).map((s) => s.name)).toEqual([
      'code-helper',
      'unlabeled'
    ])
  })

  it('keeps a domain skill for a role that has the capability', () => {
    expect(scopeSkills(skills, ['git']).map((s) => s.name)).toContain('git-workflow')
  })

  it('always keeps general and uncategorized skills', () => {
    const kept = scopeSkills(skills, ['terminal']).map((s) => s.name)
    expect(kept).toContain('code-helper')
    expect(kept).toContain('unlabeled')
  })
})
