import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPluginContents } from '@main/plugins/discover'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sylor-plugin-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes `content` to `root/rel`, creating parent dirs. */
function write(rel: string, content: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

describe('discoverPluginContents', () => {
  it('finds skills, commands, and connectors across the standard layouts', () => {
    write(
      'skills/greet/SKILL.md',
      '---\nname: greet\ndescription: Greets\nwhen_to_use: greeting\n---\nSay hi to $ARGUMENTS.'
    )
    write('.sylor/skills/extra/SKILL.md', '---\ndescription: Extra\n---\nDo the extra thing.')
    write('commands/deploy.md', '---\ndescription: Deploy\nargument-hint: [env]\n---\nDeploy to $ARGUMENTS.')
    write('.sylor/commands/note.md', 'Jot down: $ARGUMENTS')
    write(
      'mcp.json',
      JSON.stringify({ mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'] } } })
    )

    const found = discoverPluginContents(root, 'my-plugin')

    expect(found.skills.map((s) => s.name).sort()).toEqual(['extra', 'greet'])
    expect(found.commands.map((c) => c.name).sort()).toEqual(['deploy', 'note'])
    expect(found.mcpServers).toEqual([['time', { command: 'uvx', args: ['mcp-server-time'] }]])
    // The command's frontmatter round-trips into the writer input.
    const deploy = found.commands.find((c) => c.name === 'deploy')
    expect(deploy?.description).toBe('Deploy')
    expect(deploy?.argumentHint).toBe('[env]')
  })

  it('treats a single top-level SKILL.md as a one-skill plugin, named from the fallback', () => {
    write('SKILL.md', '---\ndescription: The whole repo is one skill\n---\nDo the thing.')
    const found = discoverPluginContents(root, 'solo-skill')
    expect(found.skills).toHaveLength(1)
    expect(found.skills[0].name).toBe('solo-skill')
    expect(found.commands).toEqual([])
    expect(found.mcpServers).toEqual([])
  })

  it('prefers a name from frontmatter over the fallback for a top-level SKILL.md', () => {
    write('SKILL.md', '---\nname: fancy\n---\nBody here.')
    expect(discoverPluginContents(root, 'ignored').skills[0].name).toBe('fancy')
  })

  it('returns empty lists for an empty dir and never throws on malformed files', () => {
    write('mcp.json', '{ not valid json')
    write('skills/broken/README.md', 'no SKILL.md here')
    const found = discoverPluginContents(root, 'x')
    expect(found).toEqual({ skills: [], commands: [], mcpServers: [] })
  })

  it('keeps the first definition when a name repeats across locations', () => {
    write('skills/dup/SKILL.md', '---\ndescription: canonical\n---\nCanonical body.')
    write('.sylor/skills/dup/SKILL.md', '---\ndescription: shadow\n---\nShadow body.')
    const found = discoverPluginContents(root, 'x')
    expect(found.skills).toHaveLength(1)
    expect(found.skills[0].description).toBe('canonical')
  })
})
