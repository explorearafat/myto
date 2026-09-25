/**
 * Stream-liveness readout for a running reply.
 *
 * The elapsed clock under a streaming reply (`mm:ss`) counts wall-time from when the
 * reply appeared, so it keeps climbing even after the model has gone completely
 * silent — which reads as "still working" when the stream is actually dead or
 * stalled. That ambiguity is the whole complaint: there was no way to tell a live
 * run from a hung one.
 *
 * The fix is to track the timestamp of the last *real* output (any streamed delta,
 * status caption, reasoning, tool step, or plan update — see useChatStore) and, when
 * the gap since then grows past a threshold, surface an honest note. A genuinely
 * dead network stream is aborted by the main-process stall guard
 * (`providers/http.ts` STREAM_STALL_MS = 60s, in step with {@link STALL_ALARM_MS})
 * and becomes a visible error with a Rewrite, so this note leads right up to that
 * automatic stop — and it never lies: "no new output for Ns" is true whether the
 * model stalled or a long tool is running.
 *
 * Pure and side-effect free; unit-tested in liveness.test.ts.
 */

/** Idle time (ms with no new output) after which we start showing a liveness note. */
export const STALL_WARN_MS = 15_000

/** Idle time (ms) after which the note escalates from "still working" to a stall warning. */
export const STALL_ALARM_MS = 60_000

/**
 * The liveness note to show under a still-streaming reply, or null when output is
 * flowing normally (idle below {@link STALL_WARN_MS}). `idleMs` is `now - activityAt`
 * where `activityAt` is the last time the run produced anything.
 *
 * - below warn: null (the plain elapsed/token meta is enough)
 * - warn..alarm: a calm "still working" reassurance with the quiet duration
 * - past alarm: a clear "may have stalled" warning. For a dead model stream this is
 *   the last note before the 60s guard auto-stops the run (→ error + Rewrite); during
 *   a long tool step (no active stream) it stays put, honestly, until the tool ends.
 */
export function livenessNote(idleMs: number): string | null {
  if (idleMs < STALL_WARN_MS) return null
  const s = Math.floor(idleMs / 1000)
  if (idleMs >= STALL_ALARM_MS) return `no new output for ${s}s — the model may have stalled`
  return `still working · no new output for ${s}s`
}
