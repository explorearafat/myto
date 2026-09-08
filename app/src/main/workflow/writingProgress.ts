import type { WorkflowEvent } from '../../shared/types'

/**
 * Live proof-of-life for the documents a staged turn writes before any code.
 *
 * The audit, the specification and the phase plan are *collected* completions —
 * nothing they produce is streamed to the user, and at high reasoning effort one
 * of them can run for many minutes. The status row is sticky, so for that whole
 * stretch it kept reading `Phase 1 of 9 — Discovery and foundation`: a line that
 * describes where the build stands, not what is happening now. A user watching a
 * frozen label and a climbing timer has no way to tell a long generation from a
 * dead request, which is the single most alarming thing this app could do.
 *
 * So the row now names the document being written and counts what has actually
 * arrived. Every number comes from bytes already received, so it can only ever
 * report real progress: a stalled request stops moving instead of narrating.
 */

/** Shortest gap between two progress lines. A counter that ticks faster than this reads as noise. */
const THROTTLE_MS = 1_200

/** Below this, "0.3k characters" is less informative than the label on its own. */
const MIN_CHARS = 400

/** A markdown `## ` heading — the unit a phase plan or an audit is written in. */
const SECTION_RE = /^##\s+\S/gm

/**
 * Renders what has arrived so far: sections once the document has any, characters
 * until then. Null while there is too little to be worth a line of its own.
 */
export function writingSummary(text: string): string | null {
  const sections = text.match(SECTION_RE)?.length ?? 0
  if (sections > 0) return `${sections} section${sections === 1 ? '' : 's'}`
  if (text.length < MIN_CHARS) return null
  return `${(text.length / 1000).toFixed(1)}k characters`
}

export interface WritingProgress {
  /** Hand to {@link collectCompletion}; re-labels the status row as text arrives. */
  onProgress: (text: string) => void
  /** Stop reporting (the call returned, failed, or was cancelled). */
  stop: () => void
}

/**
 * Reports a document call in flight on the run's status row.
 *
 * Emits `label` immediately — the row should name the work before the first byte
 * arrives — then re-emits it with a count, at most every {@link THROTTLE_MS} and
 * only when that count has actually changed. `stop()` makes every later chunk a
 * no-op, so a retry's replayed stream can't narrate over the next stage.
 *
 * @param stage The workflow stage to report under; these calls all happen while planning.
 */
export function writingProgress(args: {
  runId: string
  label: string
  emit: (event: WorkflowEvent) => void
  stage?: 'understanding' | 'planning'
  now?: () => number
}): WritingProgress {
  const { runId, label, emit, stage = 'planning', now = Date.now } = args
  let last = now()
  let shown = ''
  let stopped = false

  emit({ type: 'status', runId, stage, message: label })

  return {
    onProgress: (text) => {
      if (stopped) return
      const at = now()
      if (at - last < THROTTLE_MS) return
      const summary = writingSummary(text)
      if (!summary || summary === shown) return
      last = at
      shown = summary
      emit({ type: 'status', runId, stage, message: `${label} ${summary}` })
    },
    stop: () => {
      stopped = true
    }
  }
}
