/**
 * Smooth reveal (the typewriter) for streamed assistant prose.
 *
 * Text reaches the chat from two kinds of source, and only one of them looks like
 * typing on its own:
 *
 *  1. A model stream — many small deltas (measured against the user's gateway:
 *     ~15 characters every ~97ms). Appending each one as it lands already reads as
 *     a typewriter, so it must pass through untouched: metering it would only add
 *     lag to the one path that was already right.
 *  2. A whole block at once — the orchestrator's deterministic narration (the
 *     opening note, the roadmap summary, the closing report), a document written
 *     by a collected `getCompletion` rather than a stream, and a provider that
 *     answers without server-sent events. Each of those arrives as ONE delta of a
 *     few hundred to a few thousand characters, so a full paragraph pops onto the
 *     screen in a single frame — which is exactly what "the response doesn't type
 *     out any more" describes.
 *
 * So the queue is drained per tick instead of wholesale: at or below
 * {@link REVEAL_WHOLE_UNDER} characters everything goes at once (case 1 — a token
 * stream never accumulates a backlog and is byte-for-byte unchanged), and above it
 * the drain is geometric — a fixed FRACTION of what is waiting, so a big block
 * starts fast and eases out instead of crawling character by character for
 * seconds. {@link REVEAL_MAX_CHARS} caps the burst so even the first tick of a
 * 4,000-character report is visibly typing rather than a flash.
 *
 * This is presentation only. The store keeps the revealed text as its single
 * source of truth for the assistant turn (so persistence and the offsets tool
 * cards anchor at stay exact), and every anchor point — a tool card, a subagent
 * card, the end of the run — drains the queue completely first.
 */

/**
 * Reveal the whole queue when it is this short or shorter. Sized just above a
 * typical stream delta so live token output passes straight through, and small
 * enough that a metered block still moves at a readable pace.
 */
export const REVEAL_WHOLE_UNDER = 24

/** Fraction of the backlog released per tick (1/6 — a geometric ease-out). */
export const REVEAL_DIVISOR = 6

/**
 * Ceiling per tick. At the store's 66ms cadence this is ~3,000 characters a
 * second: fast enough that a page-long report finishes in about two seconds
 * (nothing feels withheld), slow enough that the eye still reads it as typing —
 * a 300-character paragraph takes ~9 ticks, about 0.6s.
 */
export const REVEAL_MAX_CHARS = 200

/**
 * How many characters of a `queued`-character backlog to reveal on this tick.
 *
 * Always returns at least {@link REVEAL_WHOLE_UNDER} for a non-empty backlog past
 * the passthrough threshold, so the queue provably drains (no fractional crawl,
 * no stall), and never more than is actually waiting.
 */
export function revealCount(queued: number): number {
  if (!Number.isFinite(queued) || queued <= 0) return 0
  if (queued <= REVEAL_WHOLE_UNDER) return queued
  const eased = Math.ceil(queued / REVEAL_DIVISOR)
  return Math.min(Math.max(eased, REVEAL_WHOLE_UNDER), REVEAL_MAX_CHARS, queued)
}

/**
 * Splits `text` into the part to show now and the part still queued, cutting only
 * between whole code points — a cut through a surrogate pair (an emoji is two code
 * units) would render a replacement character for a frame before the other half
 * arrived.
 */
export function takeReveal(text: string): { shown: string; rest: string } {
  let at = revealCount(text.length)
  if (at >= text.length) return { shown: text, rest: '' }
  // Landing on a low surrogate means the cut is inside a pair: take both halves.
  const code = text.charCodeAt(at)
  if (code >= 0xdc00 && code <= 0xdfff) at += 1
  return { shown: text.slice(0, at), rest: text.slice(at) }
}
