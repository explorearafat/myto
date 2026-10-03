/**
 * Choreography builder — the PURE half of "watch Myto edit". Given a resolved
 * {@link PhotoAdjust} (photo) or an edit plan + probe (video, Phase 3), it produces the
 * ordered {@link EditorStep}[] the renderer plays on an rAF clock: panel switches, cursor
 * glides, slider slides from a neutral baseline, curve draws, HSL turns. It is fully
 * DETERMINISTIC and references controls by SEMANTIC id only — the renderer owns the pixel
 * geometry (it looks up each control's live DOM rect to move the virtual cursor). No
 * Electron, no DOM, no FFmpeg here: this is the script, {@link photo-core} is the bake.
 */
import type {
  PhotoAdjust, EditorStep, EditorScript, HslBand,
  EditorClip, EditorTextClip, EditorAudioClip, EditorTimeline, EditorPanel
} from '../../shared/types'
import { HSL_BANDS } from './photo-core'
import type { EditPlan } from './ffmpeg-core'

/** Pacing constants (ms). Gentle enough to read, brisk enough not to drag. */
const CURSOR_MS = 360 // virtual cursor glide to a control
const SLIDER_MS = 560 // a slider sweeping from→to
const DRAW_MS = 700 // a tone curve being drawn
const HSL_MS = 420 // one HSL field turning
const GAP = 110 // breath between consecutive gestures
const TAIL_MS = 500 // hold after the last gesture before the render step

/**
 * The Basic-panel sliders, in the top-to-bottom order the Lightroom panel lists them — the
 * order Myto's cursor visits. Control ids match {@link PhotoAdjust} field names so the
 * renderer can register one ref per slider under the same key.
 */
export const BASIC_CONTROLS: readonly (keyof PhotoAdjust)[] = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temp', 'tint', 'vibrance', 'saturation', 'clarity', 'sharpen', 'vignette'
]

/**
 * Build the photo choreography: visit every non-neutral control in panel order (Basic →
 * Curve → HSL → Crop), gliding the cursor and sliding each value from its neutral baseline
 * to the target, then finish with a `render` step. `totalMs` is the whole animation length.
 */
export function photoScript(adjust: PhotoAdjust): EditorScript {
  const steps: EditorStep[] = []
  let t = 0
  let panel: 'basic' | 'curve' | 'hsl' | 'crop' | '' = ''

  /** Switch the active panel (emits a step only when it actually changes). */
  const switchPanel = (p: 'basic' | 'curve' | 'hsl' | 'crop'): void => {
    if (panel === p) return
    panel = p
    steps.push({ type: 'panel-switch', panel: p, atMs: t })
  }

  // ── Basic sliders ──
  for (const control of BASIC_CONTROLS) {
    const to = adjust[control]
    if (typeof to !== 'number' || to === 0) continue
    switchPanel('basic')
    steps.push({ type: 'cursor-move', control, atMs: t, durationMs: CURSOR_MS })
    t += CURSOR_MS
    steps.push({ type: 'set-slider', control, from: 0, to, atMs: t, durationMs: SLIDER_MS })
    t += SLIDER_MS + GAP
  }

  // ── Tone curve ──
  if (adjust.curve) {
    const channels: Array<'rgb' | 'r' | 'g' | 'b'> = ['rgb', 'r', 'g', 'b']
    for (const channel of channels) {
      const points = adjust.curve[channel]
      if (!points || points.length === 0) continue
      switchPanel('curve')
      steps.push({ type: 'cursor-move', control: `curve-${channel}`, atMs: t, durationMs: CURSOR_MS })
      t += CURSOR_MS
      steps.push({ type: 'draw-curve', channel, points, atMs: t, durationMs: DRAW_MS })
      t += DRAW_MS + GAP
    }
  }

  // ── HSL bands ──
  if (adjust.hsl) {
    const fields: Array<'hue' | 'sat' | 'lum'> = ['hue', 'sat', 'lum']
    for (const band of HSL_BANDS) {
      const b = adjust.hsl[band as HslBand]
      if (!b) continue
      let moved = false
      for (const field of fields) {
        const to = b[field]
        if (!to) continue
        switchPanel('hsl')
        if (!moved) {
          steps.push({ type: 'cursor-move', control: `hsl-${band}`, atMs: t, durationMs: CURSOR_MS })
          t += CURSOR_MS
          moved = true
        }
        steps.push({ type: 'set-hsl', band, field, from: 0, to, atMs: t, durationMs: HSL_MS })
        t += HSL_MS + GAP
      }
    }
  }

  // ── Crop / rotate ──
  if (adjust.crop || adjust.rotate) {
    switchPanel('crop')
    steps.push({ type: 'cursor-move', control: 'crop', atMs: t, durationMs: CURSOR_MS })
    t += CURSOR_MS
    if (adjust.rotate) {
      steps.push({ type: 'set-slider', control: 'rotate', from: 0, to: adjust.rotate, atMs: t, durationMs: SLIDER_MS })
      t += SLIDER_MS + GAP
    }
  }

  // ── Finish ──
  t += TAIL_MS
  steps.push({ type: 'render', atMs: t })

  return { kind: 'photo', steps, totalMs: t, target: adjust }
}

// ── Video (CapCut-style) choreography ─────────────────────────────────────────

const CLIP_MS = 420 // dropping a clip onto the timeline
const TEXT_MS = 460 // placing a styled caption
const PLAYHEAD_MIN_MS = 900 // shortest playhead sweep
const PLAYHEAD_MAX_MS = 2600 // longest playhead sweep

/** Round seconds to 2 decimals so the timeline + steps stay deterministic. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Map a drawtext x/y field (px or keyword) → a normalized 0..1 anchor for the preview. */
function normPos(v: number | string | undefined, axis: 'x' | 'y'): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? undefined : Math.max(0, Math.min(1, v))
  const kw = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (axis === 'x') {
    if (kw === 'left') return 0.1
    if (kw === 'right') return 0.9
    if (kw === 'center' || kw === 'middle') return 0.5
    return undefined
  }
  if (kw === 'top') return 0.12
  if (kw === 'center' || kw === 'middle') return 0.5
  if (kw === 'bottom') return 0.85
  return undefined
}

// VIDEO_SCRIPT_MARKER

/**
 * Build the video choreography from a validated {@link EditPlan} + the source probe
 * duration. It derives the CapCut timeline (video clips from keep-ranges, text clips from
 * `text` ops, one audio block), then an ordered step list: lay the clips down (with a
 * split/transition marker at each boundary), apply the colour grade, place captions, and
 * sweep the playhead end-to-end before the final `render`. Deterministic; references
 * controls by SEMANTIC id ('clip-0', 'grade', 'text-0', 'playhead') for the renderer.
 */
export function videoScript(plan: EditPlan, sourceDurationSec = 0): EditorScript {
  // ── Derive the timeline from the plan ──
  const seg = plan.operations.find((o) => o.op === 'segments' || o.op === 'trim')
  const ranges =
    seg?.op === 'segments'
      ? seg.keep
      : seg?.op === 'trim'
        ? [{ start: seg.start, end: seg.end }]
        : [{ start: 0, end: sourceDurationSec > 0 ? sourceDurationSec : 10 }]

  const sp = plan.operations.find((o) => o.op === 'speed')
  const speed = sp?.op === 'speed' ? sp.factor : 1
  const fl = plan.operations.find((o) => o.op === 'filter')
  const cg = plan.operations.find((o) => o.op === 'colorGrade')
  const grade = fl?.op === 'filter' ? fl.name : cg?.op === 'colorGrade' ? 'grade' : undefined
  const tr = plan.operations.find((o) => o.op === 'transition')
  const transition = tr?.op === 'transition' ? tr : null

  const videoClips: EditorClip[] = []
  let pos = 0
  ranges.forEach((r, i) => {
    const outDur = Math.max(0.1, (r.end - r.start) / speed)
    videoClips.push({
      id: `clip-${i}`,
      track: 'video',
      startSec: round2(pos),
      endSec: round2(pos + outDur),
      sourceStartSec: round2(r.start),
      sourceEndSec: round2(r.end),
      speed: speed !== 1 ? speed : undefined,
      grade,
      label: `Clip ${i + 1}`
    })
    pos += outDur
  })
  const outDurationSec = round2(pos)

  const textClips: EditorTextClip[] = []
  for (const o of plan.operations) {
    if (o.op !== 'text') continue
    const startSec = o.start ?? 0
    const endSec = o.end ?? Math.min(outDurationSec || startSec + 3, startSec + 3)
    textClips.push({
      id: `text-${textClips.length}`,
      track: 'text',
      startSec: round2(startSec),
      endSec: round2(Math.max(startSec + 0.3, endSec)),
      text: o.text,
      x: normPos(o.x, 'x'),
      y: normPos(o.y, 'y'),
      fontSize: o.fontSize,
      color: o.color,
      box: o.box
    })
  }

  const mute = plan.operations.some((o) => o.op === 'mute')
  const vol = plan.operations.find((o) => o.op === 'volume')
  const audioClips: EditorAudioClip[] =
    outDurationSec > 0
      ? [{
          id: 'audio-0',
          track: 'audio',
          startSec: 0,
          endSec: outDurationSec,
          label: mute ? 'Muted' : 'Original audio',
          volume: vol?.op === 'volume' ? Math.round(vol.factor * 100) : undefined,
          muted: mute || undefined
        }]
      : []

  const timeline: EditorTimeline = {
    durationSec: outDurationSec,
    tracks: [
      { kind: 'video', clips: videoClips },
      { kind: 'text', clips: textClips },
      { kind: 'audio', clips: audioClips }
    ]
  }

  // ── Choreograph the steps over the animation clock ──
  const steps: EditorStep[] = []
  let t = 0
  let panel: EditorPanel | '' = ''
  const switchPanel = (p: EditorPanel): void => {
    if (panel === p) return
    panel = p
    steps.push({ type: 'panel-switch', panel: p, atMs: t })
  }

  // Lay each kept clip onto the timeline; mark each boundary as a transition or a cut.
  switchPanel('timeline')
  videoClips.forEach((clip, i) => {
    steps.push({ type: 'cursor-move', control: `clip-${i}`, atMs: t, durationMs: CURSOR_MS })
    t += CURSOR_MS
    steps.push({ type: 'add-clip', clip, atMs: t })
    t += CLIP_MS + GAP
    if (i < videoClips.length - 1) {
      if (transition) steps.push({ type: 'transition', name: transition.name, atSec: clip.endSec, atMs: t })
      else steps.push({ type: 'split', track: 'video', atSec: clip.endSec, atMs: t })
      t += GAP
    }
  })

  // Colour grade (one gesture on the effects panel).
  if (grade) {
    switchPanel('effects')
    steps.push({ type: 'cursor-move', control: 'grade', atMs: t, durationMs: CURSOR_MS })
    t += CURSOR_MS
    steps.push({ type: 'set-slider', control: 'grade', from: 0, to: 100, atMs: t, durationMs: SLIDER_MS })
    t += SLIDER_MS + GAP
  }

  // Place captions on the text track.
  if (textClips.length) {
    switchPanel('text')
    textClips.forEach((clip, i) => {
      steps.push({ type: 'cursor-move', control: `text-${i}`, atMs: t, durationMs: CURSOR_MS })
      t += CURSOR_MS
      steps.push({ type: 'add-text', clip, atMs: t })
      t += TEXT_MS + GAP
    })
  }

  // Sweep the playhead across the whole timeline so the user watches it play through.
  switchPanel('timeline')
  steps.push({ type: 'cursor-move', control: 'playhead', atMs: t, durationMs: CURSOR_MS })
  t += CURSOR_MS
  const sweepMs = Math.min(PLAYHEAD_MAX_MS, Math.max(PLAYHEAD_MIN_MS, outDurationSec * 120))
  steps.push({ type: 'playhead', from: 0, to: outDurationSec, atMs: t, durationMs: sweepMs })
  t += sweepMs + GAP

  t += TAIL_MS
  steps.push({ type: 'render', atMs: t })

  return { kind: 'video', steps, timeline, totalMs: t }
}
