import { type ReactNode } from 'react'
import type { CurvePoint, PhotoAdjust } from '@shared/types'

/**
 * The tone-curve graph in the Lightroom panel's Curve tab. It draws the identity diagonal
 * plus whatever channel curves the live {@link PhotoAdjust} carries (RGB composite in the
 * foreground, optional per-channel R/G/B tinted behind). While Myto is drawing a channel
 * ({@link draw}), that channel's curve is revealed left-to-right by `progress` via a clip,
 * so the user watches the line being drawn. Pure SVG — points are normalized 0..1.
 */
const W = 190
const H = 150

/** Map normalized points to an SVG polyline path (y flips — 1 is the top). */
function pathFor(points: CurvePoint[]): string {
  if (points.length === 0) return ''
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.x * W).toFixed(1)} ${((1 - p.y) * H).toFixed(1)}`)
    .join(' ')
}

const CHANNEL_STROKE: Record<'rgb' | 'r' | 'g' | 'b', string> = {
  rgb: 'var(--color-text, #e8e8e0)',
  r: '#e5484d',
  g: '#30a46c',
  b: '#4661d6'
}

export function ToneCurve({
  curve,
  draw
}: {
  curve: PhotoAdjust['curve']
  draw: { channel: 'rgb' | 'r' | 'g' | 'b'; progress: number } | null
}): ReactNode {
  const channels: Array<'r' | 'g' | 'b' | 'rgb'> = ['r', 'g', 'b', 'rgb'] // rgb last = on top
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md bg-black/30" aria-label="Tone curve">
      {/* Grid: quarters + the identity diagonal for reference. */}
      {[0.25, 0.5, 0.75].map((f) => (
        <g key={f} stroke="currentColor" className="text-border" strokeWidth="0.5" opacity="0.5">
          <line x1={f * W} y1="0" x2={f * W} y2={H} />
          <line x1="0" y1={f * H} x2={W} y2={f * H} />
        </g>
      ))}
      <line x1="0" y1={H} x2={W} y2="0" stroke="currentColor" className="text-muted" strokeWidth="0.75" strokeDasharray="3 3" />

      {channels.map((ch) => {
        const pts = curve?.[ch]
        if (!pts || pts.length === 0) return null
        const d = pathFor(pts)
        const revealing = draw && draw.channel === ch ? draw.progress : 1
        return (
          <g key={ch} clipPath={revealing < 1 ? `url(#clip-${ch})` : undefined}>
            {revealing < 1 && (
              <defs>
                <clipPath id={`clip-${ch}`}>
                  <rect x="0" y="0" width={revealing * W} height={H} />
                </clipPath>
              </defs>
            )}
            <path d={d} fill="none" stroke={CHANNEL_STROKE[ch]} strokeWidth={ch === 'rgb' ? 2 : 1.25} strokeLinejoin="round" strokeLinecap="round" />
            {pts.map((p, i) => (
              <circle key={i} cx={p.x * W} cy={(1 - p.y) * H} r={ch === 'rgb' ? 2.4 : 1.6} fill={CHANNEL_STROKE[ch]} />
            ))}
          </g>
        )
      })}
    </svg>
  )
}
