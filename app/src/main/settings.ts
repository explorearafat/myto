import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  unlinkSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import * as electron from 'electron'
import { DEFAULT_PROVIDER_SETTINGS } from '../shared/defaults'
import type {
  AuthSchema,
  CoworkPermissionMode,
  McpServerConfig,
  McpTransport,
  PluginConfig,
  ProviderKind,
  ProviderSettings,
  ReasoningEffort,
  SkillConfig,
  Theme
} from '../shared/types'

/**
 * Injected userData directory (mirrors {@link setDbPath} in db.ts). The Electron
 * main process calls {@link setUserDataDir} at startup with
 * `app.getPath('userData')`. When set, the settings file reads from here and
 * `app` is never dereferenced, so this module works under plain Node (Vitest)
 * where `require('electron')` yields a path string rather than the `app` module.
 * With nothing injected it falls back to Electron's own path — the GUI's
 * historical behavior, and what settings.test.ts relies on through its `electron`
 * mock.
 */
let userDataDirOverride: string | null = null

/** The active userData directory: the injected override, else Electron's path. */
function userDataDir(): string {
  // Namespace import (not `import { app }`): under plain Node the `electron`
  // package is a CJS module whose default export is a path string with no named
  // `app`, so a named import fails to LINK — a namespace import binds cleanly and
  // `electron.app` is simply undefined there. It's only dereferenced on this
  // fallback, which tests never reach (they always inject an override).
  return userDataDirOverride ?? electron.app.getPath('userData')
}

function settingsPath(): string {
  return join(userDataDir(), 'sylor-settings.json')
}

/**
 * Crash-safe JSON persistence.
 *
 * A plain `writeFileSync` is NOT atomic: it truncates the target, then writes. If
 * the process dies in that window — an Electron crash, a Task-Manager kill after
 * the window went blank — the file is left empty or half-written. Every reader
 * here is defensive (`catch → defaults`), so a truncated file silently degraded
 * into "factory fresh": API key, model, and chosen folder all gone. That is the
 * "restart erased everything" bug.
 *
 * The fix is write-temp → fsync → rename, plus a `.bak` of the last known-good
 * file. `rename` is atomic on both Windows (MoveFileEx with REPLACE_EXISTING) and
 * POSIX, so a reader sees either the whole old file or the whole new one — never a
 * torn one. If the primary is somehow still unreadable, {@link readJsonFile} falls
 * back to the backup before it gives up and returns defaults.
 */
function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const text = JSON.stringify(data, null, 2)
  // Flush to the device before the rename, so a power loss can't leave a renamed
  // but empty file (the rename can otherwise land before the data does).
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // Keep the previous good copy as the fallback, then swap the new one in.
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  } catch {
    // A missing/locked backup must never block saving the real file.
  }
  renameSync(tmp, path)
}

/**
 * Reads and parses a JSON file, transparently falling back to its `.bak` when the
 * primary is missing, empty, or corrupt. Returns `undefined` only when neither
 * copy is usable — the one case where callers should fall back to defaults.
 */
function readJsonFile<T>(path: string): T | undefined {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      const text = readFileSync(candidate, 'utf-8')
      if (!text.trim()) continue
      const parsed = JSON.parse(text) as T
      // A recovered backup becomes the primary, so the next crash has a fresh
      // fallback and the corrupt file stops being re-read.
      if (candidate !== path) {
        try {
          writeJsonAtomic(path, parsed)
          unlinkSync(`${path}.bak`)
        } catch {
          // Recovery is best-effort; we already have the value in hand.
        }
      }
      return parsed
    } catch {
      // Try the backup next; if that also fails the caller uses defaults.
    }
  }
  return undefined
}

const VALID_PROVIDERS: ProviderKind[] = ['ollama', 'gateway']
const VALID_SCHEMAS: AuthSchema[] = ['none', 'bearer', 'header']
const VALID_THEMES: Theme[] = ['light', 'dark']
const VALID_PERMISSION_MODES: CoworkPermissionMode[] = ['ask', 'autoApprove', 'bypass']
const VALID_TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']
const VALID_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'max']

/** A string→string record, keeping only string values (env / headers hygiene). */
function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Validate one persisted connector entry, dropping anything malformed. Returns null
 * for an entry that can't be a usable server (no id/name, or a transport missing its
 * command/url) so a corrupt config can't crash the connector manager at connect time.
 */
function normaliseMcpServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : ''
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ''
  if (!id || !name) return null
  const transport: McpTransport = VALID_TRANSPORTS.includes(o.transport as McpTransport)
    ? (o.transport as McpTransport)
    : 'stdio'
  const server: McpServerConfig = {
    id,
    name,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    transport
  }
  if (typeof o.source === 'string' && o.source.trim()) server.source = o.source.trim()
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

/**
 * Validate one persisted skill entry. Drops anything without an id, name, or
 * instructions (an empty skill would advertise a tool that teaches the model nothing).
 */
function normaliseSkill(raw: unknown): SkillConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : ''
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ''
  const instructions = typeof o.instructions === 'string' ? o.instructions.trim() : ''
  if (!id || !name || !instructions) return null
  const skill: SkillConfig = {
    id,
    name,
    description: typeof o.description === 'string' ? o.description.trim() : '',
    instructions,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true
  }
  if (typeof o.source === 'string' && o.source.trim()) skill.source = o.source.trim()
  return skill
}

/** Validate one persisted plugin record. Drops entries without an id + name. */
function normalisePlugin(raw: unknown): PluginConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : ''
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ''
  if (!id || !name) return null
  return {
    id,
    name,
    description: typeof o.description === 'string' ? o.description.trim() : '',
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true
  }
}

/**
 * Merges a raw (possibly partial or stale) settings object onto the defaults,
 * validating every field. Exported for unit tests; also the single normalisation
 * point for {@link getSettings} and {@link saveSettings}. Now that Myto is a
 * plain chatbot the only UI preference is the theme.
 */
export function normalise(raw: unknown): ProviderSettings {
  const d = DEFAULT_PROVIDER_SETTINGS
  const o = (raw ?? {}) as Partial<ProviderSettings>
  const ollama = (o.ollama ?? {}) as Partial<ProviderSettings['ollama']>
  const gateway = (o.gateway ?? {}) as Partial<ProviderSettings['gateway']>
  const ui = (o.ui ?? {}) as Partial<ProviderSettings['ui']>
  const tools = (o.tools ?? {}) as Partial<ProviderSettings['tools']>
  const cowork = (o.cowork ?? {}) as Partial<ProviderSettings['cowork']>

  const activeProvider =
    o.activeProvider && VALID_PROVIDERS.includes(o.activeProvider)
      ? o.activeProvider
      : d.activeProvider
  const authSchema =
    gateway.authSchema && VALID_SCHEMAS.includes(gateway.authSchema)
      ? gateway.authSchema
      : d.gateway.authSchema
  const theme = ui.theme && VALID_THEMES.includes(ui.theme) ? ui.theme : d.ui.theme

  return {
    activeProvider,
    ollama: {
      baseUrl: typeof ollama.baseUrl === 'string' ? ollama.baseUrl : d.ollama.baseUrl
    },
    gateway: {
      baseUrl: typeof gateway.baseUrl === 'string' ? gateway.baseUrl : d.gateway.baseUrl,
      apiKey: typeof gateway.apiKey === 'string' ? gateway.apiKey : d.gateway.apiKey,
      authSchema,
      authHeaderName:
        typeof gateway.authHeaderName === 'string' && gateway.authHeaderName.trim()
          ? gateway.authHeaderName
          : d.gateway.authHeaderName
    },
    modelName: typeof o.modelName === 'string' ? o.modelName : d.modelName,
    modelId: typeof o.modelId === 'string' ? o.modelId : d.modelId,
    ui: {
      theme
    },
    tools: {
      enabled: typeof tools.enabled === 'boolean' ? tools.enabled : d.tools.enabled,
      codeExecution:
        typeof tools.codeExecution === 'boolean' ? tools.codeExecution : d.tools.codeExecution
    },
    cowork: {
      workspaceDir:
        typeof cowork.workspaceDir === 'string' ? cowork.workspaceDir : d.cowork.workspaceDir,
      permissionMode: VALID_PERMISSION_MODES.includes(cowork.permissionMode as CoworkPermissionMode)
        ? (cowork.permissionMode as CoworkPermissionMode)
        : d.cowork.permissionMode
    },
    mcpServers: Array.isArray(o.mcpServers)
      ? o.mcpServers.map(normaliseMcpServer).filter((s): s is McpServerConfig => s !== null)
      : d.mcpServers,
    skills: Array.isArray(o.skills)
      ? o.skills.map(normaliseSkill).filter((s): s is SkillConfig => s !== null)
      : d.skills,
    plugins: Array.isArray(o.plugins)
      ? o.plugins.map(normalisePlugin).filter((p): p is PluginConfig => p !== null)
      : d.plugins,
    reasoningEffort: VALID_EFFORTS.includes(o.reasoningEffort as ReasoningEffort)
      ? (o.reasoningEffort as ReasoningEffort)
      : d.reasoningEffort
  }
}

let cache: ProviderSettings | null = null
export function getSettings(): ProviderSettings {
  if (cache) return cache
  // `readJsonFile` already recovers from a torn primary via the `.bak`, so this
  // only reaches `normalise(undefined)` on a genuine first launch.
  cache = normalise(readJsonFile<unknown>(settingsPath()))
  return cache
}

export function saveSettings(settings: ProviderSettings): ProviderSettings {
  const normalised = normalise(settings)
  writeJsonAtomic(settingsPath(), normalised)
  cache = normalised
  try {
    savedListener?.(normalised)
  } catch (error) {
    // A surface that reacts badly to a preference must never lose the save that
    // has already been written to disk.
    console.error('[myto] settings-saved listener failed:', error)
  }
  return normalised
}

/**
 * Notified after every successful save, with the normalised settings. One writer
 * — the save — means a main-process surface reacting to a preference and the
 * stored value cannot drift, and `settings.ts` itself stays Electron-free and
 * unit-testable (the same reason `setUserDataDir` is injected rather than
 * imported).
 */
let savedListener: ((settings: ProviderSettings) => void) | null = null
export function setSettingsSavedListener(
  listener: ((settings: ProviderSettings) => void) | null
): void {
  savedListener = listener
}

/**
 * Inject the userData directory the settings file lives under, and drop the cache
 * derived from the previous location. Called once at startup by the Electron main
 * process (`app.getPath('userData')`) — the settings analogue of db.ts's
 * {@link setDbPath}. Must run before the first read.
 */
export function setUserDataDir(dir: string): void {
  userDataDirOverride = dir
  cache = null
}
