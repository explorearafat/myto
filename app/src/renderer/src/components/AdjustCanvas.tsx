import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { PhotoAdjust } from '@shared/types'
import { applyAdjustToPixels } from '../lib/photo-render'

/**
 * The live, pixel-accurate canvas for the manual photo Studio. It decodes the (downscaled)
 * source once into a cached base {@link ImageData}, then on every adjust change recomputes the
 * tone/colour with {@link applyAdjustToPixels} and draws the result through the geometry stage
 * (crop → rotate), mirroring the ffmpeg bake's order so what the user drags matches the export.
 * A positive/negative crop overlay is NOT drawn here — the parent draws the crop UI on top; this
 * component just renders the final edited pixels into the crop/rotate frame.
 */
export function AdjustCanvas({ sourcePreview, adjust }: { sourcePreview: string; adjust: PhotoAdjust }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const baseRef = useRef<ImageData | null>(null)
  const [ready, setReady] = useState(false)

  // Decode the source once into a cached base ImageData (natural, already-downscaled size).
  useEffect(() => {
    let alive = true
    setReady(false)
    baseRef.current = null
    if (!sourcePreview) return
    const img = new Image()
    img.onload = () => {
      if (!alive) return
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      const oc = document.createElement('canvas')
      oc.width = w
      oc.height = h
      const octx = oc.getContext('2d', { willReadFrequently: true })
      if (!octx) return
      octx.drawImage(img, 0, 0)
      try {
        baseRef.current = octx.getImageData(0, 0, w, h)
        setReady(true)
      } catch {
        // Tainted canvas (shouldn't happen for same-origin data: URLs) — give up gracefully.
        baseRef.current = null
      }
    }
    img.src = sourcePreview
    return () => {
      alive = false
    }
  }, [sourcePreview])

  // Re-render whenever the adjust (or the decoded base) changes.
  useEffect(() => {
    const base = baseRef.current
    const canvas = canvasRef.current
    if (!base || !canvas) return
    const W = base.width
    const H = base.height

    // 1) Tone/colour pass on a copy of the base pixels.
    const pixels = new Uint8ClampedArray(base.data)
    applyAdjustToPixels(pixels, W, H, adjust)
    const edited = new ImageData(pixels, W, H)
    const full = document.createElement('canvas')
    full.width = W
    full.height = H
    full.getContext('2d')?.putImageData(edited, 0, 0)

    // 2) Crop (normalized → source px), clamped so a degenerate crop can't produce a 0-size canvas.
    const c = adjust.crop
    const sx = c ? Math.round(Math.min(0.999, Math.max(0, c.x)) * W) : 0
    const sy = c ? Math.round(Math.min(0.999, Math.max(0, c.y)) * H) : 0
    const sw = c ? Math.max(1, Math.round(Math.min(1, c.w) * W)) : W
    const sh = c ? Math.max(1, Math.round(Math.min(1, c.h) * H)) : H
    const cw = Math.min(sw, W - sx)
    const chh = Math.min(sh, H - sy)

    // 3) Rotate (clockwise degrees), black fill for arbitrary angles — like ffmpeg's rotate.
    const deg = ((Math.round(adjust.rotate ?? 0) % 360) + 360) % 360
    const rad = (deg * Math.PI) / 180
    const quarter = deg === 90 || deg === 270
    const outW = quarter ? chh : deg % 90 === 0 ? cw : Math.ceil(Math.abs(cw * Math.cos(rad)) + Math.abs(chh * Math.sin(rad)))
    const outH = quarter ? cw : deg % 90 === 0 ? chh : Math.ceil(Math.abs(cw * Math.sin(rad)) + Math.abs(chh * Math.cos(rad)))

    canvas.width = Math.max(1, outW)
    canvas.height = Math.max(1, outH)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (deg % 90 !== 0) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    if (deg) ctx.rotate(rad)
    ctx.drawImage(full, sx, sy, cw, chh, -cw / 2, -chh / 2, cw, chh)
    ctx.restore()
  }, [adjust, ready])

  return (
    <canvas
      ref={canvasRef}
      className="max-h-full max-w-full rounded-md object-contain shadow-lg"
      style={{ imageRendering: 'auto' }}
    />
  )
}
