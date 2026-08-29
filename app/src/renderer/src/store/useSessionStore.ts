import { create } from 'zustand'
import type { ChatMessage, SessionSummary } from '@shared/types'
import { useChatStore } from './useChatStore'

/** The placeholder title new sessions are created with (see main/session-ipc.ts). */
const DEFAULT_SESSION_TITLE = 'New session'

/** Longest title, in characters, before it's clipped with an ellipsis. */
const MAX_TITLE_LEN = 48

/** Most of the first prompt we feed the titler — a title needs the gist, not an essay. */
const TITLE_INPUT_CAP = 2000

/**
 * Instructions for the one-shot title model. Deliberately strict: models love to
 * answer with "Sure! Here's a title:" or wrap the thing in quotes, and any of
 * that leaking into the sidebar looks broken. {@link cleanModelTitle} is the
 * safety net that catches what the prompt doesn't.
 */
const TITLE_SYSTEM =
  "You generate a short title for a conversation from the user's first message. " +
  'Reply with ONLY the title: 3–6 words, Title Case, no surrounding quotes, no ' +
  'trailing punctuation, no preamble or explanation.'

/**
 * Collapse whitespace and clip to {@link MAX_TITLE_LEN} at a word boundary,
 * suffixing an ellipsis when it overflows. Shared by the heuristic and the
 * AI-title cleaner so both titles are bounded identically.
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
 * first non-empty line, whitespace-collapsed and clipped. This is the instant,
 * always-available title; {@link cleanModelTitle} refines it when the model is
 * reachable. Returns '' when the prompt has no usable text (e.g. an
 * attachment-only turn), so the caller can skip renaming.
 */
export function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  return clip(firstLine)
}

/**
 * Turn a raw model reply into a usable title, or '' when it's unusable. Keeps
 * only the first non-empty line, strips a leading "Title:"/"Session:" label and
 * surrounding quotes (straight or curly), and clips to length. Returning ''
 * means "keep the heuristic" — so a refusal, an empty reply, or a chatty
 * preamble never makes the title worse.
 */
export function cleanModelTitle(raw: string): string {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  const stripped = firstLine
    .replace(/^(?:title|session|conversation)\s*[:\-–—]\s*/i, '')
    .replace(/^["'“”‘’`]+/, '')
    .replace(/["'“”‘’`.!?:,;\s]+$/, '')
    .trim()
  if (!stripped) return ''
  return clip(stripped)
}

/**
 * Ask the active provider for a concise title summarizing the first prompt.
 * Returns '' on any failure — offline, provider error, empty/garbage reply — so
 * the caller safely falls back to the heuristic title. Never throws.
 */
async function suggestAiTitle(prompt: string): Promise<string> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: TITLE_SYSTEM },
      { role: 'user', content: prompt.slice(0, TITLE_INPUT_CAP) }
    ]
    const res = await window.sylor.providers.getCompletion({ messages })
    if (!res.ok || !res.content) return ''
    return cleanModelTitle(res.content)
  } catch {
    return ''
  }
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
   * Desktop. Sets a heuristic title instantly (first line, clipped), then refines
   * it with a one-shot AI summary of the prompt when the provider is reachable —
   * offline or on any error the heuristic simply stands. Only touches a session
   * still on its default ('New session') title, and the AI pass backs off if the
   * user renamed meanwhile, so a manual rename is never clobbered. No-op when the
   * derived title is empty (attachment-only turn) or no session is active.
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
    // Opening the app — or switching to a newly-opened folder — starts from that
    // root's own history. Clear any stale project filter so the recents list
    // reflects the current folder (a no-op on first launch, already null).
    set({ activeProjectId: null })
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
    const heuristic = deriveTitle(prompt)
    if (!heuristic) return
    const { activeSessionId, sessions } = get()
    if (!activeSessionId) return
    const active = sessions.find((s) => s.id === activeSessionId)
    // Only title a fresh, still-default session; never overwrite a real title.
    if (!active || active.title !== DEFAULT_SESSION_TITLE) return

    // Set the heuristic title at once, so the sidebar never lingers on 'New
    // session' while the model thinks — and so an offline run still gets a title.
    await get().rename(activeSessionId, heuristic)

    // Then refine it with an AI summary in the background. Offline/error-safe: a
    // failure returns '' and the heuristic stands. Never clobber a rename the
    // user made in the meantime — the title must still be exactly the heuristic
    // we just set (a manual rename changes it, so we back off).
    const aiTitle = await suggestAiTitle(prompt)
    if (!aiTitle || aiTitle === heuristic) return
    const current = get().sessions.find((s) => s.id === activeSessionId)
    if (!current || current.title !== heuristic) return
    await get().rename(activeSessionId, aiTitle)
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
