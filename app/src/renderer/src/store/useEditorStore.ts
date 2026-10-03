import { create } from 'zustand'
import type { EditorEvent, EditorScript, PhotoAdjust } from '@shared/types'

/**
 * Myto's "watch me edit" pane (Build mode). When Myto runs `edit_photo` / `edit_video`
 * it streams an ordered sequence of {@link EditorEvent}s down the chat channel; this
 * store collects them so the Editor pane can play the edit back for the user:
 *
 *   1. `open`     — the pane appears with a downscaled source preview (Lightroom-style
 *                   for a photo, CapCut-style for a video) and basic dimensions.
 *   2. `script`   — the full choreography (cursor moves, slider sweeps, curve draws,
 *                   HSL turns, playhead sweeps, clip/text/transition adds). The player
 *                   hook ({@link useEditorPlayer}, Phase 2) animates this with rAF and
 *                   publishes the live approximation back via {@link setLive}.
 *   3. `progress` — the real FFmpeg bake is running; drives the render bar.
 *   4. `baked`    — the authoritative result (a real re-encoded image/video). The pane
 *                   flips to a before/after compare; video playback is handed to the
 *                   Preview pane (webview `file://`) because the main page's CSP blocks
 *                   inline `<video data:>`.
 *   5. `error`    — the edit failed; show the message, free the slot.
 *
 * Like {@link usePreviewStore} it's a global, session-independent surface and carries a
 * {@link pinned} flag for the no-steal side slot: while Myto is playing the script or
 * baking, continuing command/file-change chunks update their own panes QUIETLY instead
 * of yanking the editor away. The pin clears on `baked`/`error`/close.
 */
export interface EditorSource {
  /** A `data:image/...;base64,...` URL — a downscaled source frame for `<img src>`. */
  preview: string
  width?: number
  height?: number
  /** Video only: source duration, for the timeline scale. */
  durationSec?: number
}

export interface EditorBaked {
  kind: 'photo' | 'video'
  /** `data:image/...` result (photo) or result poster frame (video). */
  resultPreview: string
  /** Workspace-relative path of the baked file under `myto-edits/`. */
  outputPath?: string
  /** `file://` URL for the Preview pane to play a baked video. */
  url?: string
}

/** Which image the before/after compare is currently showing. */
export type EditorCompare = 'before' | 'after'

export interface EditorState {
  /** Whether the pane is on screen. */
  open: boolean
  /** Pinned to the side slot (no-steal) while playing/baking. See store docblock. */
  pinned: boolean
  /** `photo` | `video` once an edit has opened, else null. */
  kind: 'photo' | 'video' | null
  /** The source file's display name (shown in the pane header). */
  title: string
  /** The downscaled source preview + dimensions (from the `open` phase). */
  source: EditorSource | null
  /** The full edit choreography (from the `script` phase); null until it arrives. */
  script: EditorScript | null
  /**
   * The live-approximation adjust the player is currently showing, published by
   * {@link useEditorPlayer} each frame so the Lightroom panel, histogram and canvas all
   * read one source of truth. Null before the script starts (photo only).
   */
  live: PhotoAdjust | null
  /** Bake progress (0–100 + a label), or null when not baking. */
  progress: { pct: number; label: string } | null
  /** The authoritative baked result (from the `baked` phase); null until it arrives. */
  baked: EditorBaked | null
  /** A failure message (from the `error` phase), or null. */
  error: string | null
  /** Before/after compare selection (defaults to the edited result). */
  compare: EditorCompare

  /** Route one streamed {@link EditorEvent} into state (called from useChatStore). */
  apply: (event: EditorEvent) => void
  /** Publish the player's current live approximation (photo). */
  setLive: (adjust: PhotoAdjust | null) => void
  /** Reopen the pane without changing content (the top-bar Editor toggle). */
  show: () => void
  /** Set the pin flag directly (mode/session change clears it; see useChatStore). */
  setPinned: (pinned: boolean) => void
  /** Flip the before/after compare. */
  select: (compare: EditorCompare) => void
  /** Hide the pane and free the slot. */
  close: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  open: false,
  pinned: false,
  kind: null,
  title: '',
  source: null,
  script: null,
  live: null,
  progress: null,
  baked: null,
  error: null,
  compare: 'after',

  apply: (event) => {
    switch (event.phase) {
      case 'open':
        // A fresh edit begins: open the pane, pin the slot, and clear any prior run.
        set({
          open: true,
          pinned: true,
          kind: event.kind,
          title: event.title,
          source: {
            preview: event.sourcePreview,
            width: event.width,
            height: event.height,
            durationSec: event.durationSec
          },
          script: null,
          live: null,
          progress: null,
          baked: null,
          error: null,
          compare: 'after'
        })
        break
      case 'script':
        set({ script: event.script })
        break
      case 'progress':
        set({ progress: { pct: event.pct, label: event.label } })
        break
      case 'baked':
        // The real result landed: show it, stop the bar, and free the slot so the user
        // can navigate away. Compare opens on the edited ("after") image.
        set({
          baked: {
            kind: event.kind,
            resultPreview: event.resultPreview,
            outputPath: event.outputPath,
            url: event.url
          },
          progress: null,
          pinned: false,
          compare: 'after'
        })
        break
      case 'error':
        set({ error: event.message, progress: null, pinned: false })
        break
    }
  },

  setLive: (live) => set({ live }),
  show: () => set({ open: true }),
  setPinned: (pinned) => set({ pinned }),
  select: (compare) => set({ compare }),
  close: () => set({ open: false, pinned: false })
}))
