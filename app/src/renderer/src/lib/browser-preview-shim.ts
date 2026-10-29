/**
 * Browser-preview shim (DEV / non-Electron only).
 *
 * The renderer normally talks to the main process through `window.myto`, a
 * bridge exposed by the Electron preload. When the page is opened in a plain
 * browser (e.g. the visual-preview tooling used to screenshot the UI), that
 * bridge does not exist and the app would crash on boot.
 *
 * This module installs an in-memory fake `window.myto` **only** when the real
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
  MytoApi
} from '@shared/types'

declare global {
  interface Window {
    __mytoPreviewShim?: boolean
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
      projectRoot: 'C:/Users/ARAFAT/OneDrive/Desktop/Myto',
      projectId: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      mode: 'chat'
    },
    messages: [],
    attachments: []
  })

  // ── Studio preview fakes (so the manual editor is demoable without ffmpeg) ──
  const bakeListeners = new Set<(p: { jobId: string; pct: number; label: string }) => void>()
  const emitBake = (jobId: string): void => {
    ;[20, 60, 100].forEach((pct, i) =>
      setTimeout(
        () => bakeListeners.forEach((cb) => cb({ jobId, pct, label: pct === 100 ? 'Done' : 'Rendering…' })),
        i * 140
      )
    )
  }
  let sampleCache = ''
  const samplePhoto = (): string => {
    if (sampleCache) return sampleCache
    const c = document.createElement('canvas')
    c.width = 960
    c.height = 640
    const x = c.getContext('2d')
    if (!x) return ''
    const sky = x.createLinearGradient(0, 0, 0, 640)
    sky.addColorStop(0, '#2a3a6b')
    sky.addColorStop(0.5, '#e8803a')
    sky.addColorStop(1, '#f6c67a')
    x.fillStyle = sky
    x.fillRect(0, 0, 960, 640)
    x.fillStyle = '#ffd98a'
    x.beginPath()
    x.arc(480, 360, 90, 0, Math.PI * 2)
    x.fill()
    x.fillStyle = 'rgba(18,18,36,0.85)'
    x.fillRect(0, 470, 960, 170)
    x.fillStyle = 'rgba(18,18,36,0.6)'
    for (let i = 0; i < 6; i++) {
      const w = 60 + i * 18
      x.fillRect(70 + i * 150, 470 - (40 + (i % 3) * 55), w, 200)
    }
    sampleCache = c.toDataURL('image/jpeg', 0.9)
    return sampleCache
  }

  const api: MytoApi = {
  cancelAll: async () => undefined,
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
      decideApproval: () => {},
      answerQuestions: () => {}
    },
    sessions: {
      list: (projectId) =>
        Promise.resolve(sessions.filter((s) => projectId == null || s.projectId === projectId)),
      create: (projectId, mode) => {
        const s: SessionSummary = {
          id: `sess-${++counter}`,
          title: 'New chat',
          projectRoot: 'C:/Users/ARAFAT/OneDrive/Desktop/Myto',
          projectId: projectId ?? null,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          mode: mode ?? 'chat'
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
      resetMessage: () => {},
      rewind: () =>
        Promise.resolve({ ok: true, filesRestored: 0, filesDeleted: 0, messagesRemoved: 0 }),
      snapshotBefore: () => Promise.resolve(null),
      fileDiff: () => Promise.resolve(null)
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
      save: () => Promise.resolve({ ok: false as const, canceled: true as const }),
      // No OS file manager in the browser preview; reveal is a no-op.
      revealInFolder: () => undefined
    },
    cowork: {
      // The browser preview has no native folder dialog; report "cancelled".
      pickWorkspace: () => Promise.resolve(null),
      // No workspace sandbox in the browser preview, so no files to mention.
      listFiles: () => Promise.resolve([]),
      // No Electron BrowserWindow in the browser preview; opening the setup window is a no-op.
      openBrowserSetup: () => Promise.resolve()
    },
    credentials: {
      // No credential vault in the browser preview: an empty, inert list.
      list: () => Promise.resolve([]),
      save: () => Promise.resolve([]),
      delete: () => Promise.resolve([])
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
    },
    voice: {
      // No gateway in the preview: force the Web Speech fallback.
      transcribe: () => Promise.resolve({ ok: false, error: 'no-gateway' })
    },
    screenshot: {
      // No desktopCapturer in the browser preview.
      capture: () => Promise.resolve(null)
    },
    scheduledTasks: {
      // No scheduler in the browser preview: an empty, inert task list.
      list: () => Promise.resolve([]),
      create: () => Promise.resolve(null as never),
      update: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
      runNow: () => Promise.resolve(),
      onFire: () => () => {}
    },
    terminal: {
      // No PTY in the browser preview: spawn reports unavailable, the rest no-op.
      spawn: () => Promise.resolve({ ok: false, buffer: '' }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => () => {},
      onExit: () => () => {}
    },
    editor: {
      // The browser preview has no ffmpeg/workspace, so the Studio is faked just enough to
      // exercise the UI: a generated sample image stands in for an opened file, "bake" echoes
      // it back through a couple of progress ticks, and "critique" returns a canned verdict.
      listMedia: () =>
        Promise.resolve([
          { path: 'samples/sunset.jpg', kind: 'photo' as const },
          { path: 'samples/clip.mp4', kind: 'video' as const }
        ]),
      openPhoto: () => Promise.resolve({ preview: samplePhoto(), width: 960, height: 640 }),
      openVideo: () => Promise.resolve({ preview: samplePhoto(), width: 1280, height: 720, durationSec: 12 }),
      frameAt: () => Promise.resolve(samplePhoto()),
      bakePhoto: (_path, _adjust, jobId) => {
        emitBake(jobId)
        return Promise.resolve({ ok: true as const, outputPath: 'myto-edits/sunset-edit.jpg', resultPreview: samplePhoto(), url: '' })
      },
      bakeVideo: (_plan, jobId) => {
        emitBake(jobId)
        return Promise.resolve({ ok: true as const, outputPath: 'myto-edits/clip-reel.mp4', resultPreview: samplePhoto(), url: '' })
      },
      critique: () => Promise.resolve({ ok: true, note: 'Looks warm and balanced — matches your goal.', done: true }),
      onBakeProgress: (cb) => {
        bakeListeners.add(cb)
        return () => bakeListeners.delete(cb)
      }
    }
  }

  ;(window as unknown as { myto: MytoApi }).myto = api
  window.__mytoPreviewShim = true
  console.info('[myto] browser-preview shim active (no Electron bridge detected)')
}

// Guard: only install when the genuine Electron preload bridge is absent.
if (typeof window !== 'undefined' && !('myto' in window)) {
  installShim()
}

export {}
