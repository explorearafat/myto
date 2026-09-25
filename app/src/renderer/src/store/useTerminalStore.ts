import { create } from 'zustand'
import type { CommandRun } from '@shared/types'

/**
 * Myto's Terminal pane state (Cowork). The pane is a read-only transcript of the
 * shell commands Myto runs while it works — every `run_command` (build, test,
 * install, typecheck) streams a {@link CommandRun} in, which appends to the log and
 * pops the pane up so the user can watch real output scroll by.
 *
 * Like {@link usePreviewStore} it's a global, session-independent surface — it stays
 * where it is when you switch chats — and it stays empty/hidden in ordinary chat,
 * since only the Cowork `run_command` tool ever feeds it. It deliberately imports
 * nothing from the preview store: the two right-hand panes are mutually exclusive,
 * but that coordination lives at the call sites (the chat-stream chunk handler and
 * the top-bar toggles) so neither store depends on the other.
 */

/** Keep the transcript bounded — a long Cowork session can run many commands. */
const MAX_ENTRIES = 200

/**
 * Which face of the Terminal pane is showing:
 * - `agent` — the read-only transcript of commands Myto ran (the classic pane).
 * - `shell` — the interactive PTY the user drives themselves (#2), gated on consent.
 */
export type TerminalTab = 'agent' | 'shell'

export interface TerminalState {
  /** Whether the pane is on screen. */
  open: boolean
  /** The command transcript, oldest first. */
  entries: CommandRun[]
  /** The working folder of the most recent run that carried one — shown in the header. */
  cwd: string | null
  /** Which tab is active — the agent transcript or the interactive shell. */
  tab: TerminalTab
  /**
   * Record a command Myto ran (and reveal the pane), trimming to the cap. When the
   * run carries an `id` that matches an existing entry, it REPLACES that entry in
   * place — so a long-lived process (a dev server) can stream successive output
   * snapshots under one id without piling up rows. A run with no id (or a new id) is
   * appended, which keeps one-shot commands and older call sites behaving as before.
   *
   * Appends always snap the pane back to the `agent` tab: new agent output is the
   * reason the pane popped up, so the user should land on it, not on a stale shell.
   */
  append: (run: CommandRun) => void
  /** Clear the transcript (keeps the pane open). */
  clear: () => void
  /** Show the pane without adding to it (the top-bar toggle). */
  show: () => void
  /** Hide the pane (keeps the transcript, so reopening resumes it). */
  close: () => void
  /** Switch the active tab (agent transcript ↔ interactive shell). */
  setTab: (tab: TerminalTab) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  open: false,
  entries: [],
  cwd: null,
  tab: 'agent',

  append: (run) =>
    set((s) => {
      // Upsert by id: an in-place replace when this id is already on screen (a
      // streaming dev server), else a plain append. No id always appends.
      const at = run.id ? s.entries.findIndex((e) => e.id === run.id) : -1
      let next: CommandRun[]
      if (at >= 0) {
        next = s.entries.slice()
        next[at] = run
      } else {
        next = [...s.entries, run]
        // Drop the oldest once past the cap so memory stays bounded.
        if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES)
      }
      return { open: true, tab: 'agent', entries: next, cwd: run.cwd ?? s.cwd }
    }),

  clear: () => set({ entries: [], cwd: null }),

  show: () => set({ open: true }),

  close: () => set({ open: false }),

  setTab: (tab) => set({ tab })
}))
