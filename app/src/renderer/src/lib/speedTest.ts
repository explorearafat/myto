// The connection doctor: measure what a model endpoint ACTUALLY delivers —
// time-to-first-token and the visible streaming rate — by running a tiny probe
// completion through the same pipeline real replies use. A slow endpoint is the
// single biggest "Myto is slow" cause (a 2.5 tok/s proxy makes every reply crawl
// no matter how fast the app is), so the number is surfaced honestly: Settings
// shows a tok/s badge per model, colour-coded fast/ok/slow.

import { useAppStore } from '@renderer/store/useAppStore'

export interface SpeedResult {
  modelId: string
  /** ms until the first visible token. */
  ttftMs: number
  /** ms from start to finish (or the 20s probe cap). */
  totalMs: number
  /** Streaming chunks received (≈ tokens for OpenAI-style streams). */
  tokens: number
  /** tokens / second of wall clock. */
  tokensPerSec: number
}

/** Probe cap — a healthy endpoint finishes this in a couple of seconds. */
const PROBE_CAP_MS = 20_000

export function speedVerdict(tokensPerSec: number): 'fast' | 'ok' | 'slow' {
  if (tokensPerSec >= 15) return 'fast'
  if (tokensPerSec >= 5) return 'ok'
  return 'slow'
}

/**
 * Stream one tiny completion against `modelId` and time it. Resolves with the
 * measurement (stored into useAppStore.speedResults for the badge) — the 20s cap
 * guarantees resolution even against a wedged endpoint.
 */
export async function runSpeedTest(modelId: string): Promise<SpeedResult> {
  return new Promise<SpeedResult>((resolve) => {
    const started = Date.now()
    let ttftMs = 0
    let tokens = 0
    let settled = false

    const finish = (cancel: () => void) => {
      if (settled) return
      settled = true
      cancel()
      const totalMs = Date.now() - started
      const result: SpeedResult = {
        modelId,
        ttftMs,
        totalMs,
        tokens,
        tokensPerSec: tokens > 0 && totalMs > 0 ? Math.round((tokens / (totalMs / 1000)) * 10) / 10 : 0,
      }
      useAppStore.getState().setSpeedResult(result)
      resolve(result)
    }

    // The preload hands back the disposer through a promise; guard the race where
    // the probe settles (done/error/cap) before the disposer itself resolves.
    let disposer: (() => void) | null = null
    void window.myto.providers
      .streamCompletion(
        {
          modelId,
          mode: 'chat',
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        },
        (chunk) => {
          if (chunk.delta) {
            if (ttftMs === 0) ttftMs = Date.now() - started
            tokens++
          }
          if (chunk.done || chunk.error) finish(() => disposer?.())
        }
      )
      .then((d) => {
        disposer = d
        if (settled) d()
      })

    window.setTimeout(() => finish(() => disposer?.()), PROBE_CAP_MS)
  })
}
