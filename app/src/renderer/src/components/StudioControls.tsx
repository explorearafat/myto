import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import type { CurvePoint } from '@shared/types'

/**
 * Interactive controls for the manual Studio — a draggable {@link Slider} and an editable
 * {@link CurveEditor}. Both are real inputs (pointer + keyboard), unlike the agent-playback
 * panel's display-only versions, and call `onChange` with the new value so the parent store
 * updates and the canvas re-renders live.
 */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** A centered-track slider (−100..100 by default) the user drags; double-click resets to `reset`. */
export function Slider({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  reset = 0,
  onChange,
  format
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  reset?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const t = clamp((clientX - r.left) / r.width, 0, 1)
      const raw = min + t * (max - min)
      onChange(clamp(Math.round(raw / step) * step, min, max))
    },
    [min, max, step, onChange]
  )

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (draggingRef.current) setFromClientX(e.clientX)
    }
    const up = (): void => {
      draggingRef.current = false
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [setFromClientX])

  const pct = ((value - min) / (max - min)) * 100
  const centered = min < 0 && max > 0
  const centerPct = ((0 - min) / (max - min)) * 100
  const display = format ? format(value) : `${value > 0 && centered ? '+' : ''}${Math.round(value)}`

  return (
    <div className="px-2 py-1">
      <div className="mb-0.5 flex items-center justify-between text-[10px]">
        <span className="text-[#9a9a9a]">{label}</span>
        <span className={`font-mono ${value !== reset ? 'text-[#e4e4e4]' : 'text-[#777]'}`}>{display}</span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={(e) => {
          draggingRef.current = true
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          setFromClientX(e.clientX)
        }}
        onDoubleClick={() => onChange(reset)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(clamp(value - step, min, max))
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(clamp(value + step, min, max))
          else if (e.key === 'Home') onChange(min)
          else if (e.key === 'End') onChange(max)
          else return
          e.preventDefault()
        }}
        className="relative h-4 cursor-pointer select-none"
      >
        <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-black/50" />
        {centered && (
          <div className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-[#555]" style={{ left: `${centerPct}%` }} />
        )}
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--studio-accent,#1473e6)]"
          style={centered ? (value >= 0 ? { left: `${centerPct}%`, width: `${pct - centerPct}%` } : { left: `${pct}%`, width: `${centerPct - pct}%` }) : { left: 0, width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--studio-accent,#1473e6)] bg-white shadow"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** The five fixed x-positions the tone-curve nodes sit on (shadows → highlights). */
const CURVE_XS = [0, 0.25, 0.5, 0.75, 1] as const

/** The default identity nodes (y = x) for a fresh RGB curve. */
function identityCurve(): CurvePoint[] {
  return CURVE_XS.map((x) => ({ x, y: x }))
}

/**
 * An editable tone curve: five nodes at fixed x, draggable in y. The parent passes the current
 * points (or undefined for identity) and gets the full five-point array back on each drag — the
 * shape `photo-core`'s `curves` bake and the live canvas both read.
 */
export function CurveEditor({
  points,
  onChange,
  size = 196
}: {
  points: CurvePoint[] | undefined
  onChange: (points: CurvePoint[]) => void
  size?: number
}): ReactNode {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragIdx = useRef<number | null>(null)
  const nodes = points && points.length === 5 ? points : identityCurve()

  const yFromClient = useCallback(
    (clientY: number): number => {
      const el = svgRef.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      return clamp(1 - (clientY - r.top) / r.height, 0, 1)
    },
    []
  )

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const i = dragIdx.current
      if (i == null) return
      const y = yFromClient(e.clientY)
      const next = nodes.map((p, idx) => (idx === i ? { x: p.x, y } : p))
      onChange(next)
    }
    const up = (): void => {
      dragIdx.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [nodes, onChange, yFromClient])

  const path = nodes.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * size} ${(1 - p.y) * size}`).join(' ')

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      className="aspect-square touch-none rounded border border-[#1f1f1f] bg-[#1e1e1e]"
    >
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g} stroke="currentColor" className="text-[#3a3a3a]" strokeWidth="0.5">
          <line x1={g * size} y1={0} x2={g * size} y2={size} />
          <line x1={0} y1={g * size} x2={size} y2={g * size} />
        </g>
      ))}
      <line x1={0} y1={size} x2={size} y2={0} className="text-[#3a3a3a]" stroke="currentColor" strokeWidth="0.5" strokeDasharray="3 3" />
      <path d={path} fill="none" className="text-[var(--studio-accent,#1473e6)]" stroke="currentColor" strokeWidth="1.75" />
      {nodes.map((p, i) => (
        <circle
          key={i}
          cx={p.x * size}
          cy={(1 - p.y) * size}
          r={5}
          className="cursor-ns-resize text-[var(--studio-accent,#1473e6)]"
          fill="white"
          stroke="currentColor"
          strokeWidth="1.75"
          onPointerDown={(e) => {
            dragIdx.current = i
            ;(e.target as Element).setPointerCapture?.(e.pointerId)
          }}
          onDoubleClick={() => onChange(nodes.map((q, idx) => (idx === i ? { x: q.x, y: q.x } : q)))}
        />
      ))}
    </svg>
  )
}
