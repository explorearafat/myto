import { desktopCapturer, screen, ipcMain } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannel } from '../../shared/ipc'
import { providerFromSettings } from '../providers'
import { getSettings } from '../settings'
import { registerExtensionTool, unregisterExtensionTools } from '../tools/registry'
import {
  acceptPolicy,
  assistantStatus,
  dataRoot,
  disableAssistant,
  getComputer,
  setToolRegistrar
} from './computer-tool'
import type { Computer } from './computer'
import { composeReply, composeReplyFromHistory, deliverDraft, type MessagingDeps } from './messaging'
import { LearningSession, listSkills, practiceSkill, removeSkill } from './learn'
import { SmtpClient, connectSmtp, type MailMessage, type SmtpConfig } from './mail'
import { bridgeStatus, isBridgeRunning, startBridge, stopBridge } from './bridge'

/**
 * The Assistant's IPC surface: the pane talks to the main-process assistant
 * through these. Every entry checks the policy gate where it matters, and the
 * messaging flow's send step is ONLY reachable with an approved draft — the
 * pane drives that, not the model.
 */

function capturePrimary(): Promise<{ mediaType: string; dataBase64: string } | null> {
  try {
    const primary = screen.getPrimaryDisplay()
    const { width, height } = primary.size
    const scale = primary.scaleFactor || 1
    return desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } })
      .then((sources) => {
        const primaryId = String(primary.id)
        const source = sources.find((s) => s.display_id === primaryId) ?? sources[0]
        const image = source?.thumbnail
        if (!image || image.isEmpty()) return null
        const data = image.toPNG().toString('base64')
        return data ? { mediaType: 'image/png', dataBase64: data } : null
      })
  } catch {
    return Promise.resolve(null)
  }
}

function messagingDeps(c: Computer): MessagingDeps {
  return {
    provider: providerFromSettings(getSettings()),
    modelId: getSettings().modelId,
    computer: c,
    capture: capturePrimary,
    dataDir: dataRoot()
  }
}

async function withComputer<T>(fn: (c: Computer, deps: MessagingDeps) => Promise<T>): Promise<T> {
  const c = await getComputer()
  return fn(c, messagingDeps(c))
}

// ── Mail config (stored with tight permissions) ──────────────────────────────

function mailPath(): string {
  return join(dataRoot(), 'mail.json')
}

export interface StoredMailConfig extends SmtpConfig {
  /** The display name on outgoing mail. */
  name?: string
}

function loadMailConfig(): StoredMailConfig | null {
  try {
    if (!existsSync(mailPath())) return null
    return JSON.parse(readFileSync(mailPath(), 'utf8')) as StoredMailConfig
  } catch {
    return null
  }
}

function saveMailConfig(cfg: StoredMailConfig): void {
  mkdirSync(dataRoot(), { recursive: true })
  writeFileSync(mailPath(), JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

// ── Learning sessions (one at a time) ────────────────────────────────────────

let learning: LearningSession | null = null

// ── Registration ─────────────────────────────────────────────────────────────

export function registerAssistantIpc(): void {
  setToolRegistrar(registerExtensionTool, (name) => unregisterExtensionTools([name]))

  ipcMain.handle(IpcChannel.AssistantStatus, () => assistantStatus())
  ipcMain.handle(IpcChannel.AssistantAccept, async () => acceptPolicy())
  ipcMain.handle(IpcChannel.AssistantDisable, () => disableAssistant())

  // A quick, real end-to-end probe: clipboard round-trip + active window + timing.
  ipcMain.handle(IpcChannel.AssistantTestAction, async () => {
    try {
      const c = await getComputer()
      const t0 = Date.now()
      const clip = await c.clipboardSet(`myto-assistant-probe-${Date.now()}`)
      const got = await c.clipboardGet()
      const win = await c.activeWindow()
      return {
        ok: clip.ok && got.ok && win.ok,
        detail: `clipboard round-trip + window read in ${Date.now() - t0}ms · active: ${win.detail || '(unknown)'}`,
        ms: Date.now() - t0
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), ms: 0 }
    }
  })

  ipcMain.handle(
    IpcChannel.AssistantCompose,
    async (_e, req: { contact: string; intent: string; history?: Array<{ from: 'me' | 'them'; text: string }> }) => {
      try {
        if (!req?.contact || !req?.intent) return { ok: false, detail: 'contact and intent are required' }
        return await withComputer(async (_c, deps) => {
          const draft = req.history?.length
            ? await composeReplyFromHistory(deps, req.contact, req.intent, req.history)
            : await composeReply(deps, req.contact, req.intent)
          return { ok: true, draft: draft.text, detail: 'draft ready — nothing sent yet' }
        })
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    IpcChannel.AssistantDeliver,
    async (_e, req: { text: string; windowTitle?: string; pressEnter?: boolean }) => {
      try {
        if (!req?.text?.trim()) return { ok: false, detail: 'an approved draft is required' }
        return await withComputer(async (c) => {
          const r = await deliverDraft({ ...messagingDeps(c), computer: c }, req.text, {
            windowTitle: req.windowTitle,
            pressEnter: req.pressEnter
          })
          return { ok: r.ok, detail: r.detail }
        })
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(IpcChannel.AssistantLearnStart, async (_e, req: { goal: string }) => {
    try {
      if (learning) return { ok: false, detail: 'a learning session is already running' }
      const c = await getComputer()
      learning = new LearningSession(
        { provider: providerFromSettings(getSettings()), modelId: getSettings().modelId, computer: c, capture: capturePrimary },
        req.goal
      )
      learning.start(2000)
      return { ok: true, detail: 'watching — do the task on screen, then press Stop' }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.AssistantLearnStop, async (_e, req: { name: string }) => {
    try {
      if (!learning) return { ok: false, detail: 'no learning session is running' }
      const skill = await learning.stop(dataRoot(), req.name || 'task')
      learning = null
      return { ok: true, detail: `learned "${skill.name}" with ${skill.steps.length} steps`, steps: skill.steps }
    } catch (err) {
      learning = null
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.AssistantPractice, async (_e, req: { name: string }) => {
    try {
      const c = await getComputer()
      const deps = { provider: providerFromSettings(getSettings()), modelId: getSettings().modelId, computer: c, capture: capturePrimary }
      return await practiceSkill(deps, dataRoot(), req.name)
    } catch (err) {
      return { skill: req?.name ?? '', ok: false, steps: [], detail: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.AssistantSkillsList, () => listSkills(dataRoot()))
  ipcMain.handle(IpcChannel.AssistantSkillRemove, (_e, req: { name: string }) => removeSkill(dataRoot(), req.name))

  // LAN bridge: the phone reaches the PC assistant over the local network.
  ipcMain.handle(IpcChannel.AssistantBridgeGet, () => bridgeStatus(dataRoot()))
  ipcMain.handle(
    IpcChannel.AssistantBridgeSet,
    async (_e, req: { enabled: boolean; port?: number }) => {
      try {
        if (!req?.enabled) {
          await stopBridge()
          return { ...bridgeStatus(dataRoot()), enabled: false }
        }
        const info = await startBridge(
          dataRoot(),
          {
            status: async () => assistantStatus(),
            screenshot: async () => {
              const shot = await capturePrimary()
              return shot ? { ok: true, dataBase64: shot.dataBase64 } : { ok: false, detail: 'capture failed' }
            },
            compose: async (r) => {
              const c = await getComputer()
              const draft = await composeReply(messagingDeps(c), r.contact, r.intent)
              return { ok: true, draft: draft.text, detail: 'draft ready — approve it on the phone to deliver' }
            },
            deliver: async (r) => {
              const c = await getComputer()
              return deliverDraft(messagingDeps(c), r.text, { windowTitle: r.windowTitle, pressEnter: r.pressEnter })
            }
          },
          { enabled: true, port: req?.port }
        )
        return info
      } catch (err) {
        return { enabled: false, running: false, port: 0, token: '', urls: [], detail: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  void isBridgeRunning // kept for future pane polling

  ipcMain.handle(IpcChannel.AssistantMailGetConfig, () => {
    const cfg = loadMailConfig()
    return cfg ? { ...cfg, pass: '' } : null
  })

  ipcMain.handle(IpcChannel.AssistantMailSend, async (_e, req: { config: StoredMailConfig; message: MailMessage; save?: boolean }) => {
    try {
      const cfg = req.config
      const stored = loadMailConfig()
      const merged: StoredMailConfig = {
        host: cfg.host || stored?.host || '',
        port: cfg.port || stored?.port || 465,
        secure: cfg.secure ?? stored?.secure ?? true,
        user: cfg.user || stored?.user || '',
        pass: cfg.pass || stored?.pass || '',
        from: cfg.from || stored?.from || undefined,
        name: cfg.name || stored?.name || undefined
      }
      if (req.save !== false) saveMailConfig(merged)
      const client = new SmtpClient({ connect: connectSmtp, now: () => new Date() })
      const result = await client.send(merged, req.message)
      return result
    } catch (err) {
      return { ok: false, transcript: `[error] ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
