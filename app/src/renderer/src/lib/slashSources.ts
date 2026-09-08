/**
 * slashSources — the one place that knows what a slash command *is*.
 *
 * Two surfaces need this list: the composer's `/` menu and the Ctrl+K palette. If
 * each built its own, a command authored on disk would show up in one and not the
 * other, and `/install` would expand differently depending on where it was picked.
 * So the item shape, the loader, the filter and the expansion all live here, and
 * both surfaces are thin renderers over them.
 *
 * Nothing here touches React — it is pure data plus `window.sylor` reads, which
 * makes the expansion rules testable without mounting a component.
 */
import { parseSlash, expandCommand, buildRememberPrompt } from '@shared/commands'
import type { CommandInfo, SkillStatus } from '@shared/types'

/**
 * One entry in the composer's `/` menu. `command` is a disk-authored template,
 * `skill` an enabled skill surfaced as a quick "use this skill" shortcut, and
 * `builtin` a hard-wired action (`/install`, `/remember`). All three carry a
 * `name` (typed after the slash), a one-line `description`, and an optional
 * `hint` shown after the name to preview expected arguments.
 */
export type SlashItem =
  | { kind: 'command'; name: string; description: string; hint: string; body: string }
  | { kind: 'skill'; name: string; description: string; hint: string; title: string }
  | { kind: 'builtin'; name: string; description: string; hint: string }

/** The disk-authored commands and enabled skills a surface filters over. */
export interface SlashSources {
  commands: CommandInfo[]
  skills: SkillStatus[]
}

/** Nothing loaded yet — a stable empty value, so effects can seed state with it. */
export const NO_SLASH_SOURCES: SlashSources = { commands: [], skills: [] }

/** How many rows the composer's menu shows; the palette lists more of them. */
export const SLASH_MENU_LIMIT = 8

/**
 * Reads commands + enabled skills. Called each time a surface opens rather than
 * once at boot, so a command authored in Settings or a plugin installed mid-session
 * is available without a restart. Never throws: a failed read yields nothing, which
 * shows as an empty menu instead of breaking the composer.
 */
export async function loadSlashSources(): Promise<SlashSources> {
  try {
    const [commands, skills] = await Promise.all([
      window.sylor.commands.list(),
      window.sylor.skills.list()
    ])
    return { commands, skills: skills.filter((s) => s.enabled) }
  } catch (err) {
    console.error('[sylor] failed to load slash sources:', err)
    return NO_SLASH_SOURCES
  }
}

/**
 * Turns a `/install <source> [scope]` line into a natural-language instruction
 * the engine reliably answers with an `install_plugin` tool block. The scope
 * word (project|global) is optional and stripped from the source; a bare
 * `/install` (no source) yields a prompt asking the user for the repo, so the
 * shortcut is still useful when typed on its own.
 */
export function buildInstallPrompt(args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let scope: 'global' | 'project' | null = null
  if (words.length > 0) {
    const last = words[words.length - 1].toLowerCase()
    if (last === 'project' || last === 'global') {
      scope = last
      words.pop()
    }
  }
  const source = words.join(' ').trim()
  if (!source) {
    return (
      'I want to install a Sylor plugin — a bundle of skills, commands, and ' +
      'connectors from a Git repository or a local folder. Ask me for the ' +
      'GitHub repository (a URL or `owner/repo`) or the folder path, then use ' +
      'the install_plugin tool to install it.'
    )
  }
  const scopeClause = scope ? ` Install it at ${scope} scope.` : ''
  return (
    `Install the Sylor plugin from "${source}" using the install_plugin tool.` +
    `${scopeClause} After it installs, briefly list the skills, commands, and ` +
    'connectors it added so I know what became available.'
  )
}

/** The built-ins, which exist in no catalog because they are wired into the UI. */
const BUILTINS: SlashItem[] = [
  {
    kind: 'builtin',
    name: 'install',
    description: 'Install a plugin (skills, commands, connectors) from a repo',
    hint: '<owner/repo> [project]'
  },
  {
    kind: 'builtin',
    name: 'remember',
    description: 'Save a durable fact about you to Sylor’s long-term memory',
    hint: '<fact to remember>'
  }
]

/**
 * The full palette for `sources`, filtered by `query` (a name or description
 * substring) and clipped to `limit`. Built-ins first, then disk commands, then
 * enabled skills — the order is deliberate: the two built-ins are always
 * available, so a user who half-remembers a name finds them without scrolling.
 */
export function buildSlashItems(
  sources: SlashSources,
  query = '',
  limit = SLASH_MENU_LIMIT
): SlashItem[] {
  const all: SlashItem[] = [...BUILTINS]
  for (const c of sources.commands) {
    all.push({
      kind: 'command',
      name: c.name,
      description: c.description,
      hint: c.argumentHint,
      body: c.body
    })
  }
  for (const s of sources.skills) {
    all.push({
      kind: 'skill',
      name: s.name,
      title: s.title || s.name,
      description: s.description,
      hint: ''
    })
  }
  const q = query.trim().toLowerCase()
  const matched = q
    ? all.filter(
        (it) => it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
      )
    : all
  return matched.slice(0, limit)
}

/**
 * Expands a slash line into what actually gets sent. A user command expands its
 * template (`$ARGUMENTS`/`$1`…); `/install` becomes an install instruction;
 * `/remember` becomes a save-to-memory instruction; a skill becomes a "use this
 * skill" instruction; anything else — including an unknown name — is sent as
 * typed, because silently swallowing a line the user wrote would be worse than
 * letting the model see it.
 */
export function resolveSlashText(text: string, sources: SlashSources): string {
  const parsed = parseSlash(text)
  if (!parsed) return text
  const lc = parsed.name.toLowerCase()
  const cmd = sources.commands.find((c) => c.name.toLowerCase() === lc)
  if (cmd) return expandCommand(cmd.body, parsed.args)
  if (lc === 'install') return buildInstallPrompt(parsed.args)
  if (lc === 'remember') return buildRememberPrompt(parsed.args)
  const skill = sources.skills.find((s) => s.name.toLowerCase() === lc)
  if (skill) {
    const base = `Use the ${skill.title || skill.name} skill.`
    return parsed.args ? `${base}\n\n${parsed.args}` : base
  }
  return text
}

/**
 * {@link resolveSlashText}, but it will fetch the catalogs first when `known` is
 * empty and the line actually needs them.
 *
 * A send can beat the lazy load: a freshly opened composer, a `/foo bar` pasted
 * and submitted in one motion, or the command palette firing a line the moment it
 * opens. Expanding against an empty list would silently send the raw `/foo bar`
 * text to the model, so this loads on demand instead.
 *
 * Returns the sources it used alongside the expansion, so a caller holding them in
 * state can keep the fetched copy rather than re-fetching on the next line.
 */
export async function resolveSlashLive(
  text: string,
  known: SlashSources
): Promise<{ text: string; sources: SlashSources }> {
  if (!parseSlash(text)) return { text, sources: known }
  let sources = known
  if (sources.commands.length === 0 && sources.skills.length === 0) {
    sources = await loadSlashSources()
  }
  return { text: resolveSlashText(text, sources), sources }
}
