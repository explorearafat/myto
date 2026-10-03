import type {
  PhotoAdjust, CurvePoint, EditorScript, EditorPanel, HslBand, HslAdjust,
  EditorClip, EditorTextClip, EditorAudioClip
} from '@shared/types'

/**
 * The live-preview approximation — the PURE, renderer-side math for the "watch Myto edit"
 * canvas. It turns a {@link PhotoAdjust} into a cheap GPU-friendly look the center `<img>`
 * shows while Myto drives the sliders: a CSS `filter` string (brightness/contrast/saturate/
 * hue/sepia), a vignette overlay opacity, and a tone-curve LUT for the optional 2D-canvas
 * path. This is deliberately an APPROXIMATION — the FFmpeg bake in photo-core.ts is the
 * authoritative result; here we only need the preview to MOVE convincingly as values change.
 * No React, no DOM — just numbers in, numbers/strings out, so it unit-tests cleanly.
 */

/** Round to 4 dp — keeps the generated filter strings short and the tests legible. */
function r4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Build the CSS `filter` value approximating an adjust for the live `<img>`. Maps the tonal
 * + colour sliders onto the handful of filter primitives browsers accelerate. Vignette is
 * NOT here (it rides a separate overlay — see {@link vignetteOpacity}); crop/rotate are
 * geometry the component applies with transforms. Returns 'none' for a neutral adjust.
 */
export function cssFilterFor(adjust: PhotoAdjust): string {
  const parts: string[] = []

  // Exposure + the tonal sliders fold into one brightness multiplier (gentle, ±~0.4).
  const bright = 1 + (adjust.exposure * 0.4 + adjust.shadows * 0.15 + adjust.blacks * 0.1 + adjust.whites * 0.1) / 100
  if (r4(bright) !== 1) parts.push(`brightness(${r4(Math.max(0, bright))})`)

  // Contrast gathers the contrast slider + highlights/blacks spread + clarity's local punch.
  const contrast = 1 + (adjust.contrast * 0.5 + adjust.highlights * 0.12 - adjust.blacks * 0.12 + adjust.clarity * 0.25) / 100
  if (r4(contrast) !== 1) parts.push(`contrast(${r4(Math.max(0, contrast))})`)

  // Saturation + the softer vibrance (vibrance weighted lower, like Lightroom's "smart" sat).
  const sat = 1 + (adjust.saturation + adjust.vibrance * 0.6) / 100
  if (r4(sat) !== 1) parts.push(`saturate(${r4(Math.max(0, sat))})`)

  // Warmth: positive temp → sepia toward orange; cool temp → a slight blue hue rotation.
  if (adjust.temp > 0) parts.push(`sepia(${r4((adjust.temp / 100) * 0.5)})`)
  const hue = adjust.tint * 0.6 + (adjust.temp < 0 ? adjust.temp * 0.4 : 0)
  if (r4(hue) !== 0) parts.push(`hue-rotate(${r4(hue)}deg)`)

  return parts.length ? parts.join(' ') : 'none'
}

/**
 * The vignette overlay opacity, 0..1, for a radial-gradient layer the component paints over
 * the image. Positive vignette darkens the corners (dark overlay); negative brightens them
 * (the component flips the gradient colour). Returns 0 when neutral.
 */
export function vignetteOpacity(adjust: PhotoAdjust): number {
  return r4(Math.min(1, Math.abs(adjust.vignette) / 100) * 0.6)
}

/**
 * Build a 256-entry tone-curve lookup table from normalized {@link CurvePoint}s (0..1 on
 * both axes), piecewise-linear between points and flat outside the first/last. Index =
 * input level 0..255, value = mapped output level 0..255. An empty/недостаточный set yields
 * the identity ramp. Used by the optional 2D-canvas preview path.
 */
export function buildCurveLut(points: CurvePoint[]): number[] {
  const lut = new Array<number>(256)
  const pts = [...points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x)
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i
    return lut
  }
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    let y: number
    if (x <= pts[0].x) {
      y = pts[0].y
    } else if (x >= pts[pts.length - 1].x) {
      y = pts[pts.length - 1].y
    } else {
      let j = 1
      while (j < pts.length && pts[j].x < x) j++
      const a = pts[j - 1]
      const b = pts[j]
      const span = b.x - a.x
      const t = span > 0 ? (x - a.x) / span : 0
      y = a.y + (b.y - a.y) * t
    }
    lut[i] = Math.max(0, Math.min(255, Math.round(y * 255)))
  }
  return lut
}

// ── Script playback evaluation ────────────────────────────────────────────────
//
// The pure "where is the edit RIGHT NOW" function the rAF player calls each frame. Given
// the choreography and a clock position in ms, it folds every step whose time has arrived
// into one live {@link PhotoAdjust} plus the cursor/panel/curve state the overlay needs.
// Pure + deterministic, so it unit-tests without React.

/** The renderer-side neutral adjust (a copy of photo-core's — the renderer imports no main). */
export const PHOTO_NEUTRAL_ADJUST: PhotoAdjust = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0, clarity: 0, sharpen: 0, vignette: 0
}

/** The thirteen Basic numeric fields, as a value-level list for safe dynamic assignment. */
const PHOTO_NUM_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temp', 'tint', 'vibrance', 'saturation', 'clarity', 'sharpen', 'vignette'
] as const
type PhotoNumKey = (typeof PHOTO_NUM_KEYS)[number]
function isPhotoNumKey(k: string): k is PhotoNumKey {
  return (PHOTO_NUM_KEYS as readonly string[]).includes(k)
}

/** Smoothstep ease (0→1), so sliders accelerate in and settle out instead of marching linearly. */
function ease(p: number): number {
  const t = Math.min(1, Math.max(0, p))
  return t * t * (3 - 2 * t)
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** The live state the player publishes each frame: the adjust plus cursor/panel/curve cues. */
export interface LivePlayback {
  /** The approximate adjust to show NOW (sliders mid-sweep, curve mid-draw). */
  adjust: PhotoAdjust
  /** Which panel the UI should have active. */
  activePanel: EditorPanel
  /** The semantic id the virtual cursor is currently over (null before the first move). */
  cursorControl: string | null
  /** 0..1 glide progress toward {@link cursorControl}. */
  cursorProgress: number
  /** The curve channel being drawn now + its 0..1 progress, or null. */
  curveDraw: { channel: 'rgb' | 'r' | 'g' | 'b'; progress: number } | null
  /** The control mid-animation this frame (for a highlight pulse), or null when settled. */
  activeControl: string | null
}

/**
 * Evaluate a photo {@link EditorScript} at clock position `ms`: fold every step that has
 * started into one live {@link PhotoAdjust}, interpolating sliders/HSL in flight and
 * revealing a curve as it draws, and report the cursor target + active panel. Steps are
 * applied in order (they are emitted time-ascending). Clamp `ms` to [0, totalMs] upstream.
 */
export function evalPhotoScriptAt(script: EditorScript, ms: number): LivePlayback {
  const adjust: PhotoAdjust = { ...PHOTO_NEUTRAL_ADJUST }
  let activePanel: EditorPanel = 'basic'
  let cursorControl: string | null = null
  let cursorProgress = 1
  let curveDraw: { channel: 'rgb' | 'r' | 'g' | 'b'; progress: number } | null = null
  let activeControl: string | null = null
  let cropVisited = false

  for (const step of script.steps) {
    if (step.atMs > ms) continue
    switch (step.type) {
      case 'panel-switch':
        activePanel = step.panel
        if (step.panel === 'crop') cropVisited = true
        break
      case 'cursor-move':
        cursorControl = step.control
        cursorProgress = ease((ms - step.atMs) / step.durationMs)
        break
      case 'set-slider': {
        const raw = (ms - step.atMs) / step.durationMs
        const v = lerp(step.from, step.to, ease(raw))
        if (step.control === 'rotate') adjust.rotate = v
        else if (isPhotoNumKey(step.control)) adjust[step.control] = v
        if (raw < 1) activeControl = step.control
        break
      }
      case 'set-hsl': {
        const raw = (ms - step.atMs) / step.durationMs
        const v = lerp(step.from, step.to, ease(raw))
        const hsl = adjust.hsl ?? (adjust.hsl = {})
        const band: HslAdjust = hsl[step.band as HslBand] ?? { hue: 0, sat: 0, lum: 0 }
        band[step.field] = v
        hsl[step.band as HslBand] = band
        if (raw < 1) activeControl = `hsl-${step.band}`
        break
      }
      case 'draw-curve': {
        const raw = (ms - step.atMs) / step.durationMs
        const curve = adjust.curve ?? (adjust.curve = {})
        curve[step.channel] = step.points
        if (raw < 1) {
          curveDraw = { channel: step.channel, progress: ease(raw) }
          activeControl = `curve-${step.channel}`
        }
        break
      }
      default:
        // playhead / add-clip / split / add-text / transition / render — video or no-op here.
        break
    }
  }

  if (cropVisited && script.target?.crop) adjust.crop = script.target.crop
  return { adjust, activePanel, cursorControl, cursorProgress, curveDraw, activeControl }
}

// ── Video (CapCut) playback evaluation ──────────────────────────────────────────
//
// The video counterpart to {@link evalPhotoScriptAt}: fold a video {@link EditorScript} at a
// clock position into the live timeline state the CapCut UI reads — which clips/captions have
// been laid down, where the playhead sits, the grade intensity mid-sweep, and the cursor
// target. Pure + deterministic. The grade is approximated for the preview; the FFmpeg bake is
// authoritative.

/** True for a video-track clip (narrows the timeline's clip union without a cast). */
function isVideoClip(c: EditorClip | EditorTextClip | EditorAudioClip): c is EditorClip {
  return c.track === 'video'
}

/** A boundary marker between two clips the user has watched Myto place. */
export interface VideoBoundary {
  atSec: number
  kind: 'split' | 'transition'
  name?: string
}

/** The live timeline state the video player publishes each frame. */
export interface VideoPlayback {
  /** Which panel the UI should have active (timeline / effects / text). */
  activePanel: EditorPanel
  /** The semantic id the virtual cursor is over (null before the first move). */
  cursorControl: string | null
  /** 0..1 glide progress toward {@link cursorControl}. */
  cursorProgress: number
  /** The control mid-animation this frame (for a highlight pulse), or null. */
  activeControl: string | null
  /** Playhead position in OUTPUT seconds (0..timeline.durationSec). */
  playheadSec: number
  /** How many video clips have been laid onto the timeline so far (progressive reveal). */
  clipsPlaced: number
  /** Ids of text captions already placed on the text track. */
  textsPlaced: string[]
  /** The colour-grade slider's live value, 0..100. */
  grade: number
  /** The grade/filter preset name applied to the clips, or null. */
  gradeName: string | null
  /** Inter-clip boundaries (cuts / transitions) placed so far. */
  boundaries: VideoBoundary[]
}

/**
 * Evaluate a video {@link EditorScript} at clock position `ms`: replay every step that has
 * started to report how much of the timeline Myto has built (clips/captions placed, cut vs
 * transition boundaries), the live grade value, and the playhead + cursor targets. Steps are
 * applied in order (emitted time-ascending). Clamp `ms` to [0, totalMs] upstream.
 */
export function evalVideoScriptAt(script: EditorScript, ms: number): VideoPlayback {
  let activePanel: EditorPanel = 'timeline'
  let cursorControl: string | null = null
  let cursorProgress = 1
  let activeControl: string | null = null
  let playheadSec = 0
  let clipsPlaced = 0
  const textsPlaced: string[] = []
  let grade = 0
  const boundaries: VideoBoundary[] = []

  // Every video clip shares the one grade preset; pull its name off the timeline.
  const gradeName =
    script.timeline?.tracks
      .find((t) => t.kind === 'video')
      ?.clips.filter(isVideoClip)
      .map((c) => c.grade)
      .find((g): g is string => typeof g === 'string') ?? null

  for (const step of script.steps) {
    if (step.atMs > ms) continue
    switch (step.type) {
      case 'panel-switch':
        activePanel = step.panel
        break
      case 'cursor-move':
        cursorControl = step.control
        cursorProgress = ease((ms - step.atMs) / step.durationMs)
        break
      case 'add-clip':
        clipsPlaced++
        break
      case 'add-text':
        textsPlaced.push(step.clip.id)
        break
      case 'split':
        boundaries.push({ atSec: step.atSec, kind: 'split' })
        break
      case 'transition':
        boundaries.push({ atSec: step.atSec, kind: 'transition', name: step.name })
        break
      case 'set-slider':
        if (step.control === 'grade') {
          const raw = (ms - step.atMs) / step.durationMs
          grade = lerp(step.from, step.to, ease(raw))
          if (raw < 1) activeControl = 'grade'
        }
        break
      case 'playhead': {
        const raw = (ms - step.atMs) / step.durationMs
        playheadSec = lerp(step.from, step.to, ease(raw))
        if (raw < 1) activeControl = 'playhead'
        break
      }
      default:
        // draw-curve / set-hsl / render — photo or no-op here.
        break
    }
  }

  return {
    activePanel, cursorControl, cursorProgress, activeControl,
    playheadSec, clipsPlaced, textsPlaced, grade, gradeName, boundaries
  }
}

/**
 * A cheap CSS `filter` approximating a named colour grade at `intensity` (0..100), for the
 * live video preview while the grade slider sweeps. Like {@link cssFilterFor} this is only an
 * APPROXIMATION — the FFmpeg bake is the authoritative look. Returns 'none' at zero intensity
 * or with no grade. Known preset families (bw / warm·cinematic / cool / vintage / vivid) map
 * to tuned primitives; anything else gets a gentle contrast + saturation lift.
 */
export function videoGradeFilter(name: string | null, intensity: number): string {
  const k = r4(Math.max(0, Math.min(1, intensity / 100)))
  if (!name || k === 0) return 'none'
  const n = name.toLowerCase()
  const parts: string[] = []
  if (/\b(bw|mono|noir|gray|grey|black)\b/.test(n) || n.includes('mono') || n.includes('noir')) {
    parts.push(`grayscale(${r4(k)})`, `contrast(${r4(1 + 0.2 * k)})`)
  } else if (n.includes('warm') || n.includes('cinema') || n.includes('gold') || n.includes('sunset') || n.includes('teal')) {
    parts.push(`sepia(${r4(0.45 * k)})`, `saturate(${r4(1 + 0.25 * k)})`, `contrast(${r4(1 + 0.18 * k)})`)
  } else if (n.includes('cool') || n.includes('cold') || n.includes('blue') || n.includes('winter')) {
    parts.push(`hue-rotate(${r4(-18 * k)}deg)`, `saturate(${r4(1 + 0.15 * k)})`, `contrast(${r4(1 + 0.12 * k)})`)
  } else if (n.includes('vintage') || n.includes('retro') || n.includes('faded') || n.includes('film')) {
    parts.push(`sepia(${r4(0.35 * k)})`, `saturate(${r4(1 - 0.25 * k)})`, `contrast(${r4(1 - 0.08 * k)})`)
  } else if (n.includes('vivid') || n.includes('pop') || n.includes('vibrant')) {
    parts.push(`saturate(${r4(1 + 0.5 * k)})`, `contrast(${r4(1 + 0.2 * k)})`)
  } else {
    parts.push(`contrast(${r4(1 + 0.15 * k)})`, `saturate(${r4(1 + 0.2 * k)})`)
  }
  return parts.length ? parts.join(' ') : 'none'
}


