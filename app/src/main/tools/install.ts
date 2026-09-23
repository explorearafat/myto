import { randomUUID } from 'node:crypto'
import type { ToolDef } from './registry'
import type { McpServerConfig, McpTransport, SkillConfig } from '../../shared/types'
import { getSettings, saveSettings } from '../settings'

/**
 * Self-install tools: {@link installConnectorTool} and {@link installSkillTool}. They let
 * Myto add its OWN capabilities mid-conversation — wire up an MCP connector or drop in a
 * reusable skill — by writing the spec into settings and then triggering the live sync so
 * the new tools become callable on the very next turn, no restart and no trip through the
 * settings UI.
 *
 * Both are pure model-callable tools: they need no `window.myto` method (so they avoid the
 * three-implementer fan-out), only a place in the registry catalogue and a handler that
 * mutates settings + re-syncs. The connector/skill machinery already supports live
 * (un)registration (see mcp/manager.ts and skills/manager.ts); this just drives it from a
 * tool call instead of a UI action.
 *
 * They are marked as a 'write' side effect so Cowork's permission gate asks before Myto
 * reshapes its own toolset — installing a stdio connector will spawn a local process on
 * first use, which the user should get a say over.
 */

const VALID_TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']

/** A record of trimmed string→string pairs, or undefined when there's nothing usable. */
function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && k.trim()) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Build a validated {@link McpServerConfig} from a tool-call spec, or return an error
 * string explaining what's missing. Mirrors settings.ts's `normaliseMcpServer` so a spec
 * that would be silently dropped on save is caught here with a helpful message instead.
 */
function readConnector(input: unknown): McpServerConfig | string {
  if (!input || typeof input !== 'object') {
    return 'install_connector needs a JSON object describing the connector.'
  }
  const o = input as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return 'install_connector needs a non-empty "name".'
  const transport: McpTransport = VALID_TRANSPORTS.includes(o.transport as McpTransport)
    ? (o.transport as McpTransport)
    : 'stdio'
  const server: McpServerConfig = { id: randomUUID(), name, enabled: true, transport }
  if (transport === 'stdio') {
    const command = typeof o.command === 'string' ? o.command.trim() : ''
    if (!command) return 'A stdio connector needs a "command" to run (e.g. "npx").'
    server.command = command
    server.args = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string')
      : []
    const env = stringRecord(o.env)
    if (env) server.env = env
  } else {
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    if (!url) return `A ${transport} connector needs a "url".`
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return 'A connector "url" must be http or https.'
      }
    } catch {
      return `"${url}" is not a valid URL.`
    }
    server.url = url
    const headers = stringRecord(o.headers)
    if (headers) server.headers = headers
  }
  return server
}

/** Build a validated {@link SkillConfig} from a spec, or an error string. */
function readSkill(input: unknown): SkillConfig | string {
  if (!input || typeof input !== 'object') {
    return 'install_skill needs a JSON object describing the skill.'
  }
  const o = input as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const instructions = typeof o.instructions === 'string' ? o.instructions.trim() : ''
  if (!name) return 'install_skill needs a non-empty "name".'
  if (!instructions) return 'install_skill needs non-empty "instructions" (the full playbook to load).'
  return {
    id: randomUUID(),
    name,
    description: typeof o.description === 'string' ? o.description.trim() : '',
    instructions,
    enabled: true
  }
}

export const installConnectorTool: ToolDef = {
  name: 'install_connector',
  description:
    'Add and connect an MCP connector (server) so its tools become callable this session. Give a "name" and a "transport": "stdio" with "command"/"args"/"env", or "http"/"sse" with "url"/"headers". Use this to give yourself a capability you are missing (e.g. a GitHub or filesystem MCP server the user asks for).',
  usage:
    '{"name": "GitHub", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "…"}}',
  sideEffect: 'write',
  available: (gate) => gate.settings.tools.enabled,
  async run(input, ctx) {
    const parsed = readConnector(input)
    if (typeof parsed === 'string') return parsed

    const settings = getSettings()
    // Replace a same-named connector rather than piling up duplicates.
    const others = settings.mcpServers.filter((s) => s.name.toLowerCase() !== parsed.name.toLowerCase())
    saveSettings({ ...settings, mcpServers: [...others, parsed] })

    // Bring the connection up now (background sync is failure-isolated in the manager).
    // Dynamic import so this tool module doesn't pull mcp-ipc → manager → registry into a
    // load-time import cycle.
    try {
      const { syncConnectors } = await import('../mcp-ipc')
      await syncConnectors()
    } catch (err) {
      return `Saved connector "${parsed.name}", but the live connection could not be started: ${
        err instanceof Error ? err.message : String(err)
      }. It will connect on the next restart.`
    }
    if (ctx.signal.aborted) return `Saved connector "${parsed.name}".`

    // Report the outcome from the live status, so the model knows if it actually connected.
    try {
      const { mcpManager } = await import('../mcp/manager')
      const status = mcpManager.statuses().find((s) => s.id === parsed.id)
      if (status?.state === 'connected') {
        return `Connector "${parsed.name}" is connected and exposed ${status.toolCount} tool(s)${
          status.toolNames.length ? `: ${status.toolNames.join(', ')}` : ''
        }. You can call them now.`
      }
      if (status?.state === 'error') {
        return `Connector "${parsed.name}" was saved but failed to connect: ${status.error ?? 'unknown error'}.`
      }
    } catch {
      /* status read is best-effort */
    }
    return `Connector "${parsed.name}" was saved and is connecting. Its tools will appear once it's up.`
  }
}

export const installSkillTool: ToolDef = {
  name: 'install_skill',
  description:
    'Save a reusable skill — a named instruction pack you can load on demand later. Give a short "name", a one-line "description" (when it applies), and the full "instructions". Once installed it appears as a skill__<name> tool you (or a future turn) can call to pull the instructions into context.',
  usage:
    '{"name": "PDF forms", "description": "Fill and flatten PDF forms", "instructions": "Step 1 … Step 2 …"}',
  sideEffect: 'write',
  available: (gate) => gate.settings.tools.enabled,
  async run(input) {
    const parsed = readSkill(input)
    if (typeof parsed === 'string') return parsed

    const settings = getSettings()
    const others = settings.skills.filter((s) => s.name.toLowerCase() !== parsed.name.toLowerCase())
    // saveSettings fires the settings-saved listener, which re-syncs skills into the tool
    // registry — so the new skill tool is live on the next turn.
    saveSettings({ ...settings, skills: [...others, parsed] })

    return `Skill "${parsed.name}" installed. Call the "skill__${skillSlugFor(parsed.name)}" tool to load its instructions when you need them.`
  }
}

/** Local mirror of skills/manager.ts's slug, so the message can name the exact tool. */
function skillSlugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'skill'
  )
}
