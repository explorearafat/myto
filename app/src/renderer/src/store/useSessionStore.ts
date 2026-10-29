import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import type { RewindResult, SessionSummary } from '@shared/types'
import { useChatStore } from './useChatStore'

/** The placeholder title new sessions are created with (see main/session-ipc.ts). */
const DEFAULT_SESSION_TITLE = 'New session'

/** Longest title, in characters, before it's clipped with an ellipsis. */
const MAX_TITLE_LEN = 48

/**
 * Collapse whitespace and clip to {@link MAX_TITLE_LEN} at a word boundary,
 * suffixing an ellipsis when it overflows.
 */
function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_TITLE_LEN) return collapsed
  const clipped = collapsed.slice(0, MAX_TITLE_LEN)
  const lastSpace = clipped.lastIndexOf(' ')
  // Prefer a word boundary, but only if it doesn't chop off most of the title.
  const base = lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped
  return `${base.trimEnd()}…`
}

/**
 * Derive a session title from the first user prompt (Claude-Desktop style): the
 * first non-empty line, whitespace-collapsed and clipped. This is the session's
 * final title — set once from the first message and then left fixed. Returns ''
 * when the prompt has no usable text (e.g. an attachment-only turn), so the caller
 * can skip renaming.
 */
/** 3–5 words, Title Cased from the first prompt — e.g. "Fix Login Bug". */
function titleCaseWords(words: string[]): string {
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}
export function deriveTitle(prompt: string): string {
  const firstLine = prompt.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!firstLine) return ''
  const cleaned = firstLine.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = cleaned.split(' ').filter(Boolean).slice(0, 5)
  if (words.length <= 2) return clip(firstLine)
  const core = words.slice(0, Math.min(5, Math.max(3, words.length)))
  const title = titleCaseWords(core)
  return title || clip(firstLine)
}

/**
 * Load a session by id, rehydrate the chat, and make it active. Returns `true`
 * on success; on a missing/deleted id it falls back to a fresh draft and returns
 * `false`. Shared by {@link SessionState.open}, `back`, and `forward` so the
 * back/forward arrows and a direct click load a session through one code path.
 */
async function loadInto(
  id: string,
  set: StoreApi<SessionState>['setState'],
  get: StoreApi<SessionState>['getState']
): Promise<boolean> {
  const loaded = await window.myto.sessions.load(id)
  if (!loaded) {
    // Deleted out from under us — fall back to a fresh landing page.
    await get().newDraft()
    return false
  }
  useChatStore.getState().applyLoaded(loaded)
  set({ activeSessionId: loaded.session.id })
  await get().refresh()
  return true
}

/**
 * Session-history state (Phase 5): the recents list, which session is active,
 * and the back/forward navigation across the ones opened this launch.
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

  /**
   * Browser-style back/forward navigation across the sessions the user has
   * opened this launch. `navStack` holds session ids oldest→newest and `navPos`
   * points at the currently-shown entry; opening a chat truncates any forward
   * history (a fresh branch), while back()/forward() move `navPos` without
   * re-recording. Purely in-memory — a foundation for the sidebar arrows.
   */
  navStack: string[]
  navPos: number

  /** Scope the recents list to a project (or `null` for all chats) and reload. */
  setActiveProject: (projectId: string | null) => Promise<void>
  /**
   * Startup entry point: open a fresh, unsaved landing page (never restore the
   * last chat) with the full, global history loaded in the rail.
   */
  boot: () => Promise<void>
  /**
   * Show a fresh landing page (Claude-Desktop style): an empty, unsaved draft —
   * no DB row is written until the first message is sent. Used by boot, the
   * "New chat" button, and the deleted/empty fallbacks. Keeps the current project
   * scope and reloads the (global) list.
   */
  newDraft: () => Promise<void>
  /** Reload the session list from the main process (global; a project scope narrows it). */
  refresh: () => Promise<void>
  /** Load a session by id and make it active (rehydrates the chat). */
  open: (id: string) => Promise<void>
  /**
   * Step back to the previously-opened session (sidebar ◄ arrow). No-op when
   * there's no earlier entry. Moves `navPos` without re-recording, so repeated
   * back/forward walks the same stack instead of branching it.
   */
  back: () => Promise<void>
  /** Step forward to the next session in the nav stack (sidebar ► arrow). No-op at the tip. */
  forward: () => Promise<void>
  /** Persist a new session and switch to it (the lazy first-send path). */
  create: () => Promise<void>
  /** Rename a session (optimistic; re-sorts by the bumped updatedAt). */
  rename: (id: string, title: string) => Promise<void>
  /**
   * Auto-title the active session from its first user prompt (Claude-Desktop
   * style): the title is derived once from the first message — first line,
   * clipped — and then left fixed. There is deliberately NO AI re-titling pass; it
   * used to rename the session after the fact, which read as the title "changing
   * on its own". Only touches a session still on its default ('New session')
   * title, so a manual rename is never clobbered. No-op when the derived title is
   * empty (attachment-only turn) or no session is active.
   */
  autoName: (prompt: string) => Promise<void>
  /** Delete a session; if it was active, reselect or create a replacement. */
  remove: (id: string) => Promise<void>
  /**
   * Rewind (#1 "restore to here"): roll the active session's Cowork file changes
   * and chat back to just after `afterMsgId`, then reload so the truncation +
   * restored files show. Returns the main process's summary (or null when there's
   * no active session). Destructive — the caller confirms first.
   */
  rewind: (afterMsgId: string) => Promise<RewindResult | null>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeProjectId: null,
  navStack: [],
  navPos: -1,

  setActiveProject: async (projectId) => {
    set({ activeProjectId: projectId })
    await get().refresh()
  },

  boot: async () => {
    // Reopen where the user left off: the most recent session WITH messages.
    // A truly fresh install (or an empty history) still lands on the new-draft
    // hero. Clear any stale project filter so "All chats" is shown.
    set({ activeProjectId: null })
    try {
      const last = await window.myto.sessions.mostRecent()
      if (last) {
        await get().open(last)
        return
      }
    } catch {
      // Fall through to the fresh draft.
    }
    await get().newDraft()
  },

  newDraft: async () => {
    // Starting fresh ENDS any run still going: every in-flight agent stream and
    // background dev server from the old task is torn down in the main process,
    // so the new task never inherits a live shell (the "shell stays open" bug).
    try {
      void window.myto.cancelAll?.()
    } catch {
      // The main process may be mid-quit — ignore.
    }
    // A fresh landing page: clear the chat to an empty draft (sessionId = null →
    // the composer shows the EmptyState hero). No row is written yet — the first
    // send lazily calls create() to persist it, so the sidebar never fills with
    // empty 'New session' rows the way an eager create would (Claude-Desktop
    // parity). The recents list is untouched apart from a refresh.
    useChatStore.getState().resetTo(null)
    set({ activeSessionId: null })
    await get().refresh()
  },

  refresh: async () => {
    const sessions = await window.myto.sessions.list(get().activeProjectId)
    set({ sessions })
  },

  open: async (id) => {
    const ok = await loadInto(id, set, get)
    if (!ok) return
    // Record in the back/forward stack: drop any forward history (this is a new
    // branch), skip a no-op re-open of the current entry, then advance the tip.
    const { navStack, navPos } = get()
    if (navStack[navPos] === id) return
    const trimmed = navStack.slice(0, navPos + 1)
    trimmed.push(id)
    set({ navStack: trimmed, navPos: trimmed.length - 1 })
  },

  back: async () => {
    const { navStack, navPos } = get()
    if (navPos <= 0) return
    const target = navPos - 1
    set({ navPos: target })
    // If the recorded session was deleted, loadInto falls back to a draft; the
    // pointer still moved, so a second back keeps walking the stack.
    await loadInto(navStack[target], set, get)
  },

  forward: async () => {
    const { navStack, navPos } = get()
    if (navPos >= navStack.length - 1) return
    const target = navPos + 1
    set({ navPos: target })
    await loadInto(navStack[target], set, get)
  },

  create: async () => {
    // New chats are filed under the project the rail is scoped to (or none), and
    // fixed to the mode the composer is currently on ('chat' | 'cowork' | 'research')
    // — a session never mixes modes, so the mode is captured once here at creation.
    const mode = useChatStore.getState().draftMode
    const summary = await window.myto.sessions.create(get().activeProjectId, mode)
    useChatStore.getState().resetTo(summary.id, summary.projectId)
    set({ activeSessionId: summary.id })
    await get().refresh()
  },

  rename: async (id, title) => {
    await window.myto.sessions.rename(id, title)
    await get().refresh()
  },

  autoName: async (prompt) => {
    const title = deriveTitle(prompt)
    if (!title) return
    const { activeSessionId } = get()
    if (!activeSessionId) return
    let sessions = get().sessions
    let active = sessions.find((s) => s.id === activeSessionId)
    if (!active) {
      sessions = await window.myto.sessions.list(get().activeProjectId)
      set({ sessions })
      active = sessions.find((s) => s.id === activeSessionId)
    }
    if (!active || active.title !== DEFAULT_SESSION_TITLE) return
    await get().rename(activeSessionId, title)
  },

  remove: async (id) => {
    // Stop that chat's background run first: the row is about to disappear, and a
    // run left pointing at it would keep working with no way to reach it.
    useChatStore.getState().cancelSession(id)
    await window.myto.sessions.remove(id)
    if (get().activeSessionId === id) {
      // The open session was deleted: reopen the next most-recent, or — if none
      // remain — drop to a fresh landing page.
      const remaining = await window.myto.sessions.list(get().activeProjectId)
      if (remaining.length > 0) {
        await get().open(remaining[0].id)
      } else {
        await get().newDraft()
      }
    } else {
      await get().refresh()
    }
  },

  rewind: async (afterMsgId) => {
    const { activeSessionId } = get()
    if (!activeSessionId) return null
    // Stop any live run first — restoring files under a working run would race it.
    useChatStore.getState().cancelSession(activeSessionId)
    const result = await window.myto.sessions.rewind(activeSessionId, afterMsgId)
    // Reload from disk so the truncated transcript + restored file state render.
    await loadInto(activeSessionId, set, get)
    return result
  }
}))
