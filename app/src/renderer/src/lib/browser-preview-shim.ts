/**
 * Browser-preview shim (DEV / non-Electron only).
 *
 * The renderer normally talks to the main process through `window.sylor`, a
 * bridge exposed by the Electron preload. When the page is opened in a plain
 * browser (e.g. the visual-preview tooling used to screenshot the UI), that
 * bridge does not exist and the app would crash on boot.
 *
 * This module installs an in-memory fake `window.sylor` **only** when the real
 * bridge is absent, so it is a no-op inside the packaged Electron app. It starts
 * from a clean slate — no seed sessions or messages — so the browser preview
 * mirrors a fresh install: an empty chat, empty rail, and empty preview. It
 * touches nothing in production behaviour — the guard below returns immediately
 * whenever the genuine preload bridge is present.
 */
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'
import type {
  Attachment,
  BrowserViewStatus,
  ChromeStatus,
  PersistedSession,
  Project,
  SessionSummary,
  SylorApi
} from '@shared/types'
import { emptyUsageStats } from '@shared/usage'

declare global {
  interface Window {
    __sylorPreviewShim?: boolean
  }
}

/** No real browser is reachable from a browser tab, and none ever will be. */
const PREVIEW_CHROME: ChromeStatus = {
  available: false,
  browserName: '',
  running: false,
  url: '',
  title: '',
  loading: false,
  signingIn: false,
  error: 'Sylor can only drive your real browser from the desktop app.'
}

/** Nor is the main-process page view: it needs a native window to draw into. */
const PREVIEW_VIEW: BrowserViewStatus = {
  attached: false,
  visible: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: 'The in-app browser needs the Sylor desktop app.'
}

function installShim(): void {
  const now = Date.UTC(2026, 7, 7, 14, 30) // fixed clock so screenshots are stable

  // No seed data: the preview begins empty (no sessions, no projects), just like
  // a first launch of the real app.
  const sessions: SessionSummary[] = []
  const projects: Project[] = []
  // In-memory attachment store keyed by id (bytes kept as the base64 the composer
  // passed in), so drag-drop + image thumbnails work in the browser preview.
  const attachmentStore = new Map<string, { att: Attachment; data: string }>()
  let counter = 0

  const emptyFor = (id: string): PersistedSession => ({
    session: sessions.find((s) => s.id === id) ?? {
      id,
      title: 'New chat',
      projectRoot: 'C:/Users/ARAFAT/OneDrive/Desktop/Sylor',
      projectId: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0
    },
    messages: [],
    tools: [],
    terminal: [],
    attachments: []
  })

  const api: SylorApi = {
    window: {
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      isMaximized: () => Promise.resolve(false),
      onMaximizedChange: () => () => {}
    },
    platform: 'win32',
    userName: 'ARAFAT',
    providers: {
      getSettings: () => Promise.resolve(DEFAULT_PROVIDER_SETTINGS),
      saveSettings: (s) => Promise.resolve(s),
      listModels: () => Promise.resolve({ ok: true, models: [] }),
      testConnection: () => Promise.resolve({ ok: true, message: 'preview' }),
      getCompletion: () => Promise.resolve({ ok: true, content: '' }),
      // Ends the stream immediately instead of never calling back: a consumer that
      // awaits the terminal chunk (the browse loop) would otherwise hang here.
      streamCompletion: (_request, onChunk) => {
        onChunk({ streamId: 'preview', delta: '', done: true })
        return Promise.resolve(() => {})
      }
    },
    workflow: {
      run: () => () => {},
      toolDecision: () => {}
    },
    sessions: {
      list: (projectId) =>
        Promise.resolve(sessions.filter((s) => projectId == null || s.projectId === projectId)),
      create: (projectId) => {
        const s: SessionSummary = {
          id: `sess-${++counter}`,
          title: 'New chat',
          projectRoot: 'C:/Users/ARAFAT/OneDrive/Desktop/Sylor',
          projectId: projectId ?? null,
          createdAt: now,
          updatedAt: now,
          messageCount: 0
        }
        sessions.unshift(s)
        return Promise.resolve(s)
      },
      load: (id) => Promise.resolve(emptyFor(id)),
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      mostRecent: () => Promise.resolve(null),
      // The preview keeps no message bodies, so search matches titles only.
      search: (query, projectId) => {
        const q = query.trim().toLowerCase()
        return Promise.resolve(
          q === ''
            ? []
            : sessions.filter(
                (s) =>
                  (projectId == null || s.projectId === projectId) &&
                  s.title.toLowerCase().includes(q)
              )
        )
      },
      appendMessage: () => {},
      updateMessage: () => {},
      setFeedback: () => {},
      resetMessage: () => {},
      appendToolOp: () => {},
      appendTerminal: () => {},
      // The preview stores no history, so the dashboard shows a fresh install.
      usageStats: () => Promise.resolve(emptyUsageStats(now))
    },
    projects: {
      list: () => Promise.resolve([...projects]),
      create: (name) => {
        const p: Project = {
          id: `proj-${++counter}`,
          name,
          instructions: '',
          memory: '',
          createdAt: now,
          updatedAt: now,
          sessionCount: 0
        }
        projects.unshift(p)
        return Promise.resolve(p)
      },
      rename: (id, name) => {
        const p = projects.find((x) => x.id === id)
        if (p) p.name = name
        return Promise.resolve()
      },
      setInstructions: (id, instructions) => {
        const p = projects.find((x) => x.id === id)
        if (p) p.instructions = instructions
        return Promise.resolve()
      },
      setMemory: (id, memory) => {
        const p = projects.find((x) => x.id === id)
        if (p) p.memory = memory
        return Promise.resolve()
      },
      remove: (id) => {
        const i = projects.findIndex((x) => x.id === id)
        if (i >= 0) projects.splice(i, 1)
        return Promise.resolve()
      },
      assignSession: () => Promise.resolve(),
      listKnowledge: () => Promise.resolve([]),
      addKnowledge: (projectId, name, content) =>
        Promise.resolve({ id: `know-${++counter}`, projectId, name, content, createdAt: now }),
      removeKnowledge: () => Promise.resolve()
    },
    attachments: {
      add: (input) => {
        const att: Attachment = {
          id: `att-${++counter}`,
          sessionId: input.sessionId,
          messageId: null,
          name: input.name,
          mime: input.mime,
          path: `/preview/${input.name}`,
          size: Math.floor((input.data.length * 3) / 4),
          createdAt: now
        }
        attachmentStore.set(att.id, { att, data: input.data })
        return Promise.resolve(att)
      },
      attachToMessage: (ids, messageId) => {
        for (const id of ids) {
          const entry = attachmentStore.get(id)
          if (entry) entry.att.messageId = messageId
        }
        return Promise.resolve()
      },
      read: (id) => {
        const entry = attachmentStore.get(id)
        return Promise.resolve(entry ? `data:${entry.att.mime};base64,${entry.data}` : null)
      },
      remove: (id) => {
        attachmentStore.delete(id)
        return Promise.resolve()
      }
    },
    // No real preview server outside Electron: start calls report unavailable and
    // no lifecycle events ever fire, so the panel just shows its empty state.
    preview: {
      startStatic: () =>
        Promise.resolve({
          ok: false,
          error: 'Live preview is unavailable in the browser preview.'
        }),
      startDev: () =>
        Promise.resolve({
          ok: false,
          error: 'Live preview is unavailable in the browser preview.'
        }),
      startAuto: () =>
        Promise.resolve({
          ok: false,
          error: 'Live preview is unavailable in the browser preview.'
        }),
      stop: () => {},
      onEvent: () => () => {},
      onInspectRequest: () => () => {},
      respondInspect: () => {}
    },
    // No MCP servers outside Electron: the registry is always empty here.
    mcp: {
      listServers: () => Promise.resolve([]),
      listTools: () => Promise.resolve([]),
      setEnabled: () => Promise.resolve([]),
      restoreDefaults: () => Promise.resolve([]),
      reconnect: () => Promise.resolve([]),
      addServer: () => Promise.resolve({ ok: true, servers: [] }),
      removeServer: () => Promise.resolve([]),
      configPaths: () => Promise.resolve({ global: '', project: null })
    },
    // No skills outside Electron: nothing is discovered from disk here.
    skills: {
      list: () => Promise.resolve([]),
      reload: () => Promise.resolve([]),
      setEnabled: () => Promise.resolve([]),
      restoreDefaults: () => Promise.resolve([]),
      add: () => Promise.resolve({ ok: true, skills: [] }),
      remove: () => Promise.resolve([]),
      configPaths: () => Promise.resolve({ global: '', project: null })
    },
    // No commands outside Electron: nothing is discovered from disk here.
    commands: {
      list: () => Promise.resolve([]),
      reload: () => Promise.resolve([]),
      add: () => Promise.resolve({ ok: true, commands: [] }),
      remove: () => Promise.resolve([]),
      configPaths: () => Promise.resolve({ global: '', project: null })
    },
    // No plugin install outside Electron (no git / no disk to unpack into).
    plugins: {
      list: () => Promise.resolve([]),
      install: () =>
        Promise.resolve({ ok: false, error: 'Plugins are unavailable in the browser preview.', plugins: [] }),
      remove: () => Promise.resolve([])
    },
    // No folder picker outside Electron: the workspace stays the cwd default
    // (never "chosen"), select is unavailable, and no change events ever fire.
    workspace: {
      select: () => Promise.resolve(null),
      setRoot: (dir) => Promise.resolve({ root: dir, chosen: false }),
      get: () => Promise.resolve({ root: 'C:/Users/ARAFAT/OneDrive/Desktop/Sylor', chosen: false }),
      onChanged: () => () => {}
    },
    // Long-term memory is empty in the browser preview (no userData store here).
    memory: {
      get: () => Promise.resolve(''),
      remember: () => Promise.resolve(false)
    },
    // No real browser to drive from a browser tab: report "nothing installed" so the
    // browser panel shows its explain-and-offer card instead of pretending to launch.
    chrome: {
      status: () => Promise.resolve(PREVIEW_CHROME),
      open: () => Promise.reject(new Error('The browser preview cannot launch Chrome.')),
      close: () => Promise.resolve(PREVIEW_CHROME),
      navigate: () => Promise.reject(new Error('The browser preview cannot launch Chrome.')),
      evaluate: () => Promise.resolve(null),
      screenshot: () => Promise.resolve(''),
      reload: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      go: () => Promise.resolve(false),
      focus: () => Promise.resolve(),
      signIn: () => Promise.reject(new Error('The browser preview cannot launch Chrome.')),
      finishSignIn: () => Promise.resolve(PREVIEW_CHROME),
      onStatus: () => () => {}
    },
    // The in-app page view is a native main-process view; a plain browser tab has
    // none, so every call is an honest no-op against a detached status.
    browser: {
      status: () => Promise.resolve(PREVIEW_VIEW),
      open: () => Promise.resolve(PREVIEW_VIEW),
      setBounds: () => Promise.resolve(),
      setVisible: () => Promise.resolve(),
      close: () => Promise.resolve(PREVIEW_VIEW),
      reload: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      go: () => Promise.resolve(false),
      setDriver: () => Promise.resolve(),
      onStatus: () => () => {}
    },
    // No scheduler in the browser preview: an empty list, and mutators are no-ops
    // (nothing ticks here, so tasks would never fire anyway).
    scheduler: {
      list: () => Promise.resolve([]),
      add: (input) =>
        Promise.resolve({
          id: 'preview-task',
          name: input.name,
          prompt: input.prompt,
          cron: input.cron,
          enabled: input.enabled ?? true,
          durable: input.durable ?? false,
          ...(input.mode ? { mode: input.mode } : {}),
          createdAt: 0,
          updatedAt: 0
        }),
      update: () => Promise.resolve(null),
      setEnabled: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
      onTaskFired: () => () => {}
    }
  }

  ;(window as unknown as { sylor: SylorApi }).sylor = api
  window.__sylorPreviewShim = true
  console.info('[sylor] browser-preview shim active (no Electron bridge detected)')
}

// Guard: only install when the genuine Electron preload bridge is absent.
if (typeof window !== 'undefined' && !('sylor' in window)) {
  installShim()
}

export {}
