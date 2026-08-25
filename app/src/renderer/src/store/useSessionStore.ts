import { create } from 'zustand'
import type { SessionSummary } from '@shared/types'
import { useChatStore } from './useChatStore'

/** The placeholder title new sessions are created with (see main/session-ipc.ts). */
const DEFAULT_SESSION_TITLE = 'New session'

/** Longest auto-generated title, in characters, before it's clipped with an ellipsis. */
const MAX_TITLE_LEN = 48

/**
 * Derive a session title from the first user prompt (Claude-Desktop style): the
 * first non-empty line with its whitespace collapsed, clipped to
 * {@link MAX_TITLE_LEN} at a word boundary and suffixed with an ellipsis when it
 * overflows. Returns '' when the prompt has no usable text (e.g. an
 * attachment-only turn), so the caller can skip renaming.
 */
function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_TITLE_LEN) return collapsed
  const clipped = collapsed.slice(0, MAX_TITLE_LEN)
  const lastSpace = clipped.lastIndexOf(' ')
  // Prefer a word boundary, but only if it doesn't chop off most of the title.
  const base = lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped
  return `${base.trimEnd()}…`
}

/**
 * Session-history state (Phase 5): the sidebar list, which session is active,
 * and the flyout's open/closed state.
 *
 * This store is the single orchestrator for switching conversations: it calls
 * the persistence IPC and then drives {@link useChatStore} synchronously via its
 * `applyLoaded`/`resetTo` seams, so a session is loaded from disk exactly once.
 */
export interface SessionState {
  sessions: SessionSummary[]
  activeSessionId: string | null
  /**
   * The project the recents list is scoped to. `null` shows every chat across
   * projects (the "All chats" view). Selecting a project narrows both the list
   * and the project new chats are filed under. Lives here (not in the project
   * store) so the project→session coupling stays one-directional.
   */
  activeProjectId: string | null
  /** Whether the Sessions flyout is open. */
  listOpen: boolean

  setListOpen: (open: boolean) => void
  /** Scope the recents list to a project (or `null` for all chats) and reload. */
  setActiveProject: (projectId: string | null) => Promise<void>
  /** Restore the most-recent session on startup, or create a fresh one. */
  boot: () => Promise<void>
  /** Reload the session list from the main process (scoped to the active project). */
  refresh: () => Promise<void>
  /** Load a session by id and make it active (rehydrates the chat). */
  open: (id: string) => Promise<void>
  /** Create a fresh session and switch to it. */
  create: () => Promise<void>
  /** Rename a session (optimistic; re-sorts by the bumped updatedAt). */
  rename: (id: string, title: string) => Promise<void>
  /**
   * Auto-title the active session from its first user prompt, mirroring Claude
   * Desktop. Only renames a session still on its default ('New session') title,
   * so a manual rename — or a session that already carries a real title — is
   * never clobbered. No-op when the derived title is empty (attachment-only turn)
   * or the active session can't be found in the list.
   */
  autoName: (prompt: string) => Promise<void>
  /** Delete a session; if it was active, reselect or create a replacement. */
  remove: (id: string) => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeProjectId: null,
  listOpen: false,

  setListOpen: (listOpen) => set({ listOpen }),

  setActiveProject: async (projectId) => {
    set({ activeProjectId: projectId })
    await get().refresh()
  },

  boot: async () => {
    const recent = await window.sylor.sessions.mostRecent()
    if (recent) {
      await get().open(recent)
    } else {
      await get().create()
    }
  },

  refresh: async () => {
    const sessions = await window.sylor.sessions.list(get().activeProjectId)
    set({ sessions })
  },

  open: async (id) => {
    const loaded = await window.sylor.sessions.load(id)
    if (!loaded) {
      // Deleted out from under us — fall back to a fresh session.
      await get().create()
      return
    }
    useChatStore.getState().applyLoaded(loaded)
    set({ activeSessionId: loaded.session.id, listOpen: false })
    await get().refresh()
  },

  create: async () => {
    // New chats are filed under the project the rail is scoped to (or none).
    const summary = await window.sylor.sessions.create(get().activeProjectId)
    useChatStore.getState().resetTo(summary.id, summary.projectId)
    set({ activeSessionId: summary.id, listOpen: false })
    await get().refresh()
  },

  rename: async (id, title) => {
    await window.sylor.sessions.rename(id, title)
    await get().refresh()
  },

  autoName: async (prompt) => {
    const title = deriveTitle(prompt)
    if (!title) return
    const { activeSessionId, sessions } = get()
    if (!activeSessionId) return
    const active = sessions.find((s) => s.id === activeSessionId)
    // Only title a fresh, still-default session; never overwrite a real title.
    if (!active || active.title !== DEFAULT_SESSION_TITLE) return
    await get().rename(activeSessionId, title)
  },

  remove: async (id) => {
    // Stop that chat's background run first: the row is about to disappear, and a
    // run left pointing at it would keep working with no way to reach it.
    useChatStore.getState().cancelSession(id)
    await window.sylor.sessions.remove(id)
    if (get().activeSessionId === id) {
      // The open session was deleted: reopen the next most-recent, or start fresh.
      const remaining = await window.sylor.sessions.list(get().activeProjectId)
      if (remaining.length > 0) {
        await get().open(remaining[0].id)
      } else {
        await get().create()
      }
    } else {
      await get().refresh()
    }
  }
}))
