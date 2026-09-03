import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import type { ChatMessage, SessionSummary } from '@shared/types'
import { useChatStore } from './useChatStore'
import { useAppStore } from './useAppStore'

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
  const loaded = await window.sylor.sessions.load(id)
  if (!loaded) {
    // Deleted out from under us — fall back to a fresh landing page.
    await get().newDraft()
    return false
  }
  // Restore THIS conversation's own folder as the active workspace root before
  // the switch completes, so the next send (and the project scan) targets the
  // folder the chat was created in — not whichever folder the user last opened.
  // The IPC is non-dialog and non-persisting: the DEFAULT folder for brand-new
  // chats / next launch is deliberately left untouched (only an explicit folder
  // pick changes that). A deleted/moved folder is a no-op in the handler, so a
  // stale conversation still opens on the current root instead of crashing.
  const root = loaded.session.projectRoot
  if (root && root !== useAppStore.getState().workspaceRoot) {
    const info = await window.sylor.workspace.setRoot(root)
    useAppStore.getState().setWorkspace(info)
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
  navStack: [],
  navPos: -1,

  setActiveProject: async (projectId) => {
    set({ activeProjectId: projectId })
    await get().refresh()
  },

  boot: async () => {
    // Opening the app always lands on a fresh, unsaved chat — never the last
    // conversation restored — with the full history (global, not folder-scoped)
    // loaded in the rail. Clear any stale project filter so "All chats" is shown.
    set({ activeProjectId: null })
    await get().newDraft()
  },

  newDraft: async () => {
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
    const sessions = await window.sylor.sessions.list(get().activeProjectId)
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
    // New chats are filed under the project the rail is scoped to (or none).
    const summary = await window.sylor.sessions.create(get().activeProjectId)
    useChatStore.getState().resetTo(summary.id, summary.projectId)
    set({ activeSessionId: summary.id })
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
      // The open session was deleted: reopen the next most-recent, or — if none
      // remain — drop to a fresh landing page.
      const remaining = await window.sylor.sessions.list(get().activeProjectId)
      if (remaining.length > 0) {
        await get().open(remaining[0].id)
      } else {
        await get().newDraft()
      }
    } else {
      await get().refresh()
    }
  }
}))
