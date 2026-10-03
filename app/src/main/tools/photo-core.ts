/**
 * Photo-edit argument builder + validator — the PURE half of `edit_photo`, mirroring
 * {@link ffmpeg-core} for video. No Electron, no spawn, no fs: it takes a resolved
 * {@link PhotoAdjust} and already-resolved absolute paths and returns an ffmpeg `-vf`
 * filter string or a full arg vector. The model never composes a shell string — it fills
 * the small typed {@link PhotoAdjust} fields, and these builders turn them into an arg
 * ARRAY the runtime spawns with no shell.
 *
 * ── Slider conventions (shared by the live preview AND this bake) ──
 * Every "amount" field is -100..100 with 0 = neutral: exposure, contrast, highlights,
 * shadows, whites, blacks, temp (cool→warm), tint (green→magenta), vibrance, saturation,
 * clarity, sharpen, vignette (darken edges when +). `rotate` is degrees. `crop` is
 * fractions (0..1) of the source. Tone-curve / HSL use the shapes in {@link PhotoAdjust}.
 * These are OUR conventions — Lightroom-like but not Lightroom-exact; the honest contract
 * is that the live canvas and the FFmpeg bake read the same numbers and move together.
 */
import type { PhotoAdjust, CurvePoint, HslAdjust, HslBand } from '../../shared/types'

/** The identity adjust — every field neutral. A fresh editor session starts here. */
export const PHOTO_NEUTRAL: PhotoAdjust = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0, clarity: 0, sharpen: 0, vignette: 0
}

/** The eight HSL bands, in hue order — the colour wheel split Lightroom uses. */
export const HSL_BANDS: readonly HslBand[] = [
  'red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'
]

/** Clamp to [lo, hi]; non-finite → 0 (then clamped). */
export function clampAmount(v: unknown, lo = -100, hi = 100): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.min(hi, Math.max(lo, n))
}

/** Clamp to [0, 1]. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** Round to 4 dp — keeps filter strings short and the unit tests legible. */
function r4(n: number): number {
  return Math.round(n * 10000) / 10000
}
function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Validate a raw array of {x,y} into clamped {@link CurvePoint}s, sorted by x. Empty → undefined. */
function validateCurvePoints(raw: unknown): CurvePoint[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const pts: CurvePoint[] = []
  for (const p of raw) {
    const o = asObj(p)
    if (!o) continue
    pts.push({ x: clamp01(Number(o.x)), y: clamp01(Number(o.y)) })
  }
  if (pts.length === 0) return undefined
  // Sort by x and drop duplicate x (ffmpeg's curves needs strictly increasing x).
  pts.sort((a, b) => a.x - b.x)
  const dedup: CurvePoint[] = []
  for (const p of pts) {
    if (dedup.length === 0 || p.x > dedup[dedup.length - 1].x) dedup.push(p)
  }
  return dedup
}

/** Validate the optional per-channel tone curve object. */
function validateCurve(raw: unknown): PhotoAdjust['curve'] {
  const o = asObj(raw)
  if (!o) return undefined
  const curve: NonNullable<PhotoAdjust['curve']> = {}
  const rgb = validateCurvePoints(o.rgb)
  const r = validateCurvePoints(o.r)
  const g = validateCurvePoints(o.g)
  const b = validateCurvePoints(o.b)
  if (rgb) curve.rgb = rgb
  if (r) curve.r = r
  if (g) curve.g = g
  if (b) curve.b = b
  return Object.keys(curve).length ? curve : undefined
}

/** Validate the optional HSL per-band map (each band → {hue,sat,lum} amounts). */
function validateHsl(raw: unknown): PhotoAdjust['hsl'] {
  const o = asObj(raw)
  if (!o) return undefined
  const hsl: Partial<Record<HslBand, HslAdjust>> = {}
  for (const band of HSL_BANDS) {
    const bo = asObj(o[band])
    if (!bo) continue
    const adj: HslAdjust = {
      hue: clampAmount(bo.hue), sat: clampAmount(bo.sat), lum: clampAmount(bo.lum)
    }
    if (adj.hue || adj.sat || adj.lum) hsl[band] = adj
  }
  return Object.keys(hsl).length ? hsl : undefined
}

/** Discriminated validation result so the tool can print a precise error. */
export type PhotoAdjustResult = { ok: true; adjust: PhotoAdjust } | { ok: false; error: string }

/**
 * Coerce the raw adjust object the model emits into a clamped, fully-populated
 * {@link PhotoAdjust}. Unknown/missing numeric fields default to neutral (0); every
 * amount is clamped to [-100,100]. Never throws — the only `ok:false` case is a non-object.
 */
export function validatePhotoAdjust(raw: unknown): PhotoAdjustResult {
  const o = asObj(raw)
  if (!o) return { ok: false, error: 'the photo adjustment must be a JSON object' }
  const adjust: PhotoAdjust = {
    exposure: clampAmount(o.exposure), contrast: clampAmount(o.contrast),
    highlights: clampAmount(o.highlights), shadows: clampAmount(o.shadows),
    whites: clampAmount(o.whites), blacks: clampAmount(o.blacks),
    temp: clampAmount(o.temp), tint: clampAmount(o.tint),
    vibrance: clampAmount(o.vibrance), saturation: clampAmount(o.saturation),
    clarity: clampAmount(o.clarity), sharpen: clampAmount(o.sharpen),
    vignette: clampAmount(o.vignette)
  }
  const curve = validateCurve(o.curve)
  if (curve) adjust.curve = curve
  const hsl = validateHsl(o.hsl)
  if (hsl) adjust.hsl = hsl
  const cropObj = asObj(o.crop)
  if (cropObj) {
    const crop = {
      x: clamp01(Number(cropObj.x)), y: clamp01(Number(cropObj.y)),
      w: clamp01(Number(cropObj.w)), h: clamp01(Number(cropObj.h))
    }
    // Only keep a crop that actually selects a sub-region.
    if (crop.w > 0 && crop.h > 0 && (crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1)) {
      adjust.crop = crop
    }
  }
  if (o.rotate != null && Number.isFinite(Number(o.rotate))) {
    adjust.rotate = ((Number(o.rotate) % 360) + 360) % 360
  }
  return { ok: true, adjust }
}
// ── Filter-chain construction ─────────────────────────────────────────────────
//
// Each adjustment maps to a robust, widely-available libavfilter primitive. The pieces
// are assembled in a fixed, photographically-sensible order (geometry → tone → colour →
// detail → vignette) and joined into one `-vf` chain. Scales are deliberately gentle so
// a ±100 slider is a strong-but-not-destructive move, matching the live preview.

/** Render curve points as ffmpeg's `curves` point list: `x0/y0 x1/y1 …` (quoted by caller). */
export function curvePointsToString(pts: CurvePoint[]): string {
  return pts.map((p) => `${r4(p.x)}/${r4(p.y)}`).join(' ')
}

/**
 * Build the master tone curve from the four tonal sliders (blacks/shadows/highlights/
 * whites). Positive blacks lift the floor (a faded look); negative crushes it. Positive
 * whites pulls the white point in (brighter highlights); negative lowers it. Returns null
 * when all four are neutral. Points are clamped to the unit square and strictly increasing.
 */
export function toneCurvePoints(adjust: PhotoAdjust): CurvePoint[] | null {
  const { blacks, shadows, highlights, whites } = adjust
  if (!blacks && !shadows && !highlights && !whites) return null
  const K = 0.0012 // ±100 ⇒ ±0.12 shift
  const raw: CurvePoint[] = []
  raw.push(blacks >= 0 ? { x: 0, y: clamp01(blacks * K) } : { x: clamp01(-blacks * K), y: 0 })
  raw.push({ x: 0.25, y: clamp01(0.25 + shadows * K) })
  raw.push({ x: 0.5, y: 0.5 })
  raw.push({ x: 0.75, y: clamp01(0.75 + highlights * K) })
  raw.push(whites >= 0 ? { x: clamp01(1 - whites * K), y: 1 } : { x: 1, y: clamp01(1 + whites * K) })
  // Enforce strictly-increasing x (ffmpeg's curves requirement) by sorting + de-duping.
  raw.sort((a, b) => a.x - b.x)
  const pts: CurvePoint[] = []
  for (const p of raw) {
    if (pts.length === 0 || p.x > pts[pts.length - 1].x) pts.push(p)
  }
  return pts
}

/**
 * Collapse the per-band HSL map into ONE global `hue` filter — the honest best-effort for
 * the bake (the live canvas shows true per-band HSL; see the plan's fidelity note). Returns
 * the average hue rotation (degrees) and saturation multiplier across the touched bands.
 */
export function aggregateHsl(hsl: NonNullable<PhotoAdjust['hsl']>): { hueDeg: number; satMult: number } {
  let hueSum = 0
  let satSum = 0
  let n = 0
  for (const band of HSL_BANDS) {
    const b = hsl[band]
    if (!b) continue
    hueSum += b.hue
    satSum += b.sat
    n++
  }
  if (n === 0) return { hueDeg: 0, satMult: 1 }
  return {
    hueDeg: r4((hueSum / n / 100) * 30), // ±100 avg ⇒ ±30°
    satMult: r4(Math.max(0, 1 + satSum / n / 100))
  }
}
/** Build the geometry prefix (crop then rotate) — the pixels that MOVE, applied first. */
function geometryFilters(adjust: PhotoAdjust): string[] {
  const out: string[] = []
  const c = adjust.crop
  if (c && c.w > 0 && c.h > 0) {
    out.push(`crop=iw*${r4(c.w)}:ih*${r4(c.h)}:iw*${r4(c.x)}:ih*${r4(c.y)}`)
  }
  const deg = adjust.rotate ? ((adjust.rotate % 360) + 360) % 360 : 0
  if (deg) {
    // Lossless 90° steps via transpose; arbitrary angles via `rotate` (radians, black fill).
    if (deg === 90) out.push('transpose=1')
    else if (deg === 180) out.push('transpose=2,transpose=2')
    else if (deg === 270) out.push('transpose=2')
    else out.push(`rotate=${r4((deg * Math.PI) / 180)}:fillcolor=black`)
  }
  return out
}

/** The `eq` tone filter: exposure→brightness, contrast, saturation. Omits neutral params. */
function eqFilter(adjust: PhotoAdjust): string | null {
  const parts: string[] = []
  if (adjust.exposure) parts.push(`brightness=${r4((adjust.exposure / 100) * 0.4)}`) // ±0.4
  if (adjust.contrast) parts.push(`contrast=${r4(1 + (adjust.contrast / 100) * 0.5)}`) // 0.5–1.5
  if (adjust.saturation) parts.push(`saturation=${r4(clampAmount(1 + adjust.saturation / 100, 0, 3))}`)
  return parts.length ? `eq=${parts.join(':')}` : null
}

/** The explicit per-channel tone curve the model drew (rgb master + optional r/g/b). */
function explicitCurveFilter(curve: PhotoAdjust['curve']): string | null {
  if (!curve) return null
  const parts: string[] = []
  if (curve.rgb?.length) parts.push(`m='${curvePointsToString(curve.rgb)}'`)
  if (curve.r?.length) parts.push(`r='${curvePointsToString(curve.r)}'`)
  if (curve.g?.length) parts.push(`g='${curvePointsToString(curve.g)}'`)
  if (curve.b?.length) parts.push(`b='${curvePointsToString(curve.b)}'`)
  return parts.length ? `curves=${parts.join(':')}` : null
}

/** White-balance via `colorbalance` midtones: temp = blue↔red, tint = green↔magenta. */
function whiteBalanceFilter(adjust: PhotoAdjust): string | null {
  const { temp, tint } = adjust
  if (!temp && !tint) return null
  const t = (temp / 100) * 0.3 // warm (+) pushes red up, blue down
  const g = -(tint / 100) * 0.3 // magenta (+) pulls green down
  return `colorbalance=rm=${r4(t)}:gm=${r4(g)}:bm=${r4(-t)}`
}
/**
 * Assemble the full `-vf` filter chain for an adjust, in photographically-sensible order:
 * geometry → exposure/contrast/sat (`eq`) → tonal curve → explicit curve → white balance →
 * vibrance → global HSL → clarity → sharpen → vignette. Each piece is emitted only when it
 * actually moves the image, so a neutral adjust yields `''` (caller then drops `-vf`).
 */
export function buildPhotoFilterChain(adjust: PhotoAdjust): string {
  const chain: string[] = []
  chain.push(...geometryFilters(adjust))

  const eq = eqFilter(adjust)
  if (eq) chain.push(eq)

  const tonal = toneCurvePoints(adjust)
  if (tonal) chain.push(`curves=m='${curvePointsToString(tonal)}'`)

  const explicit = explicitCurveFilter(adjust.curve)
  if (explicit) chain.push(explicit)

  const wb = whiteBalanceFilter(adjust)
  if (wb) chain.push(wb)

  if (adjust.vibrance) chain.push(`vibrance=intensity=${r4(clampAmount(adjust.vibrance / 100, -2, 2))}`)

  if (adjust.hsl) {
    const { hueDeg, satMult } = aggregateHsl(adjust.hsl)
    if (hueDeg || satMult !== 1) chain.push(`hue=h=${hueDeg}:s=${satMult}`)
  }

  // Clarity = wide-radius local contrast; sharpen = tight-radius edge boost. Both via unsharp.
  if (adjust.clarity) chain.push(`unsharp=lx=9:ly=9:la=${r4((adjust.clarity / 100) * 0.8)}`)
  if (adjust.sharpen) chain.push(`unsharp=lx=5:ly=5:la=${r4((adjust.sharpen / 100) * 1.2)}`)

  if (adjust.vignette) {
    const angle = r4((Math.abs(adjust.vignette) / 100) * (Math.PI / 4))
    // Positive darkens the corners (forward); negative brightens them (backward).
    chain.push(adjust.vignette > 0 ? `vignette=angle=${angle}` : `vignette=angle=${angle}:mode=backward`)
  }

  return chain.join(',')
}

/** Options for {@link buildPhotoEditArgs}: output quality tuning for lossy encoders. */
export interface PhotoEditOpts {
  /** JPEG/WebP quality (ffmpeg `-q:v`, 1=best…31). Default 2 — visually lossless. */
  quality?: number
}

/**
 * Full argv for a one-shot image re-encode: read the input, apply the chain (when any),
 * write exactly one frame to the output. Paths are passed as separate argv tokens (no
 * shell), so no escaping is needed here beyond what ffmpeg itself does. The caller resolves
 * both paths and guarantees output ≠ input (sandbox under {@link OUTPUT_DIR}).
 */
export function buildPhotoEditArgs(
  inputAbs: string,
  outputAbs: string,
  adjust: PhotoAdjust,
  opts: PhotoEditOpts = {}
): string[] {
  const chain = buildPhotoFilterChain(adjust)
  const lossy = /\.(jpe?g|webp)$/i.test(outputAbs)
  const q = Math.max(1, Math.min(31, Math.round(opts.quality ?? 2)))
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    inputAbs,
    ...(chain ? ['-vf', chain] : []),
    '-frames:v',
    '1',
    ...(lossy ? ['-q:v', String(q)] : []),
    outputAbs
  ]
}
