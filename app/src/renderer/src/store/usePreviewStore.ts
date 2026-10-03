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
  /**
   * Whether this preview is PINNED to the side slot (Feature 3, no-steal). A live
   * dev-server (`kind:'url'`) or a plan under review (`kind:'markdown'`) pins the
   * slot: while pinned, the chat stream's continuing command output and hot-reload
   * file writes update their panes QUIETLY (reveal:false) instead of yanking the
   * preview away. Cleared when the user closes the preview (an explicit "show me
   * something else"), so the slot is free again. A one-shot `kind:'file'` preview
   * never pins. See the no-steal wiring in useChatStore.onChunk + AppLayout.
   */
  pinned: boolean
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
   * A markdown target (a plan) always opens fresh — it has no URL to dedupe on — and
   * pins the slot; url targets pin too; a file target leaves the slot unpinned.
   */
  show: (target: PreviewTarget) => void
  /** Set the pin flag directly (mode/session change clears it; see useChatStore). */
  setPinned: (pinned: boolean) => void
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
  pinned: false,
  history: [],
  index: -1,
  reloadNonce: 0,

  show: (target) => {
    const { history, index } = get()
    const current = index >= 0 ? history[index] : null
    // A url (dev server) or markdown (plan) target pins the slot; a file preview doesn't.
    const pinned = target.kind === 'url' || target.kind === 'markdown'
    // Re-showing the same URL is a refresh, not a new step. Markdown has no URL, so it
    // never dedupes (two plans must each open fresh, not collapse on undefined===undefined).
    if (
      target.kind !== 'markdown' &&
      current &&
      'url' in current &&
      current.url === target.url
    ) {
      set((s) => ({ open: true, pinned, reloadNonce: s.reloadNonce + 1 }))
      return
    }
    // Browser semantics: drop any forward entries, then append and move the cursor.
    const trimmed = history.slice(0, index + 1)
    trimmed.push(target)
    set({ open: true, pinned, history: trimmed, index: trimmed.length - 1 })
  },

  setPinned: (pinned) => set({ pinned }),

  back: () => {
    const { index } = get()
    if (index > 0) set({ index: index - 1 })
  },

  forward: () => {
    const { index, history } = get()
    if (index < history.length - 1) set({ index: index + 1 })
  },

  reload: () => set((s) => ({ reloadNonce: s.reloadNonce + 1 })),

  // Reopening via the top-bar toggle re-pins a live dev-server/plan preview (so its
  // continuing output still can't steal the slot) but leaves a one-shot file unpinned.
  reveal: () =>
    set((s) => {
      const t = s.index >= 0 ? s.history[s.index] : null
      return { open: true, pinned: t?.kind === 'url' || t?.kind === 'markdown' }
    }),

  // Closing frees the slot: an explicit close is the user asking for something else,
  // so the pin is released and later command/file output can take the slot again.
  close: () => set({ open: false, pinned: false }),

  openExternal: () => {
    const target = currentTarget(get())
    // Only url/file targets have a URL to open; a markdown plan is in-memory, nothing
    // to hand to the OS browser.
    if (target && 'url' in target) window.myto.preview.openExternal(target.url)
  }
}))
