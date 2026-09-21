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
 * mirrors a fresh install: an empty chat and empty rail. It touches nothing in
 * production behaviour — the guard below returns immediately whenever the genuine
 * preload bridge is present.
 */
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'
import type {
  Attachment,
  PersistedSession,
  Project,
  SessionSummary,
  SylorApi
} from '@shared/types'

declare global {
  interface Window {
    __sylorPreviewShim?: boolean
  }
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
      // awaits the terminal chunk would otherwise hang here.
      streamCompletion: (_request, onChunk) => {
        onChunk({ streamId: 'preview', delta: '', done: true })
        return Promise.resolve(() => {})
      },
      decideApproval: () => {}
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
      setFeedback: () => {},
      resetMessage: () => {}
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
    auth: {
      signInWithGoogle: () => Promise.resolve({ ok: false as const, error: '' })
    },
    files: {
      save: () => Promise.resolve({ ok: false as const, canceled: true as const })
    },
    cowork: {
      // The browser preview has no native folder dialog; report "cancelled".
      pickWorkspace: () => Promise.resolve(null)
    },
    preview: {
      // No OS shell in the browser preview; opening externally is a no-op.
      openExternal: () => {}
    },
    mcp: {
      // No connector processes in the browser preview.
      status: () => Promise.resolve([]),
      sync: () => Promise.resolve([]),
      test: () => Promise.resolve({ ok: false, error: 'Connectors are unavailable in the browser preview.' }),
      onStatusChanged: () => () => {}
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
