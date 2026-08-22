/**
 * Reasoning-trace stripper.
 *
 * Some models surface their chain-of-thought inside the *content* channel,
 * wrapped in `<think>…</think>` (or `<thinking>…</thinking>`) tags — DeepSeek-R1,
 * Qwen-QwQ and friends do this when a gateway inlines reasoning instead of using
 * a separate `reasoning_content` field. Left alone, that scratchpad flashes into
 * the chat as if it were the answer.
 *
 * This module removes those tagged spans so only the final answer is shown. It is
 * a *complement* to the system-prompt discipline (which stops the model narrating
 * untagged deliberation in the first place): the prompt handles models that just
 * think out loud, this handles models that emit the trace behind explicit tags.
 *
 * Two shapes:
 *  - {@link ReasoningStripper} — stateful, for the streaming display path. It
 *    holds back a possible partial tag across chunk boundaries so a half-written
 *    `<thin…` never flashes, and drops an unterminated trailing block on flush.
 *  - {@link stripReasoningTags} — pure, for cleaning a fully-buffered string (the
 *    verbatim assistant turn that gets replayed into history).
 *
 * It runs on the *prose* channel — after tool blocks are demuxed out — so a file
 * whose contents legitimately contain the literal text `<think>` (written inside
 * a `sylor-tool` block) is never touched.
 */

const OPEN_MARKERS = ['<think>', '<thinking>']
const CLOSE_MARKERS = ['</think>', '</thinking>']

/** Earliest case-insensitive occurrence of any marker at/after `from`, or null. */
function firstMarker(hay: string, markers: string[], from = 0): { idx: number; len: number } | null {
  const low = hay.toLowerCase()
  let best: { idx: number; len: number } | null = null
  for (const m of markers) {
    const i = low.indexOf(m, from)
    if (i !== -1 && (best === null || i < best.idx)) best = { idx: i, len: m.length }
  }
  return best
}

/**
 * Length of the longest suffix of `buf` that is a case-insensitive prefix of some
 * marker — the tail we must hold back because it might grow into a full marker.
 */
function holdBack(buf: string, markers: string[]): number {
  const low = buf.toLowerCase()
  let hold = 0
  for (const m of markers) {
    const max = Math.min(m.length - 1, low.length)
    for (let h = max; h > hold; h--) {
      if (low.endsWith(m.slice(0, h))) {
        hold = h
        break
      }
    }
  }
  return hold
}

/**
 * Stateful, incremental stripper. Feed it prose `delta`s; it returns the text
 * safe to render now with any `<think>` spans removed. Call {@link flush} at the
 * end to release held-back prose (and discard an unterminated trailing block).
 */
export class ReasoningStripper {
  private buffer = ''
  private inside = false

  /** Feeds a delta; returns the visible prose safe to render now (may be empty). */
  push(delta: string): string {
    this.buffer += delta
    let out = ''
    for (;;) {
      if (!this.inside) {
        const open = firstMarker(this.buffer, OPEN_MARKERS)
        if (!open) {
          const hold = holdBack(this.buffer, OPEN_MARKERS)
          out += this.buffer.slice(0, this.buffer.length - hold)
          this.buffer = this.buffer.slice(this.buffer.length - hold)
          break
        }
        out += this.buffer.slice(0, open.idx)
        this.buffer = this.buffer.slice(open.idx + open.len)
        this.inside = true
      } else {
        const close = firstMarker(this.buffer, CLOSE_MARKERS)
        if (!close) {
          // Still inside the trace: discard everything except a possible partial
          // close-tag tail, which may complete on the next delta.
          this.buffer = this.buffer.slice(this.buffer.length - holdBack(this.buffer, CLOSE_MARKERS))
          break
        }
        this.buffer = this.buffer.slice(close.idx + close.len)
        this.inside = false
      }
    }
    return out
  }

  /** Ends the stream: emits held prose, or drops an unterminated open block. */
  flush(): string {
    if (this.inside) {
      this.buffer = ''
      return ''
    }
    const out = this.buffer
    this.buffer = ''
    return out
  }
}

/**
 * Removes complete `<think>…</think>` / `<thinking>…</thinking>` spans (and a
 * leading unterminated block that runs to the end) from a fully-buffered string.
 * Used to clean the verbatim assistant turn before it is replayed into history,
 * so a stray trace never re-primes the model to keep thinking out loud.
 */
export function stripReasoningTags(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '')
}
