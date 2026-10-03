import { type ReactNode, useRef } from 'react'
import type { EditorPlayer } from '../hooks/useEditorPlayer'

/**
 * The animated cursor Myto drives across the Lightroom panel (photo) or CapCut timeline
 * (video) while it edits — the visible "watch me work" pointer. It reads the player's
 * unified {@link EditorPlayer.cursorControl} (which semantic control the cursor targets)
 * and {@link EditorPlayer.cursorProgress} (a 0..1 glide), plus the control-ref registry,
 * looks up that control's live DOM rect relative to the editor body, and glides from
 * wherever it last settled to the new control. Purely presentational — it moves no state;
 * the player owns the clock. Hidden once the gesture phase is over (bake/compare).
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function VirtualCursor({
  player,
  bodyRef
}: {
  player: EditorPlayer
  bodyRef: React.RefObject<HTMLDivElement | null>
}): ReactNode {
  const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lastIdRef = useRef<string | null>(null)

  const cursorControl = player.cursorControl
  if (!player.playing || !cursorControl) return null

  const body = bodyRef.current
  const el = player.controls.current.get(cursorControl)
  if (body && el) {
    const b = body.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const target = { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 }
    // A new target freezes the glide's origin at wherever the cursor currently sits.
    if (cursorControl !== lastIdRef.current) {
      originRef.current = posRef.current.x || posRef.current.y ? { ...posRef.current } : target
      lastIdRef.current = cursorControl
    }
    posRef.current = {
      x: lerp(originRef.current.x, target.x, player.cursorProgress),
      y: lerp(originRef.current.y, target.y, player.cursorProgress)
    }
  }

  const { x, y } = posRef.current
  return (
    <div
      className="pointer-events-none absolute z-30 transition-opacity"
      style={{ left: 0, top: 0, transform: `translate(${x}px, ${y}px)` }}
      aria-hidden="true"
    >
      {/* A soft focus ring that pulses on the control, with the arrow pointer over it. */}
      <div className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-primary/25 ring-2 ring-primary/60" />
      <svg width="20" height="22" viewBox="0 0 20 22" className="relative drop-shadow-md">
        <path
          d="M2 2l6 16 2.2-6.4L16.6 10 2 2z"
          fill="white"
          stroke="black"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
