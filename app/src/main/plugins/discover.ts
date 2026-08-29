/**
 * Plugin content discovery.
 *
 * Given a directory (a freshly-cloned repo or a local folder), this finds the
 * three kinds of capability a Sylor plugin can bundle and returns them as the
 * same inputs the hand-authoring writers already accept — so installing a plugin
 * is just "discover, then write each item the normal way". Recognized layouts,
 * mirroring the Claude CLI's plugin conventions plus Sylor's `.sylor` dirs:
 *  - skills   → `skills/<name>/SKILL.md`, `.sylor/skills/<name>/SKILL.md`, or a
 *               single top-level `SKILL.md` (a one-skill repo)
 *  - commands → `commands/*.md` or `.sylor/commands/*.md`
 *  - connectors → `mcp.json`, `.mcp.json`, or `.sylor/mcp.json`
 *
 * Pure disk reads, fully defensive: a missing dir or a malformed file yields
 * nothing rather than throwing, so a partial plugin still installs whatever is
 * valid. No Electron, no network — trivially unit-testable against a fixture dir.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { McpServerConfig } from '../../shared/types'
import { parseSkill, type NewSkillInput } from '../skills/registry'
import { parseCommand, type NewCommandInput } from '../commands/registry'
import { parseMcpConfig } from '../mcp/config'

/** Everything a plugin dir yielded, shaped for the writers to persist. */
export interface DiscoveredContents {
  skills: NewSkillInput[]
  commands: NewCommandInput[]
  mcpServers: Array<[string, McpServerConfig]>
}

/** Reads a file as UTF-8, or null if it doesn't exist / can't be read. */
function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** Lists a directory's entries, or [] if it doesn't exist. */
function tryList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Discovers `<base>/skills/<name>/SKILL.md` folders under one skills dir. */
function readSkillFolders(skillsDir: string): NewSkillInput[] {
  const out: NewSkillInput[] = []
  for (const folder of tryList(skillsDir)) {
    const text = tryRead(join(skillsDir, folder, 'SKILL.md'))
    if (!text) continue
    const parsed = parseSkill(text)
    const name = (parsed.name && parsed.name.trim()) || folder.trim()
    if (!name || !parsed.instructions) continue
    out.push({
      name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      instructions: parsed.instructions
    })
  }
  return out
}

/** Discovers `<base>/commands/*.md` under one commands dir. */
function readCommandFiles(commandsDir: string): NewCommandInput[] {
  const out: NewCommandInput[] = []
  for (const file of tryList(commandsDir)) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const text = tryRead(join(commandsDir, file))
    if (text == null) continue
    const parsed = parseCommand(text)
    const name = file.slice(0, -3).trim()
    if (!name || !parsed.body) continue
    out.push({
      name,
      description: parsed.description,
      argumentHint: parsed.argumentHint,
      body: parsed.body
    })
  }
  return out
}

/** De-dupes a list of `{ name }` items, keeping the first occurrence per name. */
function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = item.name.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Scans a plugin directory for skills, commands, and connectors. `fallbackName`
 * names a single top-level `SKILL.md` that has no `name:` in its frontmatter
 * (typically the repo name). Later locations do NOT override earlier ones — the
 * first definition of a given name wins, so an explicit `skills/` entry beats a
 * `.sylor/skills/` copy of the same name.
 */
export function discoverPluginContents(dir: string, fallbackName: string): DiscoveredContents {
  // Skills — dedicated dirs first, then a single top-level SKILL.md.
  const skills = [...readSkillFolders(join(dir, 'skills')), ...readSkillFolders(join(dir, '.sylor', 'skills'))]
  const topSkill = tryRead(join(dir, 'SKILL.md'))
  if (topSkill) {
    const parsed = parseSkill(topSkill)
    const name = (parsed.name && parsed.name.trim()) || fallbackName.trim() || basename(dir)
    if (name && parsed.instructions) {
      skills.push({
        name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        instructions: parsed.instructions
      })
    }
  }

  // Commands — dedicated dirs.
  const commands = [
    ...readCommandFiles(join(dir, 'commands')),
    ...readCommandFiles(join(dir, '.sylor', 'commands'))
  ]

  // Connectors — first mcp.json found wins (checked in preference order).
  let mcpServers: Array<[string, McpServerConfig]> = []
  for (const candidate of ['mcp.json', '.mcp.json', join('.sylor', 'mcp.json')]) {
    const text = tryRead(join(dir, candidate))
    if (text == null) continue
    try {
      const parsed = parseMcpConfig(JSON.parse(text))
      const entries = Object.entries(parsed)
      if (entries.length > 0) {
        mcpServers = entries
        break
      }
    } catch {
      // malformed JSON → try the next candidate
    }
  }

  return {
    skills: dedupeByName(skills),
    commands: dedupeByName(commands),
    mcpServers
  }
}
