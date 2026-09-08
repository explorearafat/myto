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
import { MemoryStore } from './memory/store'
import { DEFAULT_PROVIDER_SETTINGS } from '../shared/defaults'
import type {
  AuthSchema,
  HookDefinition,
  HookEvent,
  HooksConfig,
  ProviderKind,
  ProviderSettings,
  ReasoningEffort,
  Theme,
  WorkMode
} from '../shared/types'

/**
 * Injected userData directory (mirrors {@link setDbPath} in db.ts). The Electron
 * main process calls {@link setUserDataDir} at startup with
 * `app.getPath('userData')`; the headless CLI (Phase 6) calls it with a resolved
 * path. When set, every per-user file below — settings, the skills/MCP override
 * files, and the memory store — reads from here and `app` is never dereferenced,
 * so this module works under plain Node (Vitest, the CLI) where
 * `require('electron')` yields a path string rather than the `app` module. With
 * nothing injected it falls back to Electron's own path — the GUI's historical
 * behavior, and what settings.test.ts relies on through its `electron` mock.
 */
let userDataDirOverride: string | null = null

/** The active userData directory: the injected override, else Electron's path. */
function userDataDir(): string {
  // Namespace import (not `import { app }`): under plain Node the `electron`
  // package is a CJS module whose default export is a path string with no named
  // `app`, so a named import fails to LINK — a namespace import binds cleanly and
  // `electron.app` is simply undefined there. It's only dereferenced on this
  // fallback, which the CLI never reaches (it always injects an override).
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
const VALID_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'max']
const VALID_WORK_MODES: WorkMode[] = ['cowork', 'code']
const VALID_HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']

/**
 * Validate the persisted hooks blob into a clean {@link HooksConfig}. Every
 * entry is dropped unless it has a non-empty string `command`; `matcher` is kept
 * only when a non-empty string and `timeoutMs` only when a positive finite
 * number. An event whose entries all drop out is omitted entirely, so the result
 * is byte-clean and the engine can treat an absent event as "no hooks". Never
 * throws — a garbage value degrades to `{}`.
 */
function normaliseHooks(raw: unknown): HooksConfig {
  const out: HooksConfig = {}
  const o = (raw ?? {}) as Record<string, unknown>
  for (const event of VALID_HOOK_EVENTS) {
    const list = o[event]
    if (!Array.isArray(list)) continue
    const defs: HookDefinition[] = []
    for (const item of list) {
      const d = (item ?? {}) as Partial<HookDefinition>
      if (typeof d.command !== 'string' || !d.command.trim()) continue
      const def: HookDefinition = { command: d.command }
      if (typeof d.matcher === 'string' && d.matcher.trim()) def.matcher = d.matcher
      if (typeof d.timeoutMs === 'number' && Number.isFinite(d.timeoutMs) && d.timeoutMs > 0) {
        def.timeoutMs = Math.floor(d.timeoutMs)
      }
      defs.push(def)
    }
    if (defs.length > 0) out[event] = defs
  }
  return out
}

/**
 * Merges a raw (possibly partial or stale) settings object onto the defaults,
 * validating every field. Exported for unit tests; also the single normalisation
 * point for {@link getSettings} and {@link saveSettings}.
 */
export function normalise(raw: unknown): ProviderSettings {
  const d = DEFAULT_PROVIDER_SETTINGS
  const o = (raw ?? {}) as Partial<ProviderSettings>
  const ollama = (o.ollama ?? {}) as Partial<ProviderSettings['ollama']>
  const gateway = (o.gateway ?? {}) as Partial<ProviderSettings['gateway']>

  const ui = (o.ui ?? {}) as Partial<ProviderSettings['ui']>

  const activeProvider =
    o.activeProvider && VALID_PROVIDERS.includes(o.activeProvider)
      ? o.activeProvider
      : d.activeProvider
  const authSchema =
    gateway.authSchema && VALID_SCHEMAS.includes(gateway.authSchema)
      ? gateway.authSchema
      : d.gateway.authSchema
  const theme = ui.theme && VALID_THEMES.includes(ui.theme) ? ui.theme : d.ui.theme
  const effort = ui.effort && VALID_EFFORTS.includes(ui.effort) ? ui.effort : d.ui.effort
  const planFirst = typeof ui.planFirst === 'boolean' ? ui.planFirst : d.ui.planFirst
  const mode = ui.mode && VALID_WORK_MODES.includes(ui.mode) ? ui.mode : d.ui.mode
  const statusWidget =
    typeof ui.statusWidget === 'boolean' ? ui.statusWidget : d.ui.statusWidget
  const fullAccess = typeof ui.fullAccess === 'boolean' ? ui.fullAccess : d.ui.fullAccess
  const autoSend = typeof ui.autoSend === 'boolean' ? ui.autoSend : d.ui.autoSend
  // The chosen working folder (requirement A). Kept only when it's a non-empty
  // string; a blank/absent value means "no folder chosen yet" and Code mode
  // stays gated. `undefined` is dropped from the JSON entirely (not persisted).
  const workspaceRoot =
    typeof ui.workspaceRoot === 'string' && ui.workspaceRoot.trim() ? ui.workspaceRoot : undefined

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
      theme,
      effort,
      planFirst,
      mode,
      statusWidget,
      fullAccess,
      autoSend,
      ...(workspaceRoot ? { workspaceRoot } : {})
    },
    hooks: normaliseHooks(o.hooks)
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

/**
 * Whether the user has opted into full-PC access. The single authority every
 * main-process enforcement seam reads — the fs sandbox (`resolveSafe`) and the
 * permission matrix (`decideAuto`/`decideBrowse`) — so the switch is honoured in
 * exactly one place and can't drift between them. Defensive: any read failure
 * falls back to the safe posture (confined + gated), never to open.
 */
export function fullAccessEnabled(): boolean {
  try {
    return getSettings().ui.fullAccess === true
  } catch {
    return false
  }
}

/**
 * Whether the user opted into hands-free sending — posting/messaging/mailing AS
 * themselves without a prompt. This is a SUB-permission of full access: it means
 * nothing on its own, so it returns true only when BOTH switches are on. That
 * coupling lives here, in the one authority `decideBrowse` reads, so the narrow
 * "send only while full access is on" rule can't drift. Defensive: any read
 * failure falls back to the gated posture (send keeps asking).
 */
export function autoSendEnabled(): boolean {
  try {
    const { ui } = getSettings()
    return ui.fullAccess === true && ui.autoSend === true
  } catch {
    return false
  }
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
    console.error('[sylor] settings-saved listener failed:', error)
  }
  return normalised
}

/**
 * Notified after every successful save, with the normalised settings.
 *
 * The seam exists so a main-process surface can react to a *preference* (the
 * floating status widget) without the renderer opening a second channel for it.
 * One writer — the save — means the window and the stored value cannot drift, and
 * `settings.ts` itself stays Electron-free and unit-testable (the same reason
 * `setUserDataDir` is injected rather than imported).
 */
let savedListener: ((settings: ProviderSettings) => void) | null = null
export function setSettingsSavedListener(
  listener: ((settings: ProviderSettings) => void) | null
): void {
  savedListener = listener
}

/**
 * Enable/disable overrides for skills and MCP servers, persisted separately from
 * {@link ProviderSettings}.
 *
 * Both catalogs are opt-in: an item's *default* on/off state lives in code (the
 * catalog), and this file records only the user's explicit overrides on top. That
 * lets built-ins default off, disk items default on, and a "restore defaults"
 * simply clear the overrides — without a second settings store that could drift.
 *
 * Two override sets are kept per subsystem: `enabled` (turned on despite a
 * default-off) and `disabled` (turned off despite a default-on). Resolution is
 * `enabled ? on : disabled ? off : default`. Legacy files that stored only
 * `{ "disabled": [...] }` still read correctly (missing `enabled` → empty set),
 * so upgrading in place loses nothing.
 *
 * This deliberately lives outside ProviderSettings: the Settings modal saves the
 * whole provider blob it captured when it opened, so folding toggles into that
 * blob would let a later model-Save clobber a toggle made meanwhile via the
 * skills/MCP IPC. Dedicated files keep the two independent.
 */
export interface EnableOverrides {
  /** Names turned ON despite a default-off. */
  enabled: Set<string>
  /** Names turned OFF despite a default-on. */
  disabled: Set<string>
}

/** Coerces an unknown JSON value to a set of non-empty strings. */
function toStringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string' && !!n) : []
  )
}

/** Reads an override file; a missing/garbage file yields empty sets (defensive). */
function readOverrides(path: string): EnableOverrides {
  const parsed = readJsonFile<{ enabled?: unknown; disabled?: unknown }>(path)
  if (!parsed) return { enabled: new Set(), disabled: new Set() }
  return { enabled: toStringSet(parsed.enabled), disabled: toStringSet(parsed.disabled) }
}

/** Persists an override file as `{ "disabled": [...], "enabled": [...] }`. */
function writeOverrides(path: string, o: EnableOverrides): void {
  writeJsonAtomic(path, { disabled: [...o.disabled], enabled: [...o.enabled] })
}

/** Resolves effective enabled state: an explicit override wins over the default. */
function resolveEnabled(o: EnableOverrides, name: string, defaultOn: boolean): boolean {
  if (o.enabled.has(name)) return true
  if (o.disabled.has(name)) return false
  return defaultOn
}

/** Records an explicit on/off override for `name` (moves it between the two sets). */
function applyEnabled(o: EnableOverrides, name: string, enabled: boolean): EnableOverrides {
  const next: EnableOverrides = { enabled: new Set(o.enabled), disabled: new Set(o.disabled) }
  if (enabled) {
    next.enabled.add(name)
    next.disabled.delete(name)
  } else {
    next.disabled.add(name)
    next.enabled.delete(name)
  }
  return next
}

// ── Skills overrides (`sylor-skills.json`) ─────────────────────────────────

function skillsStatePath(): string {
  return join(userDataDir(), 'sylor-skills.json')
}

let skillOverridesCache: EnableOverrides | null = null

/** The user's skill enable/disable overrides. Cached; defensive on read. */
export function getSkillOverrides(): EnableOverrides {
  if (!skillOverridesCache) skillOverridesCache = readOverrides(skillsStatePath())
  return skillOverridesCache
}

/** Effective enabled state of a skill, given its catalog/disk default. */
export function isSkillEnabled(name: string, defaultOn: boolean): boolean {
  return resolveEnabled(getSkillOverrides(), name, defaultOn)
}

/** Toggles a skill on/off and persists the override; returns the updated overrides. */
export function setSkillEnabled(name: string, enabled: boolean): EnableOverrides {
  const next = applyEnabled(getSkillOverrides(), name, enabled)
  writeOverrides(skillsStatePath(), next)
  skillOverridesCache = next
  return next
}

/** Clears all skill overrides (restore defaults) without touching disk skills. */
export function resetSkillOverrides(): void {
  const empty: EnableOverrides = { enabled: new Set(), disabled: new Set() }
  writeOverrides(skillsStatePath(), empty)
  skillOverridesCache = empty
}

// ── MCP overrides (`sylor-mcp.json`) ───────────────────────────────────────

function mcpStatePath(): string {
  return join(userDataDir(), 'sylor-mcp.json')
}

let mcpOverridesCache: EnableOverrides | null = null

/** The user's MCP server enable/disable overrides. Cached; defensive on read. */
export function getMcpOverrides(): EnableOverrides {
  if (!mcpOverridesCache) mcpOverridesCache = readOverrides(mcpStatePath())
  return mcpOverridesCache
}

/** Effective enabled state of an MCP server, given its catalog/disk default. */
export function isMcpEnabled(name: string, defaultOn: boolean): boolean {
  return resolveEnabled(getMcpOverrides(), name, defaultOn)
}

/** Toggles an MCP server on/off and persists the override; returns the updated overrides. */
export function setMcpEnabled(name: string, enabled: boolean): EnableOverrides {
  const next = applyEnabled(getMcpOverrides(), name, enabled)
  writeOverrides(mcpStatePath(), next)
  mcpOverridesCache = next
  return next
}

/** Clears all MCP overrides (restore defaults) without touching `mcp.json`. */
export function resetMcpOverrides(): void {
  const empty: EnableOverrides = { enabled: new Set(), disabled: new Set() }
  writeOverrides(mcpStatePath(), empty)
  mcpOverridesCache = empty
}

// ── User profile (structured long-term memory under `<userData>/memory`) ────

/**
 * A GLOBAL, cross-project memory of the person using Sylor — their name, how
 * they like to work, the kind of sites they build, their style and typography
 * taste. Unlike project memory (scoped to one folder), this follows the user
 * everywhere, so Sylor gets more useful the more it learns.
 *
 * Phase 5 backs it with a structured {@link MemoryStore}: one Markdown file per
 * fact (plus a human-readable `MEMORY.md` index) under `<userData>/memory`,
 * mirroring how this assistant keeps its own memory. That makes what Sylor knows
 * inspectable/editable on disk and enables relevance recall — a large profile
 * injects only the facts relevant to the current turn (see
 * {@link getUserProfileForPrompt}) instead of every one. Deliberately its own
 * store (not ProviderSettings): a Settings-modal save must never clobber a fact
 * learned mid-conversation, exactly as the skills/MCP override files are kept
 * separate. The legacy flat `sylor-profile.json` is migrated in once on upgrade.
 */

/** Most facts kept before the oldest are pruned — bounds on-disk + prompt cost. */
const MAX_PROFILE_NOTES = 80

/** Facts injected verbatim before recall kicks in; a small profile ships whole. */
const MAX_PROFILE_PROMPT_FACTS = 24

let memoryStoreSingleton: MemoryStore | null = null

/** Directory backing the structured memory (one `NNNN-slug.md` file per fact). */
function memoryDir(): string {
  return join(userDataDir(), 'memory')
}

/** The legacy flat profile file, folded into {@link memoryDir} once on upgrade. */
function legacyProfilePath(): string {
  return join(userDataDir(), 'sylor-profile.json')
}

/**
 * The process-wide memory store, created lazily (userData isn't known at import
 * time) and memoized. On first creation — and only when the store is still empty
 * — any legacy `sylor-profile.json` notes are folded in, in order, so upgrading
 * keeps everything Sylor already learned. Best-effort throughout.
 */
function memoryStore(): MemoryStore {
  if (memoryStoreSingleton) return memoryStoreSingleton
  const store = new MemoryStore(memoryDir(), { maxFacts: MAX_PROFILE_NOTES })
  try {
    if (store.list().length === 0) {
      const legacy = readJsonFile<{ notes?: unknown }>(legacyProfilePath())
      const notes = Array.isArray(legacy?.notes)
        ? legacy.notes.filter((n): n is string => typeof n === 'string' && !!n.trim())
        : []
      const now = new Date().toISOString()
      for (const n of notes) store.remember(n, now)
    }
  } catch {
    // best-effort — a missing/garbage legacy file just means nothing to migrate
  }
  memoryStoreSingleton = store
  return store
}

/**
 * The full user profile as prompt-ready text — one fact per bullet in insertion
 * order, or '' when nothing has been learned yet (so callers can omit the section
 * entirely). This is the stable contract the browser's memory IPC depends on; for
 * turn-scoped injection prefer {@link getUserProfileForPrompt}. Never throws.
 */
export function getUserProfile(): string {
  try {
    return memoryStore().asBullets()
  } catch {
    return ''
  }
}

/**
 * The user profile trimmed for one turn's system prompt. A small profile
 * (≤ {@link MAX_PROFILE_PROMPT_FACTS} facts) ships whole — byte-identical to
 * {@link getUserProfile} — so nothing changes for the common case. A larger one
 * is narrowed to the `limit` facts most relevant to `query` (with the newest
 * facts filling any remainder), so memory stays useful without flooding the
 * prompt. Returns '' when empty. Never throws.
 */
export function getUserProfileForPrompt(query = '', limit = MAX_PROFILE_PROMPT_FACTS): string {
  try {
    const store = memoryStore()
    if (store.list().length <= limit) return store.asBullets()
    return store
      .recall(query, limit)
      .map((f) => `- ${f.text}`)
      .join('\n')
  } catch {
    return ''
  }
}

/**
 * Records one durable fact about the user, returning true when it was actually
 * added (false for a blank or exact-duplicate note). Deduped case-insensitively
 * and capped at {@link MAX_PROFILE_NOTES} (oldest pruned). Best-effort: a write
 * failure returns false rather than throwing, so a persistence hiccup can't abort
 * a run.
 */
export function appendUserProfile(note: string): boolean {
  try {
    return memoryStore().remember(note, new Date().toISOString()).added
  } catch {
    return false
  }
}

/**
 * Inject the userData directory the per-user files live under, and drop every
 * cache derived from the previous location. Called once at startup by the Electron
 * main process (`app.getPath('userData')`) and by the headless CLI (a resolved
 * path) — the settings analogue of db.ts's {@link setDbPath}, and the seam that
 * lets the engine run without a GUI. Must run before the first read below.
 */
export function setUserDataDir(dir: string): void {
  userDataDirOverride = dir
  cache = null
  skillOverridesCache = null
  mcpOverridesCache = null
  memoryStoreSingleton = null
}
