import { create } from 'zustand'
import type {
  EditorEvent,
  EditorScript,
  PhotoAdjust,
  HslBand,
  HslAdjust,
  CropRect,
  CurvePoint,
  EditorPanel,
  StudioOpenResult,
  StudioAspect
} from '@shared/types'
import { PHOTO_NEUTRAL_ADJUST } from '../lib/editor-preview'

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

// ── Manual Studio (user-driven) ────────────────────────────────────────────────
//
// The same Lightroom/CapCut surfaces, but the USER edits by hand. A manual session lives
// alongside the agent-playback fields; {@link EditorState.mode} says which is active. Photo
// edits accumulate into a {@link PhotoAdjust}; video edits into a {@link ManualVideoEdit} the
// pane compiles to a StudioVideoPlan at bake time. The canvas renders the live result (真 pixels
// for photo via lib/photo-render), and "Export" bakes the authoritative file over `window.myto.editor`.

/** A caption the user has placed on the manual video timeline. */
export interface ManualTextClip {
  id: string
  text: string
  startSec: number
  endSec: number
  /** Vertical anchor keyword the drawtext bake understands. */
  y: 'top' | 'center' | 'bottom'
  box: boolean
  color: string
}

/** The structured manual video edit the pane compiles into a StudioVideoPlan. */
export interface ManualVideoEdit {
  /** Kept source range in seconds, or null for the whole clip. */
  trim: { start: number; end: number } | null
  speed: number
  /** A named look from the ffmpeg FILTER_PRESETS ('none' = untouched). */
  filter: string
  aspect: StudioAspect | null
  mute: boolean
  /** 0..200 (%). */
  volume: number
  texts: ManualTextClip[]
}

export function neutralVideoEdit(durationSec: number): ManualVideoEdit {
  return { trim: { start: 0, end: Math.max(0.1, durationSec) }, speed: 1, filter: 'none', aspect: null, mute: false, volume: 100, texts: [] }
}

/** One live manual editing session (photo or video). */
export interface ManualSession {
  kind: 'photo' | 'video'
  /** Workspace-relative source path. */
  path: string
  /** The downscaled source still (photo) / current poster (video) for the canvas base image. */
  sourcePreview: string
  width?: number
  height?: number
  durationSec?: number
  /** Which editor panel/tab is open. */
  panel: EditorPanel
  /** Photo: the accumulated adjust. (Neutral for a video session.) */
  adjust: PhotoAdjust
  /** Video: the accumulated edit. (null for a photo session.) */
  video: ManualVideoEdit | null
  /** Video: playhead position in source seconds, for the monitor + caption placement. */
  playheadSec: number
  /** Undo/redo stacks of prior adjusts (photo) — most recent last. */
  past: PhotoAdjust[]
  future: PhotoAdjust[]
  /** True once any control has moved from the opened baseline. */
  dirty: boolean
  /** Bake progress (0–100 + label) while Export runs, or null. */
  progress: { pct: number; label: string } | null
  /** The authoritative baked result once Export finishes, or null. */
  baked: EditorBaked | null
  /** Before/after compare selection once baked. */
  compare: EditorCompare
  error: string | null
  /** The free-text goal for the self-correct ("auto") loop. */
  goal: string
  /** Myto's latest critique note (the "instant guide"), shown under the canvas. */
  autoNote: string | null
  /** True while the self-correct loop is running. */
  autoRunning: boolean
}

/** Cap the photo undo history so a long session can't grow without bound. */
const UNDO_CAP = 60

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

  /** Which surface is active: the agent's playback, or the user's manual session. */
  mode: 'agent' | 'manual'
  /** The live manual editing session (null unless {@link mode} is 'manual'). */
  manual: ManualSession | null
  /** Whether the Studio launcher (file picker modal) is open. */
  launcherOpen: boolean

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

  // ── Manual Studio actions ──
  /** Open/close the Studio launcher (the pick-a-file modal). */
  openLauncher: () => void
  closeLauncher: () => void
  /** Begin a manual photo/video session on an opened source (pins + takes the slot). */
  startManual: (kind: 'photo' | 'video', path: string, open: StudioOpenResult) => void
  /** Switch the active manual panel/tab. */
  setManualPanel: (panel: EditorPanel) => void
  /** Merge a patch into the photo adjust (records undo). */
  patchAdjust: (patch: Partial<PhotoAdjust>) => void
  /** Set one HSL band field (records undo). */
  patchHsl: (band: HslBand, field: keyof HslAdjust, value: number) => void
  /** Replace a tone-curve channel's points (records undo). */
  setCurve: (channel: 'rgb' | 'r' | 'g' | 'b', points: CurvePoint[]) => void
  /** Set the crop rectangle (or clear it). */
  setCrop: (crop: CropRect | null) => void
  /** Set rotation in degrees. */
  setRotate: (deg: number) => void
  /** Reset the whole photo adjust to neutral (records undo). */
  resetAdjust: () => void
  /** Undo / redo the last photo adjust change. */
  undo: () => void
  redo: () => void
  /** Merge a patch into the manual video edit. */
  patchVideo: (patch: Partial<ManualVideoEdit>) => void
  /** Add / remove a caption on the manual video timeline. */
  addText: (clip: ManualTextClip) => void
  removeText: (id: string) => void
  /** Move the manual video playhead (source seconds). */
  setPlayhead: (sec: number) => void
  /** Bake progress + result lifecycle for a manual Export. */
  setManualProgress: (progress: { pct: number; label: string } | null) => void
  setManualBaked: (baked: EditorBaked | null) => void
  setManualError: (error: string | null) => void
  selectManual: (compare: EditorCompare) => void
  /** The self-correct ("auto") loop surface. */
  setGoal: (goal: string) => void
  setAutoNote: (note: string | null) => void
  setAutoRunning: (running: boolean) => void
  /** Close the manual session and return the pane to its idle agent state. */
  closeManual: () => void
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
  mode: 'agent',
  manual: null,
  launcherOpen: false,

  apply: (event) => {
    switch (event.phase) {
      case 'open':
        // A fresh agent edit begins: open the pane, pin the slot, drop any manual session,
        // and clear any prior run.
        set({
          open: true,
          pinned: true,
          mode: 'agent',
          manual: null,
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
  close: () => set({ open: false, pinned: false }),

  // ── Manual Studio ──

  openLauncher: () => set({ launcherOpen: true }),
  closeLauncher: () => set({ launcherOpen: false }),

  startManual: (kind, path, open) =>
    set({
      open: true,
      pinned: true,
      mode: 'manual',
      launcherOpen: false,
      kind,
      title: path.split('/').pop() || path,
      // Clear any agent-playback residue so the two surfaces never bleed into each other.
      source: null,
      script: null,
      live: null,
      progress: null,
      baked: null,
      error: null,
      compare: 'after',
      manual: {
        kind,
        path,
        sourcePreview: open.preview,
        width: open.width,
        height: open.height,
        durationSec: open.durationSec,
        panel: kind === 'photo' ? 'basic' : 'timeline',
        adjust: { ...PHOTO_NEUTRAL_ADJUST },
        video: kind === 'video' ? neutralVideoEdit(open.durationSec ?? 0) : null,
        playheadSec: 0,
        past: [],
        future: [],
        dirty: false,
        progress: null,
        baked: null,
        compare: 'after',
        error: null,
        goal: '',
        autoNote: null,
        autoRunning: false
      }
    }),

  setManualPanel: (panel) =>
    set((s) => (s.manual ? { manual: { ...s.manual, panel } } : {})),

  patchAdjust: (patch) =>
    set((s) => {
      if (!s.manual) return {}
      const past = [...s.manual.past, s.manual.adjust].slice(-UNDO_CAP)
      return {
        manual: { ...s.manual, adjust: { ...s.manual.adjust, ...patch }, past, future: [], dirty: true }
      }
    }),

  patchHsl: (band, field, value) =>
    set((s) => {
      if (!s.manual) return {}
      const past = [...s.manual.past, s.manual.adjust].slice(-UNDO_CAP)
      const hsl = { ...(s.manual.adjust.hsl ?? {}) }
      const prev: HslAdjust = hsl[band] ?? { hue: 0, sat: 0, lum: 0 }
      hsl[band] = { ...prev, [field]: value }
      return { manual: { ...s.manual, adjust: { ...s.manual.adjust, hsl }, past, future: [], dirty: true } }
    }),

  setCurve: (channel, points) =>
    set((s) => {
      if (!s.manual) return {}
      const past = [...s.manual.past, s.manual.adjust].slice(-UNDO_CAP)
      const curve = { ...(s.manual.adjust.curve ?? {}), [channel]: points }
      return { manual: { ...s.manual, adjust: { ...s.manual.adjust, curve }, past, future: [], dirty: true } }
    }),

  setCrop: (crop) =>
    set((s) => {
      if (!s.manual) return {}
      const adjust = { ...s.manual.adjust }
      if (crop) adjust.crop = crop
      else delete adjust.crop
      return { manual: { ...s.manual, adjust, dirty: true } }
    }),

  setRotate: (deg) =>
    set((s) => {
      if (!s.manual) return {}
      const d = ((Math.round(deg) % 360) + 360) % 360
      const adjust = { ...s.manual.adjust }
      if (d) adjust.rotate = d
      else delete adjust.rotate
      return { manual: { ...s.manual, adjust, dirty: true } }
    }),

  resetAdjust: () =>
    set((s) => {
      if (!s.manual) return {}
      const past = [...s.manual.past, s.manual.adjust].slice(-UNDO_CAP)
      return { manual: { ...s.manual, adjust: { ...PHOTO_NEUTRAL_ADJUST }, past, future: [], dirty: true } }
    }),

  undo: () =>
    set((s) => {
      if (!s.manual || s.manual.past.length === 0) return {}
      const past = [...s.manual.past]
      const prev = past.pop() as PhotoAdjust
      const future = [s.manual.adjust, ...s.manual.future].slice(0, UNDO_CAP)
      return { manual: { ...s.manual, adjust: prev, past, future, dirty: true } }
    }),

  redo: () =>
    set((s) => {
      if (!s.manual || s.manual.future.length === 0) return {}
      const future = [...s.manual.future]
      const next = future.shift() as PhotoAdjust
      const past = [...s.manual.past, s.manual.adjust].slice(-UNDO_CAP)
      return { manual: { ...s.manual, adjust: next, past, future, dirty: true } }
    }),

  patchVideo: (patch) =>
    set((s) => (s.manual && s.manual.video ? { manual: { ...s.manual, video: { ...s.manual.video, ...patch }, dirty: true } } : {})),

  addText: (clip) =>
    set((s) =>
      s.manual && s.manual.video
        ? { manual: { ...s.manual, video: { ...s.manual.video, texts: [...s.manual.video.texts, clip] }, dirty: true } }
        : {}
    ),

  removeText: (id) =>
    set((s) =>
      s.manual && s.manual.video
        ? { manual: { ...s.manual, video: { ...s.manual.video, texts: s.manual.video.texts.filter((t) => t.id !== id) }, dirty: true } }
        : {}
    ),

  setPlayhead: (sec) =>
    set((s) => (s.manual ? { manual: { ...s.manual, playheadSec: Math.max(0, sec) } } : {})),

  setManualProgress: (progress) =>
    set((s) => (s.manual ? { manual: { ...s.manual, progress } } : {})),

  setManualBaked: (baked) =>
    set((s) => (s.manual ? { manual: { ...s.manual, baked, progress: null, pinned: false, compare: 'after' }, pinned: false } : {})),

  setManualError: (error) =>
    set((s) => (s.manual ? { manual: { ...s.manual, error, progress: null }, pinned: false } : {})),

  selectManual: (compare) =>
    set((s) => (s.manual ? { manual: { ...s.manual, compare } } : {})),

  setGoal: (goal) => set((s) => (s.manual ? { manual: { ...s.manual, goal } } : {})),
  setAutoNote: (autoNote) => set((s) => (s.manual ? { manual: { ...s.manual, autoNote } } : {})),
  setAutoRunning: (autoRunning) => set((s) => (s.manual ? { manual: { ...s.manual, autoRunning } } : {})),

  closeManual: () => set({ open: false, pinned: false, mode: 'agent', manual: null })
}))
