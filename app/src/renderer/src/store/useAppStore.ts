import { create } from 'zustand'
import type {
  CoworkPermissionMode,
  EnvStatus,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  ModelInfo,
  ProviderKind,
  ProviderSettings,
  ReasoningEffort,
  SettingsTab,
  SkillConfig,
  Theme,
  ToolSettings
} from '@shared/types'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'
import { expandPluginManifest } from '@shared/plugins'
import type { ByokConfig } from '@shared/byok'

/** Derives the top-nav environment badge from the active provider. */
function envForProvider(kind: ProviderKind): EnvStatus {
  return kind === 'ollama' ? 'local' : 'remote'
}

/**
 * Reflect the active theme onto `<html data-theme>` so the CSS token overrides
 * in globals.css take effect. Light is the default palette (no attribute needed)
 * but we set it explicitly so the attribute always mirrors state.
 */
function applyThemeToDom(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }
}

export interface AppState {
  projectName: string
  isMaximized: boolean

  // ── Provider / model state ──
  /** Persisted provider configuration (mirrors the main-process store). */
  settings: ProviderSettings
  /** Whether initial settings have been loaded from the main process. */
  settingsLoaded: boolean
  /** Models advertised by the active provider's list endpoint. */
  models: ModelInfo[]
  /** True while a model list request is in flight. */
  modelsLoading: boolean
  /** Whether the Settings panel overlay is open. */
  settingsOpen: boolean
  /**
   * Which Settings pane to show when the overlay opens. The sidebar's
   * quick-access rows deep-link into a specific tab; `null` lets the panel keep
   * its own last/opening default.
   */
  settingsTab: SettingsTab | null

  /** Environment badge derived from the active provider (local/remote). */
  envStatus: EnvStatus
  /** Convenience: the currently selected model's display name. */
  model: string
  /** Active color theme, mirrored to `<html data-theme>`. */
  theme: Theme
  /** Whether the left conversation rail is expanded. */
  railOpen: boolean

  setProjectName: (name: string) => void
  setMaximized: (isMaximized: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /**
   * Open the Settings overlay directly to a specific tab (the sidebar's
   * quick-access rows use this). Passing no tab just opens it.
   */
  openSettings: (tab?: SettingsTab) => void
  setRailOpen: (open: boolean) => void
  toggleRail: () => void
  /** Switch theme, apply it to the DOM, and persist it in settings. */
  setTheme: (theme: Theme) => Promise<void>
  /** Patch the tool settings (enable/disable tools, code execution) and persist. */
  setTools: (patch: Partial<ToolSettings>) => Promise<void>
  /**
   * Open the native folder picker and, if the user chooses a folder, persist it as
   * Cowork's working folder (settings.cowork.workspaceDir). Returns the chosen path
   * or null when the user cancelled. This is what arms Cowork's filesystem tools.
   */
  pickCoworkWorkspace: () => Promise<string | null>
  /** Set Cowork's permission tier (ask / autoApprove / bypass) and persist it. */
  setCoworkPermissionMode: (mode: CoworkPermissionMode) => Promise<void>
  /** Set the reasoning-effort tier (sent to the provider as reasoning_effort) and persist. */
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>

  // ── Connectors (MCP) ──
  /** Live status of every configured connector, keyed by server id (main-process pushed). */
  mcpStatuses: McpServerStatus[]
  /** Add or replace a connector in settings, persist, then (re)connect. */
  saveConnector: (config: McpServerConfig) => Promise<void>
  /** Remove a connector by id from settings, persist, then reconcile connections. */
  removeConnector: (id: string) => Promise<void>
  /** Probe a candidate connector config without saving it. */
  testConnector: (config: McpServerConfig) => Promise<McpTestResult>
  /** Pull the current connector statuses from the main process. */
  refreshConnectorStatus: () => Promise<void>
  /** Subscribe to main-process status pushes; returns an unsubscribe fn (called once on boot). */
  watchConnectorStatus: () => () => void

  // ── Skills ──
  /** Add or replace a skill in settings and persist (main re-registers its tool on save). */
  saveSkill: (skill: SkillConfig) => Promise<void>
  /** Remove a skill by id and persist. */
  removeSkill: (id: string) => Promise<void>

  // ── Plugins ──
  /** Install a plugin from a pasted manifest string; expands into skills/connectors. Throws a user message on a bad manifest. */
  installPlugin: (manifest: string) => Promise<void>
  /** Uninstall a plugin: remove its record and every skill/connector it installed. */
  uninstallPlugin: (id: string) => Promise<void>
  /** Enable/disable a plugin and all the skills/connectors it installed, together. */
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>

  /** Load persisted settings from the main process (called once on boot). */
  loadSettings: () => Promise<void>
  /** Persist settings to the main process and update local state. */
  saveSettings: (settings: ProviderSettings) => Promise<void>
  /** Fetch the model list for the active provider from its config. */
  refreshModels: () => Promise<void>
  /**
   * Fetch models for an explicit (possibly unsaved) provider config, without
   * touching the saved settings. Used by the Settings panel to auto-discover
   * models as the user types a base URL / key. Returns the discovered list.
   */
  previewModels: (
    kind: ProviderKind,
    config: ProviderSettings['ollama'] | ProviderSettings['gateway']
  ) => Promise<ModelInfo[]>
  /** Select a model by id (looking up its display name from the model list). */
  selectModel: (modelId: string, modelName?: string) => Promise<void>
  /**
   * Ingest the account's BYOK config (from Firestore, via useByokConfig) and
   * mirror it onto the persisted local settings: force `activeProvider: 'gateway'`,
   * copy the connection onto `gateway`, and rebuild the available `models` list.
   * The current model selection is preserved when it's still in the new list,
   * otherwise it falls back to the first model. Persisting caches it in
   * sylor-settings.json so the provider still works offline. A null config
   * (signed-out / offline) is a no-op, so the last cache keeps driving the app.
   */
  applyByokConfig: (config: ByokConfig | null) => Promise<void>
}

/**
 * Global UI + provider state. Provider settings are the source of truth for the
 * model selector and the Local/Remote environment badge; they persist through
 * the main-process settings store.
 */
export const useAppStore = create<AppState>((set, get) => ({
  projectName: 'Myto',
  isMaximized: false,

  settings: DEFAULT_PROVIDER_SETTINGS,
  settingsLoaded: false,
  models: [],
  modelsLoading: false,
  settingsOpen: false,
  settingsTab: null,

  envStatus: envForProvider(DEFAULT_PROVIDER_SETTINGS.activeProvider),
  model: DEFAULT_PROVIDER_SETTINGS.modelName,
  theme: DEFAULT_PROVIDER_SETTINGS.ui.theme,
  railOpen: true,
  mcpStatuses: [],

  setProjectName: (projectName) => set({ projectName }),
  setMaximized: (isMaximized) => set({ isMaximized }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  setRailOpen: (railOpen) => set({ railOpen }),
  toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),

  setTheme: async (theme) => {
    // Apply immediately for instant feedback, then persist through settings.
    applyThemeToDom(theme)
    set({ theme })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, theme } })
  },

  setTools: async (patch) => {
    const { settings } = get()
    await get().saveSettings({ ...settings, tools: { ...settings.tools, ...patch } })
  },

  pickCoworkWorkspace: async () => {
    const dir = await window.myto.cowork.pickWorkspace()
    if (!dir) return null
    const { settings } = get()
    await get().saveSettings({ ...settings, cowork: { ...settings.cowork, workspaceDir: dir } })
    return dir
  },

  setCoworkPermissionMode: async (mode) => {
    const { settings } = get()
    await get().saveSettings({ ...settings, cowork: { ...settings.cowork, permissionMode: mode } })
  },

  setReasoningEffort: async (effort) => {
    const { settings } = get()
    await get().saveSettings({ ...settings, reasoningEffort: effort })
  },

  saveConnector: async (config) => {
    const { settings } = get()
    const existing = settings.mcpServers.filter((s) => s.id !== config.id)
    await get().saveSettings({ ...settings, mcpServers: [...existing, config] })
    // Reconnect from the freshly-saved list, then reflect the new statuses.
    set({ mcpStatuses: await window.myto.mcp.sync() })
  },

  removeConnector: async (id) => {
    const { settings } = get()
    await get().saveSettings({
      ...settings,
      mcpServers: settings.mcpServers.filter((s) => s.id !== id)
    })
    set({ mcpStatuses: await window.myto.mcp.sync() })
  },

  testConnector: (config) => window.myto.mcp.test(config),

  refreshConnectorStatus: async () => {
    set({ mcpStatuses: await window.myto.mcp.status() })
  },

  watchConnectorStatus: () =>
    window.myto.mcp.onStatusChanged((mcpStatuses) => set({ mcpStatuses })),

  saveSkill: async (skill) => {
    const { settings } = get()
    const rest = settings.skills.filter((s) => s.id !== skill.id)
    await get().saveSettings({ ...settings, skills: [...rest, skill] })
  },

  removeSkill: async (id) => {
    const { settings } = get()
    await get().saveSettings({ ...settings, skills: settings.skills.filter((s) => s.id !== id) })
  },

  installPlugin: async (manifest) => {
    // expandPluginManifest throws a user-facing message on a bad manifest; let it
    // propagate so the pane can show it.
    const { plugin, skills, mcpServers } = expandPluginManifest(manifest)
    const { settings } = get()
    await get().saveSettings({
      ...settings,
      skills: [...settings.skills, ...skills],
      mcpServers: [...settings.mcpServers, ...mcpServers],
      plugins: [...settings.plugins, plugin]
    })
    // Connect any servers the plugin added (skills re-register via the save listener).
    set({ mcpStatuses: await window.myto.mcp.sync() })
  },

  uninstallPlugin: async (id) => {
    const { settings } = get()
    await get().saveSettings({
      ...settings,
      skills: settings.skills.filter((s) => s.source !== id),
      mcpServers: settings.mcpServers.filter((s) => s.source !== id),
      plugins: settings.plugins.filter((p) => p.id !== id)
    })
    set({ mcpStatuses: await window.myto.mcp.sync() })
  },

  setPluginEnabled: async (id, enabled) => {
    const { settings } = get()
    // Flip the plugin and every item it installed together.
    await get().saveSettings({
      ...settings,
      plugins: settings.plugins.map((p) => (p.id === id ? { ...p, enabled } : p)),
      skills: settings.skills.map((s) => (s.source === id ? { ...s, enabled } : s)),
      mcpServers: settings.mcpServers.map((m) => (m.source === id ? { ...m, enabled } : m))
    })
    set({ mcpStatuses: await window.myto.mcp.sync() })
  },

  loadSettings: async () => {
    const settings = await window.myto.providers.getSettings()
    applyThemeToDom(settings.ui.theme)
    set({
      settings,
      settingsLoaded: true,
      envStatus: envForProvider(settings.activeProvider),
      model: settings.modelName || settings.modelId,
      theme: settings.ui.theme
    })
    // The model list is sourced from the account's Firestore config (see
    // applyByokConfig), not a provider list endpoint, so nothing to fetch here.
  },

  saveSettings: async (next) => {
    const saved = await window.myto.providers.saveSettings(next)
    applyThemeToDom(saved.ui.theme)
    set({
      settings: saved,
      envStatus: envForProvider(saved.activeProvider),
      model: saved.modelName || saved.modelId,
      theme: saved.ui.theme
    })
  },

  refreshModels: async () => {
    const { settings } = get()
    const kind = settings.activeProvider
    const config = kind === 'ollama' ? settings.ollama : settings.gateway
    set({ modelsLoading: true })
    try {
      const result = await window.myto.providers.listModels(kind, config)
      const models = result.ok ? result.models : []
      set({ models })
      // Auto-select like Claude Code: if the provider advertised models and none
      // is chosen yet, pick the first so chat works with no extra step. A model
      // the user already chose (even one not in the list) is left untouched.
      if (models.length > 0 && !get().settings.modelId) {
        await get().selectModel(models[0].id, models[0].name)
      }
    } catch {
      set({ models: [] })
    } finally {
      set({ modelsLoading: false })
    }
  },

  previewModels: async (kind, config) => {
    set({ modelsLoading: true })
    try {
      const result = await window.myto.providers.listModels(kind, config)
      const models = result.ok ? result.models : []
      set({ models })
      return models
    } catch {
      set({ models: [] })
      return []
    } finally {
      set({ modelsLoading: false })
    }
  },

  selectModel: async (modelId, modelName) => {
    const { settings, models } = get()
    const found = models.find((m) => m.id === modelId)
    const name = modelName || found?.name || modelId
    await get().saveSettings({ ...settings, modelId, modelName: name })
  },

  applyByokConfig: async (config) => {
    // Null (signed-out / offline read failure): leave the cached settings alone.
    if (!config) return
    const { settings } = get()
    const models: ModelInfo[] = config.models.map((m) => ({ id: m.id, name: m.name }))
    // Keep the current selection if it's still offered; otherwise default to the
    // first model (or blank when the account has none — the empty state).
    const keep = settings.modelId && models.some((m) => m.id === settings.modelId)
    const chosen = keep
      ? { id: settings.modelId, name: settings.modelName || settings.modelId }
      : (models[0] ?? { id: '', name: '' })
    set({ models })
    await get().saveSettings({
      ...settings,
      activeProvider: 'gateway',
      gateway: {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        authSchema: config.authSchema,
        authHeaderName: config.authHeaderName
      },
      modelId: chosen.id,
      modelName: chosen.name
    })
  }
}))
