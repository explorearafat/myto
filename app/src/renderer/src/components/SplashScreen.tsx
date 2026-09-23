import { useEffect, useState } from 'react'
import { MytoMark } from '@renderer/components/MytoMark'

/** Total time the overlay stays mounted (bloom + hold + fade-out), in ms. */
const SPLASH_LIFETIME_MS = 1900

/**
 * Full-screen opening animation shown on every launch. The Myto star blooms in (a gentle
 * rotate-in as its rays settle) and the "Myto" wordmark fades up beneath it — then the overlay
 * fades out (CSS) and unmounts (timer) to reveal the app. Sits above everything on a warm
 * background that tracks the active theme via `--color-bg`.
 */
export function SplashScreen() {
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setGone(true), SPLASH_LIFETIME_MS)
    return () => clearTimeout(t)
  }, [])

  if (gone) return null

  return (
    <div
      className="myto-splash pointer-events-none fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-bg"
      aria-hidden="true"
    >
      <div className="myto-splash__mark">
        <MytoMark size={104} className="myto-splash__star" />
      </div>

      <div className="myto-splash__word flex flex-col items-center gap-1.5">
        <div className="text-2xl font-semibold tracking-wide text-text">Myto</div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
          Build · Chat · Cowork
        </div>
      </div>
    </div>
  )
}
