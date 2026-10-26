import http from 'node:http'
import os from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * The Assistant's LAN bridge — how the phone reaches the PC.
 *
 * A tiny token-guarded HTTP server over the assistant's real flows:
 *   GET  /status      → is the assistant up?
 *   GET  /screenshot  → the current screen, base64 PNG
 *   POST /compose     → {contact, intent} → a TONE-MATCHED DRAFT (nothing sent)
 *   POST /deliver     → {text, windowTitle?, pressEnter?} → paste into the PC app
 * The bridge is OFF by default and stays off until the user enables it in the
 * Assistant pane; every call must carry the token (`x-myto-token`), which is
 * generated once and lives only on this machine and the user's phone.
 */

export interface BridgeConfig {
  enabled: boolean
  port: number
  token: string
}

export interface BridgeInfo {
  enabled: boolean
  running: boolean
  port: number
  token: string
  urls: string[]
}

export interface BridgeHandlers {
  status: () => Promise<Record<string, unknown>>
  screenshot: () => Promise<{ ok: boolean; dataBase64?: string; detail?: string }>
  compose: (req: { contact: string; intent: string }) => Promise<{ ok: boolean; draft?: string; detail: string }>
  deliver: (req: { text: string; windowTitle?: string; pressEnter?: boolean }) => Promise<{ ok: boolean; detail: string }>
}

function bridgePath(dataDir: string): string {
  return join(dataDir, 'bridge.json')
}

export function loadBridgeConfig(dataDir: string): BridgeConfig {
  try {
    const p = bridgePath(dataDir)
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<BridgeConfig>
      return { enabled: raw.enabled === true, port: raw.port ?? 48765, token: raw.token ?? '' }
    }
  } catch {
    /* fall through to defaults */
  }
  return { enabled: false, port: 48765, token: '' }
}

export function saveBridgeConfig(dataDir: string, cfg: BridgeConfig): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(bridgePath(dataDir), JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

function newToken(): string {
  return randomBytes(24).toString('base64url')
}

let server: http.Server | null = null
let runningPort = 0

/** LAN IPs to show the user (the phone connects to one of these). Pure-ish. */
export function lanIps(): string[] {
  const out: string[] = []
  try {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets ?? []) {
        if (net.family === 'IPv4' && !net.internal) out.push(net.address)
      }
    }
  } catch {
    /* keep whatever we have */
  }
  return out
}

export async function startBridge(
  dataDir: string,
  handlers: BridgeHandlers,
  requested?: Partial<BridgeConfig>
): Promise<BridgeInfo> {
  await stopBridge()
  const cfg = { ...loadBridgeConfig(dataDir), ...requested }
  if (!cfg.token) cfg.token = newToken()
  cfg.enabled = true
  saveBridgeConfig(dataDir, cfg)

  server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const token = (req.headers['x-myto-token'] as string) ?? ''
    if (token !== cfg.token) return send(401, { ok: false, detail: 'bad token' })
    let raw = ''
    req.on('data', (c: string) => {
      raw += c
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      try {
        if (req.method === 'GET' && req.url === '/status') {
          return send(200, { ok: true, ...(await handlers.status()) })
        }
        if (req.method === 'GET' && req.url === '/screenshot') {
          return send(200, await handlers.screenshot())
        }
        if (req.method === 'POST' && req.url === '/compose') {
          const body = JSON.parse(raw || '{}') as { contact?: string; intent?: string }
          if (!body.contact || !body.intent) return send(400, { ok: false, detail: 'contact and intent are required' })
          return send(200, await handlers.compose({ contact: body.contact, intent: body.intent }))
        }
        if (req.method === 'POST' && req.url === '/deliver') {
          const body = JSON.parse(raw || '{}') as { text?: string; windowTitle?: string; pressEnter?: boolean }
          if (!body.text) return send(400, { ok: false, detail: 'an approved draft is required' })
          return send(200, await handlers.deliver({ text: body.text, windowTitle: body.windowTitle, pressEnter: body.pressEnter }))
        }
        send(404, { ok: false, detail: 'unknown route' })
      } catch (err) {
        send(500, { ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', (e) => reject(e))
    server!.listen(cfg.port, '0.0.0.0', () => {
      runningPort = cfg.port
      resolve()
    })
  })
  return bridgeInfo(cfg)
}

export async function stopBridge(): Promise<void> {
  const s = server
  server = null
  runningPort = 0
  if (s) {
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
}

export function bridgeInfo(cfg: BridgeConfig): BridgeInfo {
  const urls = lanIps().map((ip) => `http://${ip}:${cfg.port}`)
  return {
    enabled: cfg.enabled,
    running: server !== null,
    port: runningPort || cfg.port,
    token: cfg.token,
    urls
  }
}

/** Current bridge view for the pane/IPC (does not start anything). */
export function bridgeStatus(dataDir: string): BridgeInfo {
  const cfg = loadBridgeConfig(dataDir)
  return { ...bridgeInfo(cfg), running: server !== null }
}

export function isBridgeRunning(): boolean {
  return server !== null
}
