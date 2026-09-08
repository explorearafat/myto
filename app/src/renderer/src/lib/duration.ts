/**
 * Wall-clock formatting for the harness surfaces (tool cards, Run Log).
 *
 * Both helpers return null rather than a placeholder when the underlying stamp is
 * missing, so callers decide how absence reads in their own layout — and neither
 * ever invents a number. Ops recorded before the timing columns existed (schema
 * < 9) carry no stamps at all, and showing them as "0ms" at "00:00:00" would be a
 * lie about work nobody measured.
 */

/** A timed operation: both stamps are wall-clock ms, both optional. */
export interface Timed {
  startedAt?: number
  endedAt?: number
}

/**
 * How long an op took, e.g. `"820ms"` / `"3.4s"` / `"1m 07s"`. Null when either
 * stamp is missing or the pair is nonsensical (end before start), which is the
 * signal to render nothing at all.
 */
export function formatDuration(op: Timed): string | null {
  const { startedAt, endedAt } = op
  if (startedAt == null || endedAt == null) return null
  const ms = endedAt - startedAt
  if (ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${String(secs).padStart(2, '0')}s`
}

/**
 * A 24-hour `HH:MM:SS` clock for a log row. `0` (and anything non-positive) is
 * the documented sentinel for "this row was restored from an op with no stamp",
 * and renders as `--:--:--` — the column stays aligned without claiming a time.
 */
export function formatClock(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '--:--:--'
  return new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
