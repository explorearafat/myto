import { create } from 'zustand'
import type { FileChange } from '@shared/types'

/**
 * Myto's Working-tree pane state (Build mode). As Myto writes, edits, and deletes
 * files while it builds, each mutation streams in as a {@link FileChange} and lands
 * here; the pane renders them as a live directory tree (see `lib/file-tree.ts`) with
 * `+added −removed` counts, and clicking a file fetches its before/after text on
 * demand to show a diff.
 *
 * Like {@link usePreviewStore} and {@link useTerminalStore} it's a global,
 * session-independent surface — it stays where it is when you switch chats — and it
 * stays empty/hidden outside a Build run, since only the Cowork mutation tools feed
 * it. It imports nothing from the other side-pane stores: the right-hand slot is
 * mutually exclusive, but that coordination lives at the call sites (the chat-stream
 * chunk handler and the top-bar toggles), not inside any store.
 */

/** Keep the change list bounded — a big build can touch many files. */
const MAX_ENTRIES = 500

export interface FilesState {
  /** Whether the pane is on screen. */
  open: boolean
  /** Every file touched this build, in first-touched order (upserted by path). */
  changes: FileChange[]
  /** The file whose diff is shown, or null for none selected. */
  selectedPath: string | null

  /**
   * Record a file mutation, upserting by path so a file touched twice shows once with
   * its latest kind/counts. `reveal` (default true) pops the pane open — the chat
   * stream passes `reveal: false` while a dev-server preview is pinned, so hot-reload
   * writes update the tree quietly without yanking the preview. The first change seeds
   * the selection so a diff shows without a click; an existing selection is kept.
   */
  append: (change: FileChange, opts?: { reveal?: boolean }) => void
  /** Select a file to diff (or null to clear). */
  select: (path: string | null) => void
  /** Clear the tree (keeps the pane open). */
  clear: () => void
  /** Show the pane without adding to it (the top-bar toggle). */
  show: () => void
  /** Hide the pane (keeps the tree, so reopening resumes it). */
  close: () => void
}

export const useFilesStore = create<FilesState>((set) => ({
  open: false,
  changes: [],
  selectedPath: null,

  append: (change, opts) =>
    set((s) => {
      const at = s.changes.findIndex((c) => c.path === change.path)
      const next = s.changes.slice()
      // Move an upserted file to the end so the list tail is the most-recently-touched
      // file (the pane highlights it). The tree view sorts its own rows, so reordering
      // the flat list never disturbs the on-screen order.
      if (at >= 0) next.splice(at, 1)
      next.push(change)
      // Drop the oldest once past the cap so memory stays bounded.
      if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES)
      // reveal:false keeps the pane's current open state (quiet background update).
      const open = opts?.reveal === false ? s.open : true
      return { open, changes: next, selectedPath: s.selectedPath ?? change.path }
    }),

  select: (path) => set({ selectedPath: path }),

  clear: () => set({ changes: [], selectedPath: null }),

  show: () => set({ open: true }),

  close: () => set({ open: false })
}))
