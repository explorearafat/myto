import type { PhotoAdjust, CurvePoint } from '@shared/types'
import { buildCurveLut } from './editor-preview'

/**
 * The renderer-side REAL pixel pipeline for the manual Studio — honest WYSIWYG for the live
 * canvas (not the CSS-filter approximation {@link cssFilterFor} used while the agent animates).
 * It mirrors the ORDER and scale conventions of the authoritative ffmpeg chain in
 * `photo-core.ts` (geometry → tone → white balance → saturation/vibrance → per-channel curves
 * → vignette) so what the user drags on the canvas closely matches the exported bake. Pure: it
 * works on a plain `Uint8ClampedArray` + width/height, so it unit-tests in node without a DOM.
 *
 * Tone detail (clarity/sharpen) is intentionally omitted from the live canvas — those are
 * convolution filters the ffmpeg bake applies; the preview stays responsive without them.
 */

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n
}
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * The master tonal curve from the four tonal sliders — the renderer twin of
 * `photo-core.toneCurvePoints` (same K=0.0012 so ±100 ⇒ ±0.12 shift), returning normalized
 * {@link CurvePoint}s or null when all four are neutral.
 */
export function toneCurvePoints(adjust: PhotoAdjust): CurvePoint[] | null {
  const { blacks, shadows, highlights, whites } = adjust
  if (!blacks && !shadows && !highlights && !whites) return null
  const K = 0.0012
  const raw: CurvePoint[] = []
  raw.push(blacks >= 0 ? { x: 0, y: clamp01(blacks * K) } : { x: clamp01(-blacks * K), y: 0 })
  raw.push({ x: 0.25, y: clamp01(0.25 + shadows * K) })
  raw.push({ x: 0.5, y: 0.5 })
  raw.push({ x: 0.75, y: clamp01(0.75 + highlights * K) })
  raw.push(whites >= 0 ? { x: clamp01(1 - whites * K), y: 1 } : { x: 1, y: clamp01(1 + whites * K) })
  raw.sort((a, b) => a.x - b.x)
  const pts: CurvePoint[] = []
  for (const p of raw) {
    if (pts.length === 0 || p.x > pts[pts.length - 1].x) pts.push(p)
  }
  return pts
}

/**
 * Build a 256-entry tone LUT folding exposure (brightness add), contrast (around mid-grey),
 * the tonal curve (blacks/shadows/highlights/whites), and an explicit RGB-composite curve —
 * everything that maps a luma level the same way on all three channels. Index = input 0..255,
 * value = output 0..255.
 */
export function buildToneLut(adjust: PhotoAdjust): Uint8Array {
  const lut = new Uint8Array(256)
  const bright = (adjust.exposure / 100) * 0.4 * 255 // ±0.4 in [0..1] → ±102 levels
  const contrast = 1 + (adjust.contrast / 100) * 0.5 // 0.5..1.5
  const tonal = toneCurvePoints(adjust)
  const tonalLut = tonal ? buildCurveLut(tonal) : null
  const rgbLut = adjust.curve?.rgb?.length ? buildCurveLut(adjust.curve.rgb) : null
  for (let i = 0; i < 256; i++) {
    let v = i + bright
    v = (v - 128) * contrast + 128 // contrast about mid-grey
    v = clamp8(v)
    if (tonalLut) v = tonalLut[Math.round(v)]
    if (rgbLut) v = rgbLut[Math.round(v)]
    lut[i] = clamp8(v)
  }
  return lut
}

/** Per-channel explicit curve LUTs (r/g/b), or null entries when that channel is untouched. */
function channelLuts(adjust: PhotoAdjust): { r: number[] | null; g: number[] | null; b: number[] | null } {
  return {
    r: adjust.curve?.r?.length ? buildCurveLut(adjust.curve.r) : null,
    g: adjust.curve?.g?.length ? buildCurveLut(adjust.curve.g) : null,
    b: adjust.curve?.b?.length ? buildCurveLut(adjust.curve.b) : null
  }
}

/** Rec.601 luma — the grey a pixel desaturates toward. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Apply a full {@link PhotoAdjust}'s COLOUR + TONE to RGBA pixels in place (geometry — crop,
 * rotate — is the canvas's job, drawn separately). `width`/`height` drive the vignette falloff.
 * Deterministic and allocation-light (one LUT pass + per-pixel math), so a 1280px preview
 * updates well within a frame.
 */
export function applyAdjustToPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  adjust: PhotoAdjust
): void {
  const tone = buildToneLut(adjust)
  const ch = channelLuts(adjust)
  // White balance (matches colorBalanceFor's direction: warm pushes red up / blue down).
  const t = (adjust.temp / 100) * 0.3
  const tintG = -(adjust.tint / 100) * 0.3
  const rGain = 1 + t
  const bGain = 1 - t
  const gGain = 1 + tintG
  const sat = 1 + adjust.saturation / 100
  const vibAmt = (adjust.vibrance / 100) * 0.6
  const hasVignette = adjust.vignette !== 0
  const vigStrength = Math.min(1, Math.abs(adjust.vignette) / 100) * 0.7
  const vigDarken = adjust.vignette > 0
  const cx = width / 2
  const cy = height / 2
  const maxDist = Math.hypot(cx, cy) || 1

  for (let p = 0, px = 0; p < data.length; p += 4, px++) {
    let r = tone[data[p]]
    let g = tone[data[p + 1]]
    let b = tone[data[p + 2]]

    // White balance.
    if (t !== 0) {
      r = clamp8(r * rGain)
      b = clamp8(b * bGain)
    }
    if (tintG !== 0) g = clamp8(g * gGain)

    // Saturation + vibrance (vibrance leans on less-saturated pixels, like Lightroom).
    if (sat !== 1 || vibAmt !== 0) {
      const y = luma(r, g, b)
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const pxSat = mx <= 0 ? 0 : (mx - mn) / mx
      const s = sat + vibAmt * (1 - pxSat)
      r = clamp8(y + (r - y) * s)
      g = clamp8(y + (g - y) * s)
      b = clamp8(y + (b - y) * s)
    }

    // Per-channel explicit curves.
    if (ch.r) r = ch.r[r]
    if (ch.g) g = ch.g[g]
    if (ch.b) b = ch.b[b]

    // Vignette (radial falloff from the centre).
    if (hasVignette) {
      const x = px % width
      const yy = (px - x) / width
      const d = Math.hypot(x - cx, yy - cy) / maxDist
      const falloff = d * d * vigStrength
      if (vigDarken) {
        const k = 1 - falloff
        r = clamp8(r * k)
        g = clamp8(g * k)
        b = clamp8(b * k)
      } else {
        r = clamp8(r + (255 - r) * falloff)
        g = clamp8(g + (255 - g) * falloff)
        b = clamp8(b + (255 - b) * falloff)
      }
    }

    data[p] = r
    data[p + 1] = g
    data[p + 2] = b
  }
}

/** True when an adjust touches pixels (tone/colour), so the canvas can skip the LUT pass. */
export function adjustTouchesPixels(adjust: PhotoAdjust): boolean {
  return (
    !!adjust.exposure || !!adjust.contrast || !!adjust.highlights || !!adjust.shadows ||
    !!adjust.whites || !!adjust.blacks || !!adjust.temp || !!adjust.tint ||
    !!adjust.vibrance || !!adjust.saturation || !!adjust.vignette || !!adjust.curve
  )
}
