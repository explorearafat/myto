import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPlugin, listPlugins, removePlugin } from '@main/plugins/installer'

let pluginDir: string
let projectRoot: string

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), 'sylor-plugsrc-'))
  projectRoot = mkdtempSync(join(tmpdir(), 'sylor-proj-'))
})
afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
})

/** Writes `content` to `pluginDir/rel`, creating parent dirs. */
function seed(rel: string, content: string): void {
  const path = join(pluginDir, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

/** Lays down a plugin repo carrying one skill, one command, and one connector. */
function seedFullPlugin(): void {
  seed('skills/greet/SKILL.md', '---\nname: greet\ndescription: Greets\n---\nSay hi to $ARGUMENTS.')
  seed('commands/deploy.md', '---\ndescription: Deploy\nargument-hint: [env]\n---\nDeploy to $ARGUMENTS.')
  seed('mcp.json', JSON.stringify({ mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'] } } }))
}

describe('installPlugin (local source, project scope)', () => {
  it('discovers, writes every item into the scope, and records a manifest', async () => {
    seedFullPlugin()
    const res = await installPlugin({ source: pluginDir, scope: 'project' }, projectRoot)

    expect(res.ok).toBe(true)
    expect(res.plugin?.contents).toEqual({
      skills: ['greet'],
      commands: ['deploy'],
      connectors: ['time']
    })

    // Artifacts landed under the project's .sylor tree.
    expect(existsSync(join(projectRoot, '.sylor', 'skills', 'greet', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(projectRoot, '.sylor', 'commands', 'deploy.md'))).toBe(true)
    const mcp = JSON.parse(readFileSync(join(projectRoot, '.sylor', 'mcp.json'), 'utf-8'))
    expect(mcp.mcpServers.time).toEqual({ command: 'uvx', args: ['mcp-server-time'] })

    // The manifest lists it, and so does listPlugins.
    expect(listPlugins(projectRoot).map((p) => p.name)).toContain(res.plugin?.name)
  })

  it('uninstalls every artifact it wrote and forgets the plugin', async () => {
    seedFullPlugin()
    const res = await installPlugin({ source: pluginDir, scope: 'project' }, projectRoot)
    const name = res.plugin!.name

    const remaining = removePlugin(name, projectRoot)
    expect(remaining.some((p) => p.name === name)).toBe(false)
    expect(existsSync(join(projectRoot, '.sylor', 'skills', 'greet', 'SKILL.md'))).toBe(false)
    expect(existsSync(join(projectRoot, '.sylor', 'commands', 'deploy.md'))).toBe(false)
    const mcp = JSON.parse(readFileSync(join(projectRoot, '.sylor', 'mcp.json'), 'utf-8'))
    expect(mcp.mcpServers.time).toBeUndefined()
  })

  it('reinstalling the same source replaces rather than duplicates', async () => {
    seedFullPlugin()
    const first = await installPlugin({ source: pluginDir, scope: 'project' }, projectRoot)
    const second = await installPlugin({ source: pluginDir, scope: 'project' }, projectRoot)
    expect(second.ok).toBe(true)
    const mine = listPlugins(projectRoot).filter((p) => p.name === first.plugin?.name)
    expect(mine).toHaveLength(1)
  })

  it('fails cleanly on an empty source and on an unrecognized one', async () => {
    const empty = await installPlugin({ source: pluginDir, scope: 'project' }, projectRoot)
    expect(empty.ok).toBe(false)
    expect(empty.error).toMatch(/no skills, commands, or connectors/i)

    const bad = await installPlugin({ source: '   ', scope: 'project' }, projectRoot)
    expect(bad.ok).toBe(false)
  })

  it('refuses a project install with no open project', async () => {
    seedFullPlugin()
    const res = await installPlugin({ source: pluginDir, scope: 'project' }, null)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/project/i)
  })
})
