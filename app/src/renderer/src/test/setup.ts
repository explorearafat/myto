import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'
import type { AmbientStatus, BrowserViewStatus, ChromeStatus, SylorApi } from '@shared/types'
import { emptyUsageStats } from '@shared/usage'

/** A located-but-not-running real browser: what tests see unless they override it. */
const CHROME_IDLE: ChromeStatus = {
  available: true,
  browserName: 'Google Chrome',
  running: false,
  url: '',
  title: '',
  loading: false,
  signingIn: false,
  error: null
}

/** Nothing is running under vitest, so the ambient surfaces report exactly that. */
const AMBIENT_IDLE: AmbientStatus = {
  state: 'idle',
  message: 'Nothing running',
  lane: null,
  agents: 0,
  startedAt: 0,
  runId: null
}

/** No in-app page view exists under vitest (it is a main-process native view). */
const BROWSER_IDLE: BrowserViewStatus = {
  attached: false,
  visible: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

/**
 * jsdom has no Electron preload bridge, so stub `window.sylor` with a minimal
 * fake. Provider methods echo/no-op so store logic (which reads back the saved
 * value) works without a real main process.
 */
const sylorMock: SylorApi = {
  window: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChange: vi.fn().mockReturnValue(() => {})
  },
  platform: 'win32',
  userName: 'Tester',
  providers: {
    getSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
    // Echo the settings back, mirroring the main-process normalise-and-return.
    saveSettings: vi.fn((settings) => Promise.resolve(settings)),
    listModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    getCompletion: vi.fn().mockResolvedValue({ ok: true, content: '' }),
    // Terminates the stream at once so a consumer awaiting the final chunk resolves
    // rather than hanging; tests that need real deltas override this per-test.
    streamCompletion: vi.fn((_request, onChunk) => {
      onChunk({ streamId: 'test', delta: '', done: true })
      return Promise.resolve(() => {})
    })
  },
  workflow: {
    // No-op run that immediately hands back a disposer.
    run: vi.fn().mockReturnValue(() => {}),
    toolDecision: vi.fn(),
    cancelAgent: vi.fn(),
    revokeApproval: vi.fn(),
    answerQuestion: vi.fn()
  },
  sessions: {
    // Query ops resolve sane empty defaults so boot() has no session and falls
    // back to create(); appends are no-op fire-and-forget spies.
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({
      id: 'sess-test',
      title: 'New session',
      projectRoot: '/test',
      projectId: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0
    }),
    load: vi.fn().mockResolvedValue({
      session: {
        id: 'sess-test',
        title: 'New session',
        projectRoot: '/test',
        projectId: null,
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0
      },
      messages: [],
      tools: [],
      terminal: [],
      attachments: []
    }),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    mostRecent: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    setFeedback: vi.fn(),
    resetMessage: vi.fn(),
    appendToolOp: vi.fn(),
    appendTerminal: vi.fn(),
    usageStats: vi.fn().mockResolvedValue(emptyUsageStats(0))
  },
  projects: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({
      id: 'proj-test',
      name: 'New project',
      instructions: '',
      memory: '',
      createdAt: 0,
      updatedAt: 0,
      sessionCount: 0
    }),
    rename: vi.fn().mockResolvedValue(undefined),
    setInstructions: vi.fn().mockResolvedValue(undefined),
    setMemory: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    assignSession: vi.fn().mockResolvedValue(undefined),
    listKnowledge: vi.fn().mockResolvedValue([]),
    addKnowledge: vi.fn().mockResolvedValue({
      id: 'know-test',
      projectId: 'proj-test',
      name: 'doc',
      content: '',
      createdAt: 0
    }),
    removeKnowledge: vi.fn().mockResolvedValue(undefined)
  },
  attachments: {
    add: vi.fn().mockResolvedValue({
      id: 'att-test',
      sessionId: 'sess-test',
      messageId: null,
      name: 'file.txt',
      mime: 'text/plain',
      path: '/test/att',
      size: 0,
      createdAt: 0
    }),
    attachToMessage: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined)
  },
  preview: {
    startStatic: vi.fn().mockResolvedValue({ ok: true, url: 'http://127.0.0.1:0/index.html' }),
    startDev: vi.fn().mockResolvedValue({ ok: true, url: 'http://127.0.0.1:5173/' }),
    startAuto: vi.fn().mockResolvedValue({ ok: true, url: 'http://127.0.0.1:5173/' }),
    stop: vi.fn(),
    // No lifecycle events in tests; hand back a no-op disposer.
    onEvent: vi.fn().mockReturnValue(() => {}),
    onInspectRequest: vi.fn().mockReturnValue(() => {}),
    respondInspect: vi.fn()
  },
  mcp: {
    listServers: vi.fn().mockResolvedValue([]),
    listTools: vi.fn().mockResolvedValue([]),
    setEnabled: vi.fn().mockResolvedValue([]),
    restoreDefaults: vi.fn().mockResolvedValue([]),
    reconnect: vi.fn().mockResolvedValue([]),
    addServer: vi.fn().mockResolvedValue({ ok: true, servers: [] }),
    removeServer: vi.fn().mockResolvedValue([]),
    configPaths: vi.fn().mockResolvedValue({ global: '', project: null })
  },
  skills: {
    list: vi.fn().mockResolvedValue([]),
    reload: vi.fn().mockResolvedValue([]),
    setEnabled: vi.fn().mockResolvedValue([]),
    restoreDefaults: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({ ok: true, skills: [] }),
    remove: vi.fn().mockResolvedValue([]),
    configPaths: vi.fn().mockResolvedValue({ global: '', project: null })
  },
  commands: {
    list: vi.fn().mockResolvedValue([]),
    reload: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({ ok: true, commands: [] }),
    remove: vi.fn().mockResolvedValue([]),
    configPaths: vi.fn().mockResolvedValue({ global: '', project: null })
  },
  plugins: {
    list: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
    remove: vi.fn().mockResolvedValue([])
  },
  workspace: {
    // No folder picker in jsdom: the workspace stays the cwd default (never
    // "chosen"), select resolves null, and no change events fire.
    select: vi.fn().mockResolvedValue(null),
    setRoot: vi.fn().mockImplementation((dir: string) => Promise.resolve({ root: dir, chosen: false })),
    get: vi.fn().mockResolvedValue({ root: '/test', chosen: false }),
    onChanged: vi.fn().mockReturnValue(() => {})
  },
  memory: {
    // Empty long-term memory in tests; remember() reports "newly saved".
    get: vi.fn().mockResolvedValue(''),
    remember: vi.fn().mockResolvedValue(true)
  },
  checkpoints: {
    // No project on disk under vitest: an empty timeline, and a restore that
    // truthfully reports it found nothing rather than claiming success.
    list: vi.fn().mockResolvedValue([]),
    restore: vi.fn().mockResolvedValue({ ok: false, error: 'That checkpoint is no longer on record.' })
  },
  graph: {
    // Nothing indexed under vitest, so the graph is honestly empty rather than a
    // fixture the tests could accidentally assert against as if it were real.
    build: vi
      .fn()
      .mockResolvedValue({ scope: 'run', nodes: [], edges: [], omitted: 0, indexed: 0 })
  },
  chrome: {
    // No real browser under vitest: available, never running, every call a no-op.
    status: vi.fn().mockResolvedValue(CHROME_IDLE),
    open: vi.fn().mockResolvedValue({ ...CHROME_IDLE, running: true }),
    close: vi.fn().mockResolvedValue(CHROME_IDLE),
    navigate: vi.fn().mockResolvedValue({ ...CHROME_IDLE, running: true }),
    evaluate: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(''),
    reload: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    go: vi.fn().mockResolvedValue(false),
    focus: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue({ ...CHROME_IDLE, signingIn: true }),
    finishSignIn: vi.fn().mockResolvedValue(CHROME_IDLE),
    onStatus: vi.fn().mockReturnValue(() => {})
  },
  browser: {
    // The in-app page view is a native main-process view: absent under vitest.
    status: vi.fn().mockResolvedValue(BROWSER_IDLE),
    open: vi.fn().mockResolvedValue({ ...BROWSER_IDLE, attached: true, visible: true }),
    setBounds: vi.fn().mockResolvedValue(undefined),
    setVisible: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(BROWSER_IDLE),
    reload: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    go: vi.fn().mockResolvedValue(false),
    setDriver: vi.fn().mockResolvedValue(undefined),
    onStatus: vi.fn().mockReturnValue(() => {})
  },
  scheduler: {
    // No scheduled tasks in tests; mutators echo back a benign shape / null.
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    setEnabled: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined),
    onTaskFired: vi.fn().mockReturnValue(() => {})
  },
  ambient: {
    // The tray and the floating card live in main; here they are an idle status and
    // subscriptions that hand back a disposer so effects can clean up.
    get: vi.fn().mockResolvedValue(AMBIENT_IDLE),
    onStatus: vi.fn().mockReturnValue(() => {}),
    focus: vi.fn(),
    onFocusLane: vi.fn().mockReturnValue(() => {}),
    stop: vi.fn(),
    onStopRequest: vi.fn().mockReturnValue(() => {})
  }
}

vi.stubGlobal('sylor', sylorMock)
// Also attach to window so `window.sylor` resolves in component code.
;(globalThis as unknown as { window: { sylor: SylorApi } }).window ??= {} as never
;(window as unknown as { sylor: SylorApi }).sylor = sylorMock
