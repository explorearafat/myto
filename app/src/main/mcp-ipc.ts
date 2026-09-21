import { BrowserWindow, ipcMain } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { IpcChannel } from '../shared/ipc'
import type { McpServerConfig, McpTestResult } from '../shared/types'
import { getSettings } from './settings'
import { mcpManager } from './mcp/manager'
import { toErrorMessage } from './providers/http'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/*
 * Connector (MCP) IPC.
 *
 * Thin bridge between the renderer's Connectors UI and the {@link mcpManager}. The
 * server LIST is owned by ordinary settings (`mcpServers`); this module handles the
 * live side — reading status, triggering a (re)connect after a save, and probing a
 * candidate config before it is saved. Status changes are pushed to every window so
 * the UI reflects a connection settling without polling.
 */

/** Broadcast the current connector statuses to all open windows. */
function broadcastStatus(): void {
  const statuses = mcpManager.statuses()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannel.McpStatusChanged, statuses)
  }
}

/** Probe timeout for the one-off "Test" connection — shorter than a real connect. */
const TEST_TIMEOUT_MS = 15_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
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

/** Build a transport for a candidate config (mirrors the manager's, kept local for the probe). */
function makeTransport(server: McpServerConfig): Transport {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('No command to run.')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...env, ...(server.env ?? {}) },
      stderr: 'ignore'
    })
  }
  if (!server.url) throw new Error('No URL.')
  const url = new URL(server.url)
  const requestInit = server.headers ? { headers: server.headers } : undefined
  return server.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit })
}

/**
 * Probe a candidate connector config: connect, list tools, close. Nothing is saved
 * and no tools are registered — this is only to tell the user "yes, this works and
 * exposes N tools" before they commit the config.
 */
async function testConnector(config: McpServerConfig): Promise<McpTestResult> {
  const client = new Client({ name: 'sylor', version: '1.0.0' })
  try {
    const transport = makeTransport(config)
    await withTimeout(client.connect(transport), TEST_TIMEOUT_MS)
    const listed = await withTimeout(client.listTools(), TEST_TIMEOUT_MS)
    const toolNames = listed.tools.map((t) => t.name)
    return { ok: true, toolCount: toolNames.length, toolNames }
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) }
  } finally {
    try {
      await client.close()
    } catch {
      /* already down */
    }
  }
}

/**
 * (Re)connect to every enabled connector from the saved settings, then broadcast the
 * resulting statuses. Called on startup and whenever the renderer saves the server
 * list. Resolves the fresh statuses to the caller too.
 */
export async function syncConnectors(): Promise<void> {
  try {
    await mcpManager.sync(getSettings().mcpServers)
  } catch (err) {
    console.error('[sylor] connector sync failed:', err)
  } finally {
    broadcastStatus()
  }
}

export function registerMcpIpc(): void {
  ipcMain.handle(IpcChannel.McpStatus, () => mcpManager.statuses())

  ipcMain.handle(IpcChannel.McpSync, async () => {
    await syncConnectors()
    return mcpManager.statuses()
  })

  ipcMain.handle(IpcChannel.McpTest, (_event, config: McpServerConfig) => testConnector(config))
}

/** Close every connector connection (app shutdown). */
export async function disposeConnectors(): Promise<void> {
  await mcpManager.dispose()
}
