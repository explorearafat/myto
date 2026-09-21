import type {
  McpServerConfig,
  McpTransport,
  PluginConfig,
  PluginManifest,
  SkillConfig
} from './types'

/*
 * Plugin manifest parsing + expansion.
 *
 * A plugin is a shareable bundle (a {@link PluginManifest}) that installs a set of
 * skills and/or connectors at once. This module is the pure, side-effect-free core:
 * it validates a pasted manifest and expands it into a {@link PluginConfig} plus the
 * ordinary {@link SkillConfig}/{@link McpServerConfig} entries it contributes (each
 * tagged with the plugin's id via `source`, so an uninstall can find and remove them).
 * Kept in `shared` so it is unit-testable without Electron and reused wherever a
 * plugin is installed.
 */

const VALID_TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']

/** Generate a reasonably-unique id with a readable prefix. */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** A string→string record keeping only string values (env / headers hygiene). */
function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** The result of expanding a manifest: the plugin record + the items it installs. */
export interface ExpandedPlugin {
  plugin: PluginConfig
  skills: SkillConfig[]
  mcpServers: McpServerConfig[]
}

/**
 * Parse a pasted manifest string into an {@link ExpandedPlugin}, or throw a message
 * suitable for showing the user. Validates JSON, the required name, and each skill /
 * server, dropping malformed items rather than failing the whole install. Every item
 * gets a fresh id, `enabled: true`, and `source` set to the new plugin's id.
 */
export function expandPluginManifest(raw: string): ExpandedPlugin {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('That is not valid JSON. Paste a plugin manifest object.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The manifest must be a JSON object.')
  }
  const m = parsed as PluginManifest
  const name = typeof m.name === 'string' ? m.name.trim() : ''
  if (!name) throw new Error('The manifest needs a "name".')

  const pluginId = genId('plugin')
  const plugin: PluginConfig = {
    id: pluginId,
    name,
    description: typeof m.description === 'string' ? m.description.trim() : '',
    enabled: true
  }

  const skills: SkillConfig[] = []
  for (const s of Array.isArray(m.skills) ? m.skills : []) {
    const sName = typeof s?.name === 'string' ? s.name.trim() : ''
    const instructions = typeof s?.instructions === 'string' ? s.instructions.trim() : ''
    if (!sName || !instructions) continue
    skills.push({
      id: genId('skill'),
      name: sName,
      description: typeof s.description === 'string' ? s.description.trim() : '',
      instructions,
      enabled: true,
      source: pluginId
    })
  }

  const mcpServers: McpServerConfig[] = []
  for (const raw of Array.isArray(m.mcpServers) ? m.mcpServers : []) {
    const server = expandServer(raw, pluginId)
    if (server) mcpServers.push(server)
  }

  if (skills.length === 0 && mcpServers.length === 0) {
    throw new Error('The manifest installs nothing — it has no valid skills or connectors.')
  }
  return { plugin, skills, mcpServers }
}

/** Validate one manifest server entry into a tagged {@link McpServerConfig}, or null. */
function expandServer(raw: unknown, pluginId: string): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return null
  const transport: McpTransport = VALID_TRANSPORTS.includes(o.transport as McpTransport)
    ? (o.transport as McpTransport)
    : 'stdio'
  const server: McpServerConfig = {
    id: genId('mcp'),
    name,
    enabled: true,
    source: pluginId,
    transport
  }
  if (transport === 'stdio') {
    const command = typeof o.command === 'string' ? o.command.trim() : ''
    if (!command) return null
    server.command = command
    server.args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : []
    const env = stringRecord(o.env)
    if (env) server.env = env
  } else {
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    if (!url) return null
    server.url = url
    const headers = stringRecord(o.headers)
    if (headers) server.headers = headers
  }
  return server
}
