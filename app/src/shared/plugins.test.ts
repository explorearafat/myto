import { describe, it, expect } from 'vitest'
import { expandPluginManifest } from './plugins'

describe('expandPluginManifest', () => {
  it('rejects non-JSON', () => {
    expect(() => expandPluginManifest('not json')).toThrow(/valid JSON/i)
  })

  it('requires a name', () => {
    expect(() => expandPluginManifest('{"skills":[]}')).toThrow(/name/i)
  })

  it('rejects a manifest that installs nothing', () => {
    expect(() => expandPluginManifest('{"name":"Empty"}')).toThrow(/installs nothing/i)
  })

  it('expands skills and connectors, tagging each with the plugin id', () => {
    const { plugin, skills, mcpServers } = expandPluginManifest(
      JSON.stringify({
        name: 'Kit',
        description: 'a bundle',
        skills: [{ name: 'S', description: 'd', instructions: 'do it' }],
        mcpServers: [{ name: 'Srv', transport: 'stdio', command: 'npx', args: ['x'] }]
      })
    )
    expect(plugin.name).toBe('Kit')
    expect(plugin.enabled).toBe(true)
    expect(skills).toHaveLength(1)
    expect(mcpServers).toHaveLength(1)
    // Every installed item is tagged with the plugin's id so uninstall can find them.
    expect(skills[0].source).toBe(plugin.id)
    expect(mcpServers[0].source).toBe(plugin.id)
    expect(skills[0].enabled).toBe(true)
    expect(mcpServers[0]).toMatchObject({ transport: 'stdio', command: 'npx', args: ['x'] })
  })

  it('drops malformed items but keeps valid ones', () => {
    const { skills, mcpServers } = expandPluginManifest(
      JSON.stringify({
        name: 'Kit',
        skills: [
          { name: 'no instructions' },
          { name: 'ok', instructions: 'keep' }
        ],
        mcpServers: [
          { name: 'no command', transport: 'stdio' },
          { name: 'ok http', transport: 'http', url: 'https://x/mcp' }
        ]
      })
    )
    expect(skills.map((s) => s.name)).toEqual(['ok'])
    expect(mcpServers.map((s) => s.name)).toEqual(['ok http'])
  })

  it('gives every item a distinct id', () => {
    const { skills, mcpServers } = expandPluginManifest(
      JSON.stringify({
        name: 'Kit',
        skills: [
          { name: 'A', instructions: 'x' },
          { name: 'B', instructions: 'y' }
        ],
        mcpServers: [{ name: 'S', transport: 'http', url: 'https://x' }]
      })
    )
    const ids = [...skills.map((s) => s.id), ...mcpServers.map((s) => s.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
