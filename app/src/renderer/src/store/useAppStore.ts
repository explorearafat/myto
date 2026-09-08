import { create } from 'zustand'
import type {
  BrowserAction,
  BrowserPermission,
  BrowserPermissions,
  EnvStatus,
  ModelInfo,
  PermissionMode,
  PreviewEvent,
  ProviderKind,
  ProviderSettings,
  ReasoningEffort,
  SettingsTab,
  Theme,
  WorkMode,
  WorkspaceInfo
} from '@shared/types'
import { DEFAULT_BROWSER_PERMISSIONS, DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

/** Lifecycle phase of the live preview, mirrored from main-process events. */
export type PreviewPhase = PreviewEvent['phase'] | 'idle'

/**
 * Which surface the right-side canvas shows: `log` is the timestamped run trace,
 * `diff` the current write full-height, `tree` the files this run touched, `graph`
 * what imports what, and `timeline` the restore points. Every mode listed here has
 * a surface behind it — `CanvasPanel` renders only built ones, so a tab can never
 * open a blank pane.
 */
export type CanvasMode = 'log' | 'timeline' | 'diff' | 'tree' | 'graph'

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

  /**
   * Whether the right-side BROWSER panel is open. Shares the panel slot with the
   * live preview: opening one closes the other, because both draw over the same
   * region and only one can own it.
   */
  browserOpen: boolean

  /** Environment badge derived from the active provider (local/remote). */
  envStatus: EnvStatus
  /** Convenience: the currently selected model's display name. */
  model: string
  /** Active color theme, mirrored to `<html data-theme>`. */
  theme: Theme
  /** Reasoning effort applied to workflow runs (composer selector). */
  effort: ReasoningEffort
  /** When on, edit turns halt for a go-ahead once the plan is ready (composer toggle). */
  planFirst: boolean
  /**
   * FULL-PC ACCESS (opt-in). Mirrors `settings.ui.fullAccess`. When on, Sylor can
   * read/write/delete any file on the machine and run any command without asking.
   * Off by default; the Settings toggle carries a warning.
   */
  fullAccess: boolean
  /**
   * AUTO-SEND (opt-in). Mirrors `settings.ui.autoSend`. A sub-permission of
   * full access: when both are on, Sylor may post/message/mail as the user
   * without asking. `delete` still asks and `payment` stays blocked. Off by
   * default; the Settings toggle only shows once full access is on.
   */
  autoSend: boolean
  /**
   * Whether the always-on-top mini status card is showing. Mirrors
   * `settings.ui.statusWidget`; main opens/destroys the window on the save.
   */
  statusWidget: boolean
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

  // ── Right-side canvas panel (harness overhaul) ──
  /**
   * Whether the right-side CANVAS panel is open. Third member of the same
   * mutually-exclusive slot as the preview and the browser: all three draw over
   * the same region, so opening one closes the others.
   */
  canvasOpen: boolean
  /** Which canvas surface is showing (tab state, kept while the panel is closed). */
  canvasMode: CanvasMode
  /**
   * Which lane the run log is filtered to — a subagent's `agentId`, the literal
   * `'__lead__'` for Sylor itself, or null for all of them.
   *
   * It lives here rather than inside `RunLog` because the log is not the only thing
   * that picks a lane: the command palette jumps straight to one, and (with the
   * ambient widget) so does a click on a status popup. A filter two surfaces can set
   * has to be shared state, or they would disagree about what is showing.
   */
  logLane: string | null
  /**
   * A restore point the user has asked for from outside the Timeline, which the
   * Timeline should open already armed (showing its confirm).
   *
   * Restoring rewrites files, so a fuzzy-matched Enter in the palette must never be
   * the click that does it. The palette arms; the Timeline still asks.
   */
  armedCheckpoint: string | null

  // ── Command palette (Ctrl/Cmd+K) ──
  /**
   * Whether the global command palette is showing. It overlays everything and owns
   * the keyboard while open, so it is app state rather than a component's — the
   * shortcut is registered once at the root and any surface can open it.
   */
  paletteOpen: boolean

  setProjectName: (name: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  setMaximized: (isMaximized: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /**
   * Open the Settings overlay directly to a specific tab (the sidebar's
   * quick-access rows use this). Passing no tab just opens it.
   */
  openSettings: (tab?: SettingsTab) => void
  /**
   * The AI-control browsing policy, read from settings with the safe defaults
   * filled in — so a settings file written before this feature existed still
   * yields a complete policy.
   */
  browserPermissions: () => BrowserPermissions
  /** Update one browse risk class's permission and persist it in settings. */
  setBrowserPermission: (action: BrowserAction, permission: BrowserPermission) => Promise<void>
  /** Show/hide the right-side browser panel (also drives the main-process view). */
  setBrowserOpen: (open: boolean) => void
  /** Open the browser panel, closing the live preview if it owned the slot. */
  openBrowser: () => void
  /** Close the browser panel and hide the main-process page view. */
  closeBrowser: () => void
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
  /**
   * Open the canvas panel on a specific surface (or the last one used), taking the
   * shared right slot from the preview/browser. The browser is a native view, so
   * it must be hidden rather than merely flagged closed.
   */
  openCanvas: (mode?: CanvasMode) => void
  /** Close the canvas panel, freeing the right slot. Keeps the selected mode. */
  closeCanvas: () => void
  /** Switch canvas surface; opens the panel if it was closed. */
  setCanvasMode: (mode: CanvasMode) => void
  /** Open the canvas if closed, close it if open (the composer's Log toggle). */
  toggleCanvas: (mode?: CanvasMode) => void
  /** Filter the run log to one lane, or pass null to show every lane. */
  setLogLane: (lane: string | null) => void
  /** Show the canvas log filtered to `lane` — the palette's "jump to lane". */
  showLane: (lane: string | null) => void
  /** Open the Timeline with `id` armed, or pass null to clear the arming. */
  armCheckpoint: (id: string | null) => void
  /** Show the command palette. */
  openPalette: () => void
  /** Hide the command palette (Escape, or after an action runs). */
  closePalette: () => void
  /** What Ctrl/Cmd+K does: show it, or hide it if it is already up. */
  togglePalette: () => void
  /** Switch theme, apply it to the DOM, and persist it in settings. */
  setTheme: (theme: Theme) => Promise<void>
  /** Set the reasoning effort and persist it in settings. */
  setEffort: (effort: ReasoningEffort) => Promise<void>
  /** Toggle plan-first mode and persist it in settings. */
  setPlanFirst: (planFirst: boolean) => Promise<void>
  /** Toggle full-PC access and persist it in settings. */
  setFullAccess: (fullAccess: boolean) => Promise<void>
  /** Toggle hands-free sending (sub-permission of full access) and persist it. */
  setAutoSend: (autoSend: boolean) => Promise<void>
  /** Show or hide the floating status card, and persist the choice. */
  setStatusWidget: (statusWidget: boolean) => Promise<void>
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
  browserOpen: false,

  envStatus: envForProvider(DEFAULT_PROVIDER_SETTINGS.activeProvider),
  model: DEFAULT_PROVIDER_SETTINGS.modelName,
  theme: DEFAULT_PROVIDER_SETTINGS.ui.theme,
  effort: DEFAULT_PROVIDER_SETTINGS.ui.effort,
  planFirst: DEFAULT_PROVIDER_SETTINGS.ui.planFirst,
  statusWidget: DEFAULT_PROVIDER_SETTINGS.ui.statusWidget,
  fullAccess: DEFAULT_PROVIDER_SETTINGS.ui.fullAccess,
  autoSend: DEFAULT_PROVIDER_SETTINGS.ui.autoSend,
  workMode: DEFAULT_PROVIDER_SETTINGS.ui.mode,
  workspaceRoot: null,
  workspaceChosen: false,
  previewOpen: false,
  previewUrl: null,
  previewPhase: 'idle',
  previewError: null,
  previewReloadNonce: 0,
  railOpen: true,
  canvasOpen: false,
  canvasMode: 'log',
  logLane: null,
  armedCheckpoint: null,
  paletteOpen: false,

  setProjectName: (projectName) => set({ projectName }),
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  setMaximized: (isMaximized) => set({ isMaximized }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),

  browserPermissions: () => ({ ...DEFAULT_BROWSER_PERMISSIONS, ...get().settings.browser }),

  setBrowserPermission: async (action, permission) => {
    const { settings } = get()
    const browser = { ...DEFAULT_BROWSER_PERMISSIONS, ...settings.browser, [action]: permission }
    await get().saveSettings({ ...settings, browser })
  },

  setBrowserOpen: (open) => {
    if (open) {
      get().openBrowser()
    } else {
      get().closeBrowser()
    }
  },

  openBrowser: () => {
    // The preview, the browser and the canvas share one panel slot: whichever opens
    // last owns it. Stopping the preview server here would be too aggressive (the
    // user may still be building), so we only take the slot back.
    set({ browserOpen: true, previewOpen: false, canvasOpen: false })
    void window.sylor?.browser?.open()
  },

  closeBrowser: () => {
    // Hide, don't destroy: the page view keeps its cookies, scroll position and
    // history, so re-opening the panel resumes exactly where the user left off.
    void window.sylor?.browser?.setVisible(false)
    set({ browserOpen: false })
  },
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  openPreview: () => set({ previewOpen: true, browserOpen: false, canvasOpen: false }),
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
    set({
      previewOpen: true,
      canvasOpen: false,
      previewUrl: rawUrl,
      previewPhase: 'ready',
      previewError: null
    })
  },
  setRailOpen: (railOpen) => set({ railOpen }),
  toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),

  openCanvas: (mode) => {
    // Taking the slot from the browser means hiding its native view too — a flag
    // alone would leave the page floating over the canvas.
    if (get().browserOpen) void window.sylor?.browser?.setVisible(false)
    set({
      canvasOpen: true,
      browserOpen: false,
      previewOpen: false,
      ...(mode ? { canvasMode: mode } : {})
    })
  },
  closeCanvas: () => set({ canvasOpen: false }),
  setCanvasMode: (canvasMode) => {
    if (!get().canvasOpen) {
      get().openCanvas(canvasMode)
      return
    }
    set({ canvasMode })
  },
  toggleCanvas: (mode) => {
    const { canvasOpen, canvasMode } = get()
    // Clicking a different surface while open switches to it rather than closing —
    // only a click on the surface already showing means "hide this".
    if (canvasOpen && (mode == null || mode === canvasMode)) {
      get().closeCanvas()
      return
    }
    get().openCanvas(mode)
  },
  setLogLane: (logLane) => set({ logLane }),
  showLane: (logLane) => {
    set({ logLane })
    get().openCanvas('log')
  },
  armCheckpoint: (armedCheckpoint) => {
    set({ armedCheckpoint })
    if (armedCheckpoint != null) get().openCanvas('timeline')
  },
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

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

  setStatusWidget: async (statusWidget) => {
    // The save IS the toggle: main listens for it and opens/destroys the floating
    // card, so there is one writer and the window can't disagree with the setting.
    set({ statusWidget })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, statusWidget } })
  },

  setFullAccess: async (fullAccess) => {
    // Reflect immediately, then persist. Main reads `ui.fullAccess` fresh on every
    // enforcement decision (fs sandbox + permission matrix), so the save alone
    // flips the posture — no restart, and turning it back off re-confines at once.
    set({ fullAccess })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, fullAccess } })
  },

  setAutoSend: async (autoSend) => {
    // Same immediate-then-persist path as full access; `autoSendEnabled()` in main
    // gates it behind full access, so the save alone flips the send posture.
    set({ autoSend })
    const { settings } = get()
    await get().saveSettings({ ...settings, ui: { ...settings.ui, autoSend } })
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
      planFirst: settings.ui.planFirst,
      statusWidget: settings.ui.statusWidget,
      fullAccess: settings.ui.fullAccess,
      autoSend: settings.ui.autoSend
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
      planFirst: saved.ui.planFirst,
      statusWidget: saved.ui.statusWidget,
      fullAccess: saved.ui.fullAccess,
      autoSend: saved.ui.autoSend
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
      useAppStore.setState({
        previewOpen: true,
        browserOpen: false,
        previewPhase: 'starting',
        previewError: null
      })
      break
    case 'ready':
      useAppStore.setState((s) => ({
        previewOpen: true,
        browserOpen: false,
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
