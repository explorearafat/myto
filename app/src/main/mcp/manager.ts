import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpServerStatus, McpConnectionState } from '../../shared/types'
import { toErrorMessage } from '../providers/http'
import {
  registerExtensionTool,
  unregisterExtensionTools,
  type ToolDef
} from '../tools/registry'

/*
 * The connector (MCP) manager.
 *
 * Owns the live connections to the MCP servers the user has configured. Each
 * enabled server is connected once; its tools are discovered and wrapped as Myto
 * {@link ToolDef}s registered into the runtime tool layer (see tools/registry.ts's
 * `registerExtensionTool`), so the ordinary text-protocol loop can call them exactly
 * like a built-in. Nothing here touches the built-in catalogue.
 *
 * A server's tools are namespaced `mcp__<slug>__<tool>` so two servers (or a server
 * and a built-in) can never collide. Tools are registered while the server is
 * connected and torn down when it disconnects, so `availableTools` always reflects
 * what is genuinely reachable right now.
 *
 * Everything is failure-isolated: a server that won't spawn or times out is recorded
 * as an `error` status and skipped — it never throws into app startup or a chat turn.
 */

/** How long to wait for a server to connect + list its tools before giving up. */
const CONNECT_TIMEOUT_MS = 20_000
/** Per-tool-call timeout handed to the SDK (a slow tool shouldn't wedge the loop). */
const CALL_TIMEOUT_MS = 120_000
/** Cap on a single tool result folded back into the model's context. */
const RESULT_CAP = 30_000

/** The client identity Myto advertises to every MCP server. */
const CLIENT_INFO = { name: 'myto', version: '1.0.0' }

/** A server name → a safe slug for tool namespacing (`GitHub API` → `github_api`). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'server'
  )
}

/** The namespaced tool name Myto exposes for a server's tool. */
export function toolNameFor(serverName: string, toolName: string): string {
  return `mcp__${slugify(serverName)}__${toolName}`
}

/** The MCP JSON-Schema shape we read for a usage hint (a subset — enough to sample keys). */
interface JsonSchemaish {
  properties?: Record<string, unknown>
  required?: string[]
}

/** A compact example `input` for the prompt, sampled from a tool's input schema. */
function usageFromSchema(schema: JsonSchemaish | undefined): string {
  const props = schema?.properties ? Object.keys(schema.properties) : []
  if (props.length === 0) return '{}'
  const keys = (schema?.required?.length ? schema.required : props).slice(0, 3)
  return `{${keys.map((k) => `"${k}": "…"`).join(', ')}}`
}

/** Flatten an MCP tool result's content parts into one string the model can read. */
function flattenResult(result: { content?: unknown; isError?: boolean }): string {
  const parts = Array.isArray(result.content) ? result.content : []
  const chunks: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') chunks.push(p.text)
    else if (p.type === 'image') chunks.push('[image omitted]')
    else if (p.type === 'audio') chunks.push('[audio omitted]')
    else if (p.type === 'resource') {
      const res = p.resource as Record<string, unknown> | undefined
      if (res && typeof res.text === 'string') chunks.push(res.text)
      else if (res && typeof res.uri === 'string') chunks.push(`[resource: ${res.uri}]`)
    }
  }
  let text = chunks.join('\n').trim() || '(the tool returned no content)'
  if (text.length > RESULT_CAP) text = `${text.slice(0, RESULT_CAP)}\n…(result truncated)`
  return result.isError ? `The tool reported an error:\n${text}` : text
}

/** Ambient env vars a spawned stdio server inherits, plus the server's own overrides. */
function spawnEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v
  }
  return { ...base, ...(extra ?? {}) }
}

/** Reject a promise if it hasn't settled within `ms` — bounds a hung connect. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** One live (or failed) connection the manager tracks, keyed by server id. */
interface Connection {
  config: McpServerConfig
  client: Client | null
  state: McpConnectionState
  toolNames: string[]
  error?: string
  /** The connection-relevant fingerprint, so `sync` reconnects only on real change. */
  signature: string
}

/**
 * The fields that actually affect the connection. Cosmetic-only edits (renaming a
 * server) still change the tool namespace, so `name` is included; `enabled` is not —
 * enabling/disabling is handled by connect/disconnect directly.
 */
function connectionSignature(c: McpServerConfig): string {
  return JSON.stringify({
    name: c.name,
    transport: c.transport,
    command: c.command ?? '',
    args: c.args ?? [],
    env: c.env ?? {},
    url: c.url ?? '',
    headers: c.headers ?? {}
  })
}

class McpManager {
  private connections = new Map<string, Connection>()

  /**
   * Reconcile live connections with the configured server list: connect newly-enabled
   * or changed servers, disconnect removed or newly-disabled ones, and leave unchanged
   * ones alone. Safe to call repeatedly (on startup and after every settings save).
   */
  async sync(servers: McpServerConfig[]): Promise<void> {
    const wanted = new Map(servers.map((s) => [s.id, s]))

    // Drop connections whose server was removed entirely.
    for (const id of [...this.connections.keys()]) {
      if (!wanted.has(id)) await this.disconnect(id)
    }

    const toConnect: McpServerConfig[] = []
    for (const server of servers) {
      const existing = this.connections.get(server.id)
      if (!server.enabled) {
        // Disabled: ensure nothing is connected, record a 'disabled' status.
        if (existing?.client) await this.disconnect(server.id)
        this.connections.set(server.id, {
          config: server,
          client: null,
          state: 'disabled',
          toolNames: [],
          signature: connectionSignature(server)
        })
        continue
      }
      const sig = connectionSignature(server)
      if (existing?.client && existing.state === 'connected' && existing.signature === sig) {
        // Already connected and unchanged — keep it, just refresh the stored config.
        existing.config = server
        continue
      }
      // New, changed, or previously errored/disabled → (re)connect.
      if (existing?.client) await this.disconnect(server.id)
      toConnect.push(server)
    }

    // Connect the rest concurrently — one slow server never blocks the others.
    await Promise.all(toConnect.map((s) => this.connect(s)))
  }

  /** Connect one server, discover its tools, and register them. Never throws. */
  private async connect(server: McpServerConfig): Promise<void> {
    this.connections.set(server.id, {
      config: server,
      client: null,
      state: 'connecting',
      toolNames: [],
      signature: connectionSignature(server)
    })

    const client = new Client(CLIENT_INFO)
    try {
      const transport = this.makeTransport(server)
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connecting to ${server.name}`)
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `Listing ${server.name} tools`)

      const toolNames: string[] = []
      for (const tool of listed.tools) {
        const def = this.wrapTool(server, client, tool)
        registerExtensionTool(def)
        toolNames.push(def.name)
      }
      this.connections.set(server.id, {
        config: server,
        client,
        state: 'connected',
        toolNames,
        signature: connectionSignature(server)
      })
    } catch (err) {
      // Clean up a half-open client so a dead process/socket isn't left dangling.
      try {
        await client.close()
      } catch {
        /* already down */
      }
      this.connections.set(server.id, {
        config: server,
        client: null,
        state: 'error',
        toolNames: [],
        error: toErrorMessage(err),
        signature: connectionSignature(server)
      })
    }
  }

  /** Disconnect one server: unregister its tools and close the client. */
  private async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    if (conn.toolNames.length) unregisterExtensionTools(conn.toolNames)
    if (conn.client) {
      try {
        await conn.client.close()
      } catch {
        /* already down */
      }
    }
    this.connections.delete(id)
  }

  /** Build the SDK transport for a server's configured kind. */
  private makeTransport(server: McpServerConfig): Transport {
    if (server.transport === 'stdio') {
      if (!server.command) throw new Error('This connector has no command to run.')
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: spawnEnv(server.env),
        stderr: 'ignore'
      })
    }
    if (!server.url) throw new Error('This connector has no URL.')
    const url = new URL(server.url)
    const requestInit = server.headers ? { headers: server.headers } : undefined
    return server.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit })
  }

  /** Adapt one MCP tool into a Myto {@link ToolDef} that proxies calls to the server. */
  private wrapTool(
    server: McpServerConfig,
    client: Client,
    tool: { name: string; description?: string; inputSchema?: JsonSchemaish; annotations?: { readOnlyHint?: boolean } }
  ): ToolDef {
    const name = toolNameFor(server.name, tool.name)
    // An MCP tool that doesn't declare itself read-only is treated as a side effect,
    // so Cowork's permission gate asks before it runs — the safe default.
    const readOnly = tool.annotations?.readOnlyHint === true
    const description = `[${server.name}] ${tool.description ?? 'MCP tool.'}`
    return {
      name,
      description,
      usage: usageFromSchema(tool.inputSchema),
      sideEffect: readOnly ? undefined : 'write',
      // Master tool switch only; presence in the registry already means "connected".
      available: (gate) => gate.settings.tools.enabled,
      async run(input, ctx) {
        try {
          const result = await client.callTool(
            { name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
            undefined,
            { signal: ctx.signal, timeout: CALL_TIMEOUT_MS }
          )
          return flattenResult(result as { content?: unknown; isError?: boolean })
        } catch (err) {
          return `The "${name}" connector tool failed: ${toErrorMessage(err)}`
        }
      }
    }
  }

  /** The live status of every configured server, for the Connectors UI. */
  statuses(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      id: c.config.id,
      state: c.state,
      toolCount: c.toolNames.length,
      toolNames: c.toolNames,
      error: c.error
    }))
  }

  /** Close every connection (app shutdown). */
  async dispose(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}

/** The process-wide connector manager. */
export const mcpManager = new McpManager()
