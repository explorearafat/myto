import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GatewayConfig, OllamaConfig, ProviderKind } from '@app/shared/types'

/**
 * Where the CLI finds its provider config, in priority order:
 *
 *  1. Environment variables (`MYTO_BASE_URL` / `MYTO_API_KEY` / `MYTO_MODEL`, …)
 *     — the CI and one-off path, no files involved.
 *  2. The user's own CLI config, `~/.myto/config.json` — the normal `npm install
 *     -g myto` path; `myto config --base-url … --api-key … --model …` writes it.
 *  3. The desktop app's saved settings (`sylor-settings.json` in Electron's
 *     userData dir) — so a user who configured the app never configures the CLI.
 *
 * The shape mirrors the app's `{ activeProvider, ollama, gateway, modelId }` slice
 * of ProviderSettings so the same provider constructors consume it unchanged.
 */

export interface MytoCliConfig {
  activeProvider: ProviderKind
  ollama: OllamaConfig
  gateway: GatewayConfig
  modelId: string
  /** Where this config was resolved from, for the `myto config` display. */
  source: 'env' | 'user' | 'app' | 'none'
}

const DEFAULTS: Omit<MytoCliConfig, 'source'> = {
  // The CLI defaults to a hosted gateway (the common case for a globally
  // installed tool); `myto config --ollama-url … --model …` opts into local.
  activeProvider: 'gateway',
  ollama: { baseUrl: 'http://localhost:11434' },
  gateway: { baseUrl: '', apiKey: '', authSchema: 'bearer', authHeaderName: 'Authorization' },
  modelId: ''
}

/** The user-level CLI config path: `~/.myto/config.json`. */
export function userConfigPath(): string {
  return join(homedir(), '.myto', 'config.json')
}

/** Best-effort discovery of the desktop app's settings file (for fallback #3). */
function appSettingsPath(): string | null {
  const candidates: string[] = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'myto', 'sylor-settings.json'))
  if (process.env.XDG_CONFIG_HOME) candidates.push(join(process.env.XDG_CONFIG_HOME, 'myto', 'sylor-settings.json'))
  const home = homedir()
  candidates.push(
    join(home, 'AppData', 'Roaming', 'myto', 'sylor-settings.json'),
    join(home, '.config', 'myto', 'sylor-settings.json'),
    join(home, 'Library', 'Application Support', 'myto', 'sylor-settings.json')
  )
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      // unreadable home — skip
    }
  }
  return null
}

interface RawConfig {
  activeProvider?: unknown
  ollama?: { baseUrl?: unknown }
  gateway?: Partial<GatewayConfig>
  modelId?: unknown
  model?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  authSchema?: unknown
}

/** Coerce one raw settings record into the CLI slice; unknown fields are dropped. */
function normalise(raw: RawConfig | null | undefined): Omit<MytoCliConfig, 'source'> {
  const out: Omit<MytoCliConfig, 'source'> = JSON.parse(JSON.stringify(DEFAULTS)) as typeof out
  if (!raw || typeof raw !== 'object') return out
  const provider = raw.activeProvider === 'gateway' || raw.baseUrl || raw.apiKey ? 'gateway' : raw.activeProvider
  if (provider === 'gateway' || provider === 'ollama') out.activeProvider = provider
  if (typeof raw.ollama?.baseUrl === 'string' && raw.ollama.baseUrl.trim()) {
    out.ollama.baseUrl = raw.ollama.baseUrl.trim()
  }
  const g = raw.gateway ?? {}
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) out.gateway.baseUrl = raw.baseUrl.trim()
  else if (typeof g.baseUrl === 'string') out.gateway.baseUrl = g.baseUrl.trim()
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) out.gateway.apiKey = raw.apiKey.trim()
  else if (typeof g.apiKey === 'string') out.gateway.apiKey = g.apiKey
  const schema = (raw.authSchema ?? g.authSchema) as GatewayConfig['authSchema'] | undefined
  if (schema === 'none' || schema === 'bearer' || schema === 'header') out.gateway.authSchema = schema
  if (typeof g.authHeaderName === 'string' && g.authHeaderName.trim()) {
    out.gateway.authHeaderName = g.authHeaderName.trim()
  }
  const model = (raw.modelId ?? raw.model) as unknown
  if (typeof model === 'string' && model.trim()) out.modelId = model.trim()
  return out
}

/** Read the user config file, or null when absent/unreadable/corrupt. */
function readUserConfig(): RawConfig | null {
  const p = userConfigPath()
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as RawConfig
  } catch {
    return null // a torn or corrupt file falls through to the app settings
  }
}

/** Read the desktop app's settings, or null when absent/unreadable. */
function readAppConfig(): RawConfig | null {
  const p = appSettingsPath()
  if (!p) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RawConfig
  } catch {
    return null
  }
}

/**
 * Apply the `MYTO_*` environment variables over a resolved config. Only set vars
 * win, so an empty value in the environment doesn't blank out a stored key.
 */
function applyEnv(c: Omit<MytoCliConfig, 'source'>): void {
  const env = process.env
  if (env.MYTO_PROVIDER === 'gateway' || env.MYTO_PROVIDER === 'ollama') c.activeProvider = env.MYTO_PROVIDER
  if (env.MYTO_BASE_URL?.trim()) {
    c.activeProvider = 'gateway'
    c.gateway.baseUrl = env.MYTO_BASE_URL.trim()
  }
  if (env.MYTO_API_KEY?.trim()) {
    c.activeProvider = 'gateway'
    c.gateway.apiKey = env.MYTO_API_KEY.trim()
  }
  if (env.MYTO_AUTH_SCHEMA === 'none' || env.MYTO_AUTH_SCHEMA === 'bearer' || env.MYTO_AUTH_SCHEMA === 'header') {
    c.gateway.authSchema = env.MYTO_AUTH_SCHEMA
  }
  if (env.MYTO_AUTH_HEADER?.trim()) c.gateway.authHeaderName = env.MYTO_AUTH_HEADER.trim()
  if (env.MYTO_MODEL?.trim()) c.modelId = env.MYTO_MODEL.trim()
  if (env.MYTO_OLLAMA_URL?.trim()) {
    c.activeProvider = 'ollama'
    c.ollama.baseUrl = env.MYTO_OLLAMA_URL.trim()
  }
}

/** Resolve the effective config from all three layers, env last (highest priority). */
export function loadConfig(): MytoCliConfig {
  const user = readUserConfig()
  const merged = user ? normalise(user) : normalise(readAppConfig())
  applyEnv(merged)
  return { ...merged, source: user ? 'user' : process.env.MYTO_BASE_URL || process.env.MYTO_API_KEY ? 'env' : readAppConfig() ? 'app' : 'none' }
}

/** Persist the user-level config (`myto config …`); creates `~/.myto` as needed. */
export function saveUserConfig(patch: {
  baseUrl?: string
  apiKey?: string
  model?: string
  provider?: ProviderKind
  ollamaUrl?: string
}): MytoCliConfig {
  const existing = readUserConfig()
  const merged: RawConfig = {
    ...(existing ?? {}),
    gateway: { ...(existing?.gateway ?? {}) }
  }
  // Setting any gateway field implies the gateway provider unless the user asked
  // for ollama explicitly (or their stored config already says gateway).
  if (patch.provider) merged.activeProvider = patch.provider
  else if (patch.baseUrl !== undefined || patch.apiKey !== undefined) merged.activeProvider = 'gateway'
  if (patch.ollamaUrl) {
    merged.ollama = { ...(merged.ollama ?? {}), baseUrl: patch.ollamaUrl }
  }
  if (patch.baseUrl !== undefined) merged.baseUrl = patch.baseUrl
  if (patch.apiKey !== undefined) merged.apiKey = patch.apiKey
  if (patch.model !== undefined) merged.model = patch.model
  // Flatten into the canonical shape so the file stays readable.
  const flat: RawConfig = {
    activeProvider: patch.provider ?? (merged.activeProvider === 'gateway' ? 'gateway' : 'ollama'),
    gateway: {
      baseUrl: typeof merged.baseUrl === 'string' ? merged.baseUrl : merged.gateway?.baseUrl ?? '',
      apiKey: typeof merged.apiKey === 'string' ? merged.apiKey : merged.gateway?.apiKey ?? '',
      authSchema: merged.gateway?.authSchema ?? 'bearer',
      authHeaderName: merged.gateway?.authHeaderName ?? 'Authorization'
    },
    modelId: typeof merged.model === 'string' ? merged.model : merged.modelId ?? ''
  }
  const p = userConfigPath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(flat, null, 2) + '\n', 'utf8')
  return loadConfig()
}

/** True when the resolved config can actually serve a completion. */
export function isConfigured(c: MytoCliConfig): boolean {
  if (c.activeProvider === 'ollama') return Boolean(c.modelId)
  return Boolean(c.gateway.baseUrl) && Boolean(c.modelId)
}

/** A one-line human reason the config is unusable, for the startup error. */
export function configHint(c: MytoCliConfig): string {
  if (c.activeProvider === 'ollama') {
    return c.modelId
      ? ''
      : 'No model set. Run `myto config --ollama-url http://localhost:11434 --model llama3.1:8b` or set MYTO_MODEL.'
  }
  if (!c.gateway.baseUrl) {
    return 'No base URL set. Run `myto config --base-url https://api.openai.com/v1 --api-key sk-… --model gpt-4o-mini` or set MYTO_BASE_URL / MYTO_API_KEY / MYTO_MODEL.'
  }
  if (!c.modelId) return 'No model set. Run `myto config --model gpt-4o-mini` or set MYTO_MODEL.'
  return ''
}

/** Resolve the workspace folder: `--dir` / `MYTO_DIR`, else the current directory. */
export function resolveWorkspace(dirFlag?: string): string {
  return resolve(dirFlag || process.env.MYTO_DIR || process.cwd())
}

// ── Test-only seams ──────────────────────────────────────────────────────────
// The resolution is environment- and home-dir-backed, so the unit tests drive
// the pure halves directly instead of touching the real ~/.myto.

/** @internal Exposed for config.test.ts: run `normalise` on arbitrary raw input. */
export const normaliseForTest = normalise

/** @internal Exposed for config.test.ts: run `applyEnv` over a config object. */
export const applyEnvForTest = applyEnv
