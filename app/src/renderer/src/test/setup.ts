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
    decideApproval: vi.fn()
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
      attachments: []
    }),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    mostRecent: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    appendMessage: vi.fn(),
    setFeedback: vi.fn(),
    resetMessage: vi.fn()
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
    pickWorkspace: vi.fn().mockResolvedValue(null)
  }
}

vi.stubGlobal('sylor', sylorMock)
// Also attach to window so `window.sylor` resolves in component code.
;(globalThis as unknown as { window: { sylor: SylorApi } }).window ??= {} as never
;(window as unknown as { sylor: SylorApi }).sylor = sylorMock
