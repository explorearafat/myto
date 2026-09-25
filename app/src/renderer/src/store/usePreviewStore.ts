import { create } from 'zustand'
import type { PreviewTarget } from '@shared/types'

/**
 * Myto's preview pane state (Cowork). The pane is Myto's own little browser: the
 * `preview` tool streams a {@link PreviewTarget} in, which opens the pane and points
 * it at the target; the user can then navigate back/forward through what Myto has
 * shown, reload, pop it out to their real browser, or close it.
 *
 * It's deliberately a global, session-independent surface — like a browser window
 * that stays where it is when you switch tabs — so switching chats never tears down
 * a preview Myto put up. Only the `preview` tool (Cowork-only) ever opens it, so it
 * simply stays hidden in ordinary chat.
 *
 * Navigation is modelled as a linear history with a cursor, exactly like a browser:
 * showing a new target truncates any forward entries and appends. The pane component
 * keys its <webview> on the current target's URL + {@link reloadNonce}, so every
 * navigation and every reload remounts the guest with a fresh `src` rather than
 * calling an imperative `reload()`/`goBack()` on it — imperative webview control from
 * a React effect is what crashed the panel before (see the webview-domready memory).
 */
export interface PreviewState {
  /** Whether the pane is on screen. */
  open: boolean
  /** Everything Myto has shown, oldest first (the back/forward stack). */
  history: PreviewTarget[]
  /** Cursor into {@link history}: which target is currently displayed (-1 = none). */
  index: number
  /** Bumped to force the current target's webview to remount (a manual reload). */
  reloadNonce: number

  /**
   * Show a target (from the `preview` tool): open the pane and navigate to it. If it
   * is the same URL already showing, this is treated as a reload instead of a new
   * history entry, so re-previewing a file Myto just rewrote refreshes in place.
   */
  show: (target: PreviewTarget) => void
  /** Step back through history (no-op at the start). */
  back: () => void
  /** Step forward through history (no-op at the end). */
  forward: () => void
  /** Reload the current target (remounts the webview). */
  reload: () => void
  /**
   * Show the pane without navigating — used by the top-bar Preview toggle to reopen
   * whatever Myto last showed (or the empty state if it has shown nothing yet).
   */
  reveal: () => void
  /** Hide the pane (keeps history, so a later `show` or reopen resumes it). */
  close: () => void
  /** Open the current target in the user's external browser. */
  openExternal: () => void
}

/** The target currently displayed, or null when the pane has nothing to show. */
export function currentTarget(state: PreviewState): PreviewTarget | null {
  return state.index >= 0 && state.index < state.history.length ? state.history[state.index] : null
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  open: false,
  history: [],
  index: -1,
  reloadNonce: 0,

  show: (target) => {
    const { history, index } = get()
    const current = index >= 0 ? history[index] : null
    // Re-showing the same URL is a refresh, not a new step.
    if (current && current.url === target.url) {
      set((s) => ({ open: true, reloadNonce: s.reloadNonce + 1 }))
      return
    }
    // Browser semantics: drop any forward entries, then append and move the cursor.
    const trimmed = history.slice(0, index + 1)
    trimmed.push(target)
    set({ open: true, history: trimmed, index: trimmed.length - 1 })
  },

  back: () => {
    const { index } = get()
    if (index > 0) set({ index: index - 1 })
  },

  forward: () => {
    const { index, history } = get()
    if (index < history.length - 1) set({ index: index + 1 })
  },

  reload: () => set((s) => ({ reloadNonce: s.reloadNonce + 1 })),

  reveal: () => set({ open: true }),

  close: () => set({ open: false }),

  openExternal: () => {
    const target = currentTarget(get())
    if (target) window.myto.preview.openExternal(target.url)
  }
}))
