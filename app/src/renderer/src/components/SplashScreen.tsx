import { useEffect, useState } from 'react'
import { SylorStar } from '@renderer/components/SylorStar'

/** Total time the overlay stays mounted (bloom + hold + fade-out), in ms. */
const SPLASH_LIFETIME_MS = 1900

/**
 * Full-screen opening animation shown on every launch. The Sylor star blooms in (a gentle
 * rotate-in as its rays settle) and the "Sylor" wordmark fades up beneath it — then the overlay
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
      className="sylor-splash pointer-events-none fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-bg"
      aria-hidden="true"
    >
      <div className="sylor-splash__mark">
        <SylorStar size={104} className="sylor-splash__star" />
      </div>

      <div className="sylor-splash__word text-2xl font-semibold tracking-wide text-text">Sylor</div>
    </div>
  )
}
