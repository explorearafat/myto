import { useEffect, useState } from 'react'
import type { CallStatusEvent } from '@shared/types'

/**
 * A slim status pill under the title bar while a voice call is live — the
 * desktop's one-glance "Myto is on a call" signal. The call session itself
 * lives in main; this only mirrors its lifecycle.
 */
export function CallIndicator(): React.ReactNode {
  const [status, setStatus] = useState<CallStatusEvent>({ state: 'idle' })
  const [since, setSince] = useState<number>(0)
  const [now, setNow] = useState<number>(0)

  useEffect(() => {
    const unsubscribe = window.myto.call.onStatus((event) => {
      setStatus(event)
      if (event.state === 'active') setSince(Date.now())
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (status.state !== 'active') return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [status.state])

  if (status.state !== 'active' && status.state !== 'connecting') return null

  const elapsed = Math.max(0, Math.floor((now - since) / 1000))
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div className="pointer-events-none flex justify-center">
      <div className="absolute top-1 z-50 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-secondary shadow-sm">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        {status.state === 'connecting' ? (
          <span>Connecting a voice call…</span>
        ) : (
          <span>
            On a call <span className="tabular-nums">{mmss}</span> · answers on your phone
          </span>
        )}
      </div>
    </div>
  )
}
