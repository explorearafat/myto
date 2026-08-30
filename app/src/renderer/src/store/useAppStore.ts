import { create } from 'zustand'
import type {
  AppView,
  EnvStatus,
  ModelInfo,
  PermissionMode,
  PreviewEvent,
  ProviderKind,
  ProviderSettings,
  ReasoningEffort,
  SettingsTab,
  SyloriumAction,
  SyloriumPermission,
  SyloriumPermissions,
  Theme,
  WorkMode,
  WorkspaceInfo
} from '@shared/types'
import { DEFAULT_PROVIDER_SETTINGS, DEFAULT_SYLORIUM_PERMISSIONS } from '@shared/defaults'

/** localStorage keys for the renderer-only Sylorium prefs (no main-process round-trip). */
const SYLORIUM_INIT_KEY = 'sylor.sylorium.initialized'
const SYLORIUM_PERMS_KEY = 'sylor.sylorium.permissions'

/** Read the persisted "Sylorium onboarding done" flag (false when unset/SSR). */
function readSyloriumInitialized(): boolean {
  try {
    return localStorage.getItem(SYLORIUM_INIT_KEY) === '1'
  } catch {
    return false
  }
}

/** Read persisted Sylorium permissions, merged over the safe defaults. */
function readSyloriumPermissions(): SyloriumPermissions {
  try {
    const raw = localStorage.getItem(SYLORIUM_PERMS_KEY)
    if (!raw) return { ...DEFAULT_SYLORIUM_PERMISSIONS }
    const parsed = JSON.parse(raw) as Partial<SyloriumPermissions>
    return { ...DEFAULT_SYLORIUM_PERMISSIONS, ...parsed }
  } catch {
    return { ...DEFAULT_SYLORIUM_PERMISSIONS }
  }
}

/** Lifecycle phase of the live preview, mirrored from main-process events. */
export type PreviewPhase = PreviewEvent['phase'] | 'idle'

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
  permissionMode: PermissionMode
  isMaximized: boolean

  // ── Provider / model state (Phase 2) ──
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

  /** The top-level workspace destination: the chat surface or Sylorium. */
  activeView: AppView
  /** Whether Sylorium's first-run onboarding has been completed (persisted). */
  syloriumInitialized: boolean
  /** AI-control permission policy for Sylorium actions (persisted, per action). */
  syloriumPermissions: SyloriumPermissions

  /** Environment badge derived from the active provider (local/remote). */
  envStatus: EnvStatus
  /** Convenience: the currently selected model's display name. */
  model: string
  /** Active color theme, mirrored to `<html data-theme>`. */
  theme: Theme
  /** Reasoning effort applied to workflow runs (composer selector). */
  effort: ReasoningEffort
  /** When on, edit turns write a `plan.md` first and pause (composer toggle). */
  planFirst: boolean
  /** Top-level working mode: `cowork` (chat only) vs `code` (folder agent). */
  workMode: WorkMode

  // ── Workspace (folder-first Code mode; requirement A) ──
  /**
   * Absolute path of the folder Code mode is scoped to, or null before it's
   * loaded. Mirrors the main-process context root. In Cowork mode it's ignored.
   */
  workspaceRoot: string | null
  /**
   * Whether a folder was explicitly chosen (and persisted) vs. the cwd default.
   * Code mode's composer is gated until this is true — you must pick a folder
   * before Sylor will act on one.
   */
  workspaceChosen: boolean

  // ── Right-side preview panel (chat-first redesign) ──
  /** Whether the right-side live preview panel is open. */
  previewOpen: boolean
  /** URL currently loaded in the preview webview (localhost only), or null. */
  previewUrl: string | null
  /** Lifecycle phase mirrored from the main-process preview server. */
  previewPhase: PreviewPhase
  /** Human-readable error from the last failed preview start, or null. */
  previewError: string | null
  /** Bumped on each `reload` event so the panel can re-render the webview. */
  previewReloadNonce: number
  /** Whether the left conversation rail is expanded. */
  railOpen: boolean

  setProjectName: (name: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  setMaximized: (isMaximized: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /**
   * Open the Settings overlay directly to a specific tab (the sidebar's
   * quick-access rows use this). Passing no tab just opens it.
   */
  openSettings: (tab?: SettingsTab) => void
  /** Switch the top-level workspace view (chat ↔ sylorium). */
  setActiveView: (view: AppView) => void
  /** Mark Sylorium onboarding complete and persist it (so it never replays). */
  completeSyloriumOnboarding: () => void
  /** Update one Sylorium action's AI-control permission and persist it. */
  setSyloriumPermission: (action: SyloriumAction, permission: SyloriumPermission) => void
  setPreviewOpen: (open: boolean) => void
  /** Open the preview panel (does not itself start a server). */
  openPreview: () => void
  /** Close the preview panel and tear down the main-process preview server. */
  closePreview: () => void
  /**
   * Point the preview at a manual localhost URL (from the panel's address bar).
   * Renderer-only: starts no server, just aims the webview. Non-localhost URLs
   * are ignored — the guest is only ever allowed to load loopback.
   */
  showLocalPreviewUrl: (url: string) => void
  setRailOpen: (open: boolean) => void
  toggleRail: () => void
  /** Switch theme, apply it to the DOM, and persist it in settings. */
  setTheme: (theme: Theme) => Promise<void>
  /** Set the reasoning effort and persist it in settings. */
  setEffort: (effort: ReasoningEffort) => Promise<void>
  /** Toggle plan-first mode and persist it in settings. */
  setPlanFirst: (planFirst: boolean) => Promise<void>
  /** Set the working mode (Cowork/Code) and persist it in settings. */
  setWorkMode: (mode: WorkMode) => Promise<void>

  // ── Workspace actions (requirement A) ──
  /** Mirror a workspace info snapshot into state (from get() or an onChanged event). */
  setWorkspace: (info: WorkspaceInfo) => void
  /** Load the current workspace from the main process (called once on boot). */
  initWorkspace: () => Promise<void>
  /**
   * Open the OS folder picker to choose the Code-mode working folder. The main
   * process applies + persists the root and broadcasts `WorkspaceChanged`, which
   * the App subscribes to (updating state + starting a fresh chat), so this only
   * needs to invoke the IPC. No-op result when the user cancels the dialog.
   */
  selectWorkspace: () => Promise<void>

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
}

/**
 * Global UI + provider state. Provider settings are the source of truth for the
 * model selector and the Local/Remote environment badge; they persist through
 * the main-process settings store.
 */
export const useAppStore = create<AppState>((set, get) => ({
  projectName: 'Sylor',
  permissionMode: 'ask',
  isMaximized: false,

  settings: DEFAULT_PROVIDER_SETTINGS,
  settingsLoaded: false,
  models: [],
  modelsLoading: false,
  settingsOpen: false,
  settingsTab: null,
  activeView: 'chat',
  syloriumInitialized: readSyloriumInitialized(),
  syloriumPermissions: readSyloriumPermissions(),

  envStatus: envForProvider(DEFAULT_PROVIDER_SETTINGS.activeProvider),
  model: DEFAULT_PROVIDER_SETTINGS.modelName,
  theme: DEFAULT_PROVIDER_SETTINGS.ui.theme,
  effort: DEFAULT_PROVIDER_SETTINGS.ui.effort,
  planFirst: DEFAULT_PROVIDER_SETTINGS.ui.planFirst,
  workMode: DEFAULT_PROVIDER_SETTINGS.ui.mode,
  workspaceRoot: null,
  workspaceChosen: false,
  previewOpen: false,
  previewUrl: null,
  previewPhase: 'idle',
  previewError: null,
  previewReloadNonce: 0,
  railOpen: true,

  setProjectName: (projectName) => set({ projectName }),
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  setMaximized: (isMaximized) => set({ isMaximized }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  setActiveView: (activeView) => set({ activeView }),
  completeSyloriumOnboarding: () => {
    try {
      localStorage.setItem(SYLORIUM_INIT_KEY, '1')
    } catch {
      // Non-fatal: the flag just won't persist across restarts.
    }
    set({ syloriumInitialized: true })
  },
  setSyloriumPermission: (action, permission) =>
    set((state) => {
      const next = { ...state.syloriumPermissions, [action]: permission }
      try {
        localStorage.setItem(SYLORIUM_PERMS_KEY, JSON.stringify(next))
      } catch {
        // Non-fatal: falls back to defaults next launch.
      }
      return { syloriumPermissions: next }
    }),
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  openPreview: () => set({ previewOpen: true }),
  closePreview: () => {
    // Tearing down the server stops the file watcher and frees the port; the
    // panel returns to its idle empty state until the next auto-open.
    window.sylor?.preview?.stop()
    set({ previewOpen: false, previewUrl: null, previewPhase: 'idle', previewError: null })
  },
  showLocalPreviewUrl: (rawUrl) => {
    let host: string
    try {
      host = new URL(rawUrl).hostname
    } catch {
      // Not a parseable URL — ignore (the address bar treats it as a path instead).
      return
    }
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0') return
    set({ previewOpen: true, previewUrl: rawUrl, previewPhase: 'ready', previewError: null })
  },
  setRailOpen: (railOpen) => set({ railOpen }),
  toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),

  setTheme: async (theme) => {
    // Apply immediately for instant feedback, then persist through settings.
    applyThemeToDom(theme)
    set({ theme })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, theme } })
  },

  setEffort: async (effort) => {
    // Reflect immediately, then persist alongside the rest of settings.
    set({ effort })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, effort } })
  },

  setPlanFirst: async (planFirst) => {
    // Reflect immediately, then persist alongside the rest of settings.
    set({ planFirst })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, planFirst } })
  },

  setWorkMode: async (mode) => {
    // Reflect immediately, then persist alongside the rest of settings.
    set({ workMode: mode })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, mode } })
  },

  setWorkspace: (info) => set({ workspaceRoot: info.root, workspaceChosen: info.chosen }),

  initWorkspace: async () => {
    // `workspace.get` never throws; the shim/test mock return the cwd default.
    const info = await window.sylor.workspace.get()
    get().setWorkspace(info)
  },

  selectWorkspace: async () => {
    // Fire-and-forget: the main process persists + broadcasts, and App's onChanged
    // subscription mirrors the new root into state. History is global, so the open
    // chat and the recents list are left untouched — only new chats pick up the
    // new folder as their root.
    await window.sylor.workspace.select()
  },

  loadSettings: async () => {
    const settings = await window.sylor.providers.getSettings()
    applyThemeToDom(settings.ui.theme)
    set({
      settings,
      settingsLoaded: true,
      envStatus: envForProvider(settings.activeProvider),
      model: settings.modelName || settings.modelId,
      theme: settings.ui.theme,
      effort: settings.ui.effort,
      planFirst: settings.ui.planFirst
      // workMode is intentionally NOT restored from settings: every launch starts
      // in cowork (the store default), regardless of the last-used mode. This is a
      // deliberate product choice — reopening the app always lands on the cowork
      // landing page — and it also removes a load-vs-boot race. setWorkMode still
      // updates it for the session (and persists it), but that value is never read
      // back here, so a saved 'code' can't flip the fresh launch out of cowork.
    })
    // Populate the model list in the background; failures are non-fatal.
    void get().refreshModels()
  },

  saveSettings: async (next) => {
    const saved = await window.sylor.providers.saveSettings(next)
    applyThemeToDom(saved.ui.theme)
    set({
      settings: saved,
      envStatus: envForProvider(saved.activeProvider),
      model: saved.modelName || saved.modelId,
      theme: saved.ui.theme,
      effort: saved.ui.effort,
      planFirst: saved.ui.planFirst
      // workMode deliberately omitted (see loadSettings): a theme/effort/plan save
      // must never silently flip the live work mode back to a persisted value.
    })
  },

  refreshModels: async () => {
    const { settings } = get()
    const kind = settings.activeProvider
    const config = kind === 'ollama' ? settings.ollama : settings.gateway
    set({ modelsLoading: true })
    try {
      const result = await window.sylor.providers.listModels(kind, config)
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
      const result = await window.sylor.providers.listModels(kind, config)
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
  }
}))

// ── Live-preview event bridge ──
// Mirror the main-process preview lifecycle into the store. This runs once at
// module scope (right after the store is created). It is safe everywhere:
// main.tsx imports the browser-preview shim before this module, so `window.sylor`
// is always defined; the shim and the vitest mock both hand back a no-op
// `onEvent` disposer, so nothing fires outside the packaged app.
window.sylor?.preview?.onEvent((event: PreviewEvent) => {
  switch (event.phase) {
    case 'starting':
      // Auto-open the panel as soon as a dev server begins spawning, so the
      // engine-driven preview (it owns startDev) surfaces without a separate
      // openPreview call. Same on `ready` below.
      useAppStore.setState({ previewOpen: true, previewPhase: 'starting', previewError: null })
      break
    case 'ready':
      useAppStore.setState((s) => ({
        previewOpen: true,
        previewPhase: 'ready',
        previewUrl: event.url ?? s.previewUrl,
        previewError: null
      }))
      break
    case 'reload':
      // Keep the URL; bump the nonce so the panel can force a webview reload.
      useAppStore.setState((s) => ({
        previewPhase: 'ready',
        previewReloadNonce: s.previewReloadNonce + 1
      }))
      break
    case 'stopped':
      useAppStore.setState({ previewPhase: 'stopped' })
      break
    case 'error':
      useAppStore.setState({
        previewPhase: 'error',
        previewError: event.message ?? 'Live preview failed to start.'
      })
      break
  }
})
