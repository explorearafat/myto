import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'
import type { MytoApi } from '@shared/types'

/**
 * jsdom has no Electron preload bridge, so stub `window.myto` with a minimal
 * fake. Provider methods echo/no-op so store logic (which reads back the saved
 * value) works without a real main process.
 */
const mytoMock: MytoApi = {
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
    }),
    decideApproval: vi.fn(),
    answerQuestions: vi.fn()
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
      messageCount: 0,
      mode: 'chat'
    }),
    load: vi.fn().mockResolvedValue({
      session: {
        id: 'sess-test',
        title: 'New session',
        projectRoot: '/test',
        projectId: null,
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
        mode: 'chat'
      },
      messages: [],
      attachments: []
    }),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    mostRecent: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    appendMessage: vi.fn(),
    setFeedback: vi.fn(),
    resetMessage: vi.fn(),
    rewind: vi
      .fn()
      .mockResolvedValue({ ok: true, filesRestored: 0, filesDeleted: 0, messagesRemoved: 0 }),
    snapshotBefore: vi.fn().mockResolvedValue(null)
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
  auth: {
    signInWithGoogle: vi.fn().mockResolvedValue({ ok: false, error: '' })
  },
  files: {
    save: vi.fn().mockResolvedValue({ ok: false, canceled: true })
  },
  cowork: {
    pickWorkspace: vi.fn().mockResolvedValue(null),
    listFiles: vi.fn().mockResolvedValue([]),
    openBrowserSetup: vi.fn().mockResolvedValue(undefined)
  },
  preview: {
    openExternal: vi.fn()
  },
  mcp: {
    status: vi.fn().mockResolvedValue([]),
    sync: vi.fn().mockResolvedValue([]),
    test: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable' }),
    onStatusChanged: vi.fn().mockReturnValue(() => {})
  },
  voice: {
    transcribe: vi.fn().mockResolvedValue({ ok: false, error: 'no-gateway' })
  },
  screenshot: {
    capture: vi.fn().mockResolvedValue(null)
  },
  scheduledTasks: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined),
    runNow: vi.fn().mockResolvedValue(undefined),
    onFire: vi.fn().mockReturnValue(() => {})
  },
  terminal: {
    spawn: vi.fn().mockResolvedValue({ ok: false, buffer: '' }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {})
  }
}

vi.stubGlobal('myto', mytoMock)
// Also attach to window so `window.myto` resolves in component code.
;(globalThis as unknown as { window: { myto: MytoApi } }).window ??= {} as never
;(window as unknown as { myto: MytoApi }).myto = mytoMock
