import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { PhotoAdjust } from '@shared/types'

/**
 * The RGB histogram at the top of the Lightroom panel. It samples the SOURCE preview image
 * once (drawing it tiny to an offscreen canvas and reading the pixels — the preview is a
 * same-origin data: URL, so the canvas isn't tainted), bins the three channels, and draws
 * them as overlaid area graphs. As Myto moves exposure/contrast the bins are shifted and
 * stretched to approximate the live tonal change — a monitor that MOVES with the edit, not
 * a pixel-exact readout (the FFmpeg bake is the truth). Degrades to an empty frame if the
 * image can't be read.
 */
const BINS = 128
const VW = 190
const VH = 70

type Bins = { r: number[]; g: number[]; b: number[] }

/** Area path across the bins for one channel, normalized to the max bin. */
function areaPath(bins: number[], max: number): string {
  if (max <= 0) return ''
  const n = bins.length
  let d = `M 0 ${VH}`
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * VW
    const y = VH - (bins[i] / max) * VH
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return d + ` L ${VW} ${VH} Z`
}

export function Histogram({ source, live }: { source: string; live: PhotoAdjust | null }): ReactNode {
  const [bins, setBins] = useState<Bins | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Sample the source once per image. Best-effort: any failure leaves an empty histogram.
  useEffect(() => {
    let cancelled = false
    if (!source) {
      setBins(null)
      return
    }
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      try {
        const scale = Math.min(1, 160 / Math.max(1, img.naturalWidth))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = canvasRef.current ?? document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const g = canvas.getContext('2d', { willReadFrequently: true })
        if (!g) return
        g.drawImage(img, 0, 0, w, h)
        const data = g.getImageData(0, 0, w, h).data
        const r = new Array<number>(BINS).fill(0)
        const gg = new Array<number>(BINS).fill(0)
        const b = new Array<number>(BINS).fill(0)
        for (let i = 0; i < data.length; i += 4) {
          r[Math.min(BINS - 1, (data[i] * BINS) >> 8)]++
          gg[Math.min(BINS - 1, (data[i + 1] * BINS) >> 8)]++
          b[Math.min(BINS - 1, (data[i + 2] * BINS) >> 8)]++
        }
        setBins({ r, g: gg, b })
      } catch {
        setBins(null)
      }
    }
    img.onerror = () => {
      if (!cancelled) setBins(null)
    }
    img.src = source
    return () => {
      cancelled = true
    }
  }, [source])

  // Approximate the live tonal move: shift bins by exposure, stretch around mid by contrast.
  const shift = live ? (live.exposure / 100) * 0.18 * BINS : 0
  const cScale = live ? 1 / (1 + (live.contrast / 100) * 0.5) : 1
  const remap = (src: number[]): number[] => {
    if (!shift && cScale === 1) return src
    const out = new Array<number>(BINS).fill(0)
    const mid = BINS / 2
    for (let i = 0; i < BINS; i++) {
      const j = Math.round((i - mid) * cScale + mid - shift)
      if (j >= 0 && j < BINS) out[i] = src[j]
    }
    return out
  }

  const shown = bins ? { r: remap(bins.r), g: remap(bins.g), b: remap(bins.b) } : null
  const max = shown ? Math.max(1, ...shown.r, ...shown.g, ...shown.b) : 1

  return (
    <div className="rounded-md bg-black/30 p-1">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" aria-label="Histogram">
        {shown ? (
          <g style={{ mixBlendMode: 'screen' }}>
            <path d={areaPath(shown.r, max)} fill="#e5484d" opacity="0.65" />
            <path d={areaPath(shown.g, max)} fill="#30a46c" opacity="0.65" />
            <path d={areaPath(shown.b, max)} fill="#4661d6" opacity="0.65" />
          </g>
        ) : (
          <text x={VW / 2} y={VH / 2} textAnchor="middle" className="fill-muted text-[9px]">
            histogram
          </text>
        )}
      </svg>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  )
}
