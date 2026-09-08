/**
 * ambient — one glanceable line about the run, for the surfaces that are not the
 * chat window.
 *
 * The tray tooltip, the taskbar overlay icon and the floating mini widget all read
 * from here, and here reads from exactly one place: the workflow event stream that
 * already crosses to the renderer (`workflow-ipc.ts` calls {@link publishAmbient}
 * from its single sink). So an ambient surface cannot describe a different turn
 * than the chat does, and adding a surface costs a subscription rather than a
 * second path into the engine.
 *
 * Honesty rules it keeps:
 *  - `message` is the engine's own status line. The only sentences written here are
 *    for the states where the truth is "nobody is working on this" — waiting on a
 *    person, finished, failed, nothing yet;
 *  - `waiting` is only set for a decision the user actually has to make: a
 *    pre-approved (`auto`) tool request never claims to be blocked on them;
 *  - `agents` counts open subagent ids, so a duplicate `agent-end` cannot drive it
 *    negative and a lane that never closed is not silently forgotten;
 *  - `startedAt` is 0 whenever no run is live, so a surface showing an elapsed
 *    clock has nothing to draw rather than a stale one.
 *
 * This module is deliberately Electron-free: it is the reducer plus a subscriber
 * list, which makes the whole state machine unit-testable without a window.
 */
import type { AmbientStatus, WorkflowEvent } from '../shared/types'

/** Nothing has run yet. Also what a fresh launch reports. */
export const IDLE_AMBIENT: AmbientStatus = {
  state: 'idle',
  message: 'Nothing running',
  lane: null,
  agents: 0,
  startedAt: 0,
  runId: null
}

/**
 * The fold's carry: the status plus the three things a single event cannot tell you.
 *
 * `roles` remembers what each lane is called, because only `agent-start` announces
 * a role while every later event just carries the id. `live` holds the ids that
 * have opened and not closed, which is what makes `agents` a count of reality
 * rather than a running tally of arrivals and departures. `line` is the last thing
 * the *engine* said it was doing, kept apart from `status.message` because the three
 * blocked states overwrite the message with a sentence written here — and coming back
 * from a block has to restore the engine's own words, not repeat "waiting for you"
 * while the tool it was waiting on is already running.
 */
export interface AmbientTrace {
  status: AmbientStatus
  roles: Map<string, string>
  live: Set<string>
  line: string
}

/** A trace with nothing in it. */
export function newAmbientTrace(): AmbientTrace {
  return { status: IDLE_AMBIENT, roles: new Map(), live: new Set(), line: IDLE_AMBIENT.message }
}

/** The lane an event belongs to: a subagent id, or null for the lead. */
function laneOf(event: WorkflowEvent): string | null {
  return 'agentId' in event && typeof event.agentId === 'string' ? event.agentId : null
}

/**
 * Fold one workflow event into the trace, returning a new one.
 *
 * Events that say nothing about *what is happening* — token deltas, context
 * measurements, checkpoint records — leave the trace untouched, which is why the
 * tray does not flicker once per streamed token.
 */
export function foldAmbient(
  trace: AmbientTrace,
  event: WorkflowEvent,
  now: number = Date.now()
): AmbientTrace {
  const prev = trace.status
  // A new run resets the carry: the previous turn's lanes are gone, and its
  // start time must not be inherited by this one's clock.
  const fresh = prev.runId !== event.runId
  const roles = fresh ? new Map<string, string>() : new Map(trace.roles)
  const live = fresh ? new Set<string>() : new Set(trace.live)
  const startedAt = fresh ? (event.at ?? now) : prev.startedAt
  const lane = laneOf(event)
  /** The engine's last real line, which a fresh run has not spoken yet. */
  const said = fresh ? IDLE_AMBIENT.message : trace.line
  /**
   * The same line, but safe to show while `running`. A tool can be proposed before
   * the engine has said anything (an auto-approved read at the top of a turn), and
   * "Nothing running" under a running dot would contradict itself.
   */
  const working = said === IDLE_AMBIENT.message ? 'Working' : said

  /**
   * Everything an event settles the same way, whatever its kind. `spoken` marks a
   * message that came from the engine, so it becomes the line to return to after a
   * block; the written sentences pass false and leave the last real line intact.
   */
  const carry = (
    state: AmbientStatus['state'],
    message: string,
    spoken: boolean
  ): AmbientTrace => {
    const role = lane != null ? roles.get(lane) : undefined
    return {
      status: {
        state,
        message,
        lane,
        agents: live.size,
        startedAt,
        runId: event.runId,
        ...(role != null ? { role } : {})
      },
      roles,
      live,
      line: spoken ? message : said
    }
  }

  /** A run that has ended: no clock left to run, no open lanes to report. */
  const ended = (state: AmbientStatus['state'], message: string): AmbientTrace => ({
    status: { state, message, lane: null, agents: 0, startedAt: 0, runId: event.runId },
    roles,
    live,
    line: IDLE_AMBIENT.message
  })

  switch (event.type) {
    case 'agent-start': {
      roles.set(event.agentId, event.role)
      live.add(event.agentId)
      return carry('running', event.task, true)
    }

    case 'agent-end': {
      roles.set(event.agentId, event.role)
      live.delete(event.agentId)
      // The lane that just closed is not the lane still working, so the message and
      // the lane it came from both stay put and only the count moves. A run still
      // blocked on the user stays blocked — a subagent finishing does not unblock it.
      if (fresh) return carry('running', event.report || 'Finished', true)
      return {
        status: {
          ...prev,
          runId: event.runId,
          startedAt,
          state: prev.state === 'waiting' ? 'waiting' : 'running',
          agents: live.size
        },
        roles,
        live,
        line: said
      }
    }

    case 'status':
      return carry('running', event.message, true)

    case 'tool-request':
      // Pre-approved by the permission mode: nothing is blocked, so saying the
      // user is being waited on would be a lie. The engine's last status line is
      // still the true one.
      if (event.auto) return carry('running', working, false)
      return carry('waiting', 'Waiting for your go-ahead', false)

    case 'tool-result':
      // Back to work, under whatever the ENGINE last said it was doing — not under
      // the "waiting for you" line, which stopped being true the moment they answered.
      return carry('running', working, false)

    case 'question':
      return carry('waiting', 'Sylor asked you a question', false)

    case 'plan-approval':
      return carry('waiting', 'A plan is waiting for your approval', false)

    case 'done':
      return ended('done', 'Finished')

    case 'error':
      return ended('failed', event.message || 'The run failed')

    default:
      // delta / intent / plan / task-update / todos / followup / agent-message /
      // checkpoint / context: real events, but not news about who is working.
      return trace
  }
}

/** Whether two statuses would draw identically — the redraw gate. */
export function sameAmbient(a: AmbientStatus, b: AmbientStatus): boolean {
  return (
    a.state === b.state &&
    a.message === b.message &&
    a.lane === b.lane &&
    a.role === b.role &&
    a.agents === b.agents &&
    a.startedAt === b.startedAt &&
    a.runId === b.runId
  )
}

/** Everything currently watching the ambient status. */
const listeners = new Set<(status: AmbientStatus) => void>()
let trace = newAmbientTrace()

/** The status as it stands. */
export function ambientStatus(): AmbientStatus {
  return trace.status
}

/**
 * Watch the ambient status. Fires only when the status actually changed, so a
 * subscriber can redraw unconditionally. Returns a disposer.
 */
export function onAmbientStatus(listener: (status: AmbientStatus) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Fold one workflow event in and tell every surface, if anything visible changed.
 *
 * Called from the workflow IPC sink — the same one line every event already passes
 * through — so no emit site has to know the tray exists.
 */
export function publishAmbient(event: WorkflowEvent): void {
  const before = trace.status
  trace = foldAmbient(trace, event)
  // Compared by value, not identity: a fold that recomputes the same line (a
  // repeated status, a tool result mid-read) must not wake the tray.
  if (sameAmbient(trace.status, before)) return
  for (const listener of listeners) {
    try {
      listener(trace.status)
    } catch (error) {
      // One bad surface must not stop the others from being told.
      console.error('[sylor] ambient listener failed:', error)
    }
  }
}

/** Drop every subscriber and forget the run. For teardown and for tests. */
export function resetAmbient(): void {
  listeners.clear()
  trace = newAmbientTrace()
}
