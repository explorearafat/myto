import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'
import type { SylorApi } from '@shared/types'

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
  providers: {
    getSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
    // Echo the settings back, mirroring the main-process normalise-and-return.
    saveSettings: vi.fn((settings) => Promise.resolve(settings)),
    listModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    getCompletion: vi.fn().mockResolvedValue({ ok: true, content: '' }),
    streamCompletion: vi.fn().mockResolvedValue(() => {})
  },
  workflow: {
    // No-op run that immediately hands back a disposer.
    run: vi.fn().mockReturnValue(() => {}),
    toolDecision: vi.fn()
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
    appendTerminal: vi.fn()
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
    onEvent: vi.fn().mockReturnValue(() => {})
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
    get: vi.fn().mockResolvedValue({ root: '/test', chosen: false }),
    onChanged: vi.fn().mockReturnValue(() => {})
  }
}

vi.stubGlobal('sylor', sylorMock)
// Also attach to window so `window.sylor` resolves in component code.
;(globalThis as unknown as { window: { sylor: SylorApi } }).window ??= {} as never
;(window as unknown as { sylor: SylorApi }).sylor = sylorMock
