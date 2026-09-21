import { describe, it, expect } from 'vitest'
import { slugify, toolNameFor } from './manager'

/*
 * The manager's connection logic drives real child processes / sockets, so the unit
 * tests cover the pure, deterministic pieces that shape behaviour: the name
 * slugification and the tool namespacing that guarantees connectors can't collide
 * with built-ins or each other.
 */

describe('slugify', () => {
  it('lowercases and replaces runs of non-alphanumerics with a single underscore', () => {
    expect(slugify('GitHub API')).toBe('github_api')
    expect(slugify('My  Cool   Server!!')).toBe('my_cool_server')
  })
  it('trims leading/trailing underscores', () => {
    expect(slugify('  @scope/thing  ')).toBe('scope_thing')
    expect(slugify('--x--')).toBe('x')
  })
  it('falls back to "server" when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('server')
    expect(slugify('')).toBe('server')
  })
  it('caps very long names', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40)
  })
})

describe('toolNameFor', () => {
  it('namespaces a server tool as mcp__<slug>__<tool>', () => {
    expect(toolNameFor('GitHub', 'create_issue')).toBe('mcp__github__create_issue')
  })
  it('keeps two servers from colliding on the same tool name', () => {
    expect(toolNameFor('Server A', 'run')).not.toBe(toolNameFor('Server B', 'run'))
  })
})
