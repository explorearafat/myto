/**
 * StatusWidget — the whole contents of the floating 280×84 card.
 *
 * This renders in its OWN window (see `main/widget.ts`), reached by loading the
 * ordinary renderer bundle at `#/widget`. It therefore shares nothing with the chat
 * UI's stores: it has no run, no session, no workspace. Everything it draws arrives
 * over one channel (`ambient.onStatus`), and everything it does leaves over two
 * (`ambient.focus`, `ambient.stop`) — a deliberately tiny surface, because a window
 * that floats over other applications should not be able to do much.
 *
 * The two things a tray tooltip cannot give you are the reason it exists: a running
 * clock, and buttons. Both are honest — the clock counts from the run's real start
 * stamp and disappears when nothing is running, and "Stop" is forwarded to the chat
 * window (which owns the live runId) rather than reaching into the engine from here.
 */
import { useEffect, useState } from 'react'
import type { AmbientState, AmbientStatus, Theme } from '@shared/types'

/** Dot colour per state. Amber for "your turn"; never red for something fixable. */
const DOT: Record<AmbientState, string> = {
  running: 'bg-primary',
  waiting: 'bg-amber-400',
  done: 'bg-emerald-400',
  failed: 'bg-amber-400',
  idle: 'bg-muted/50'
}

/** The short word above the message — what the state IS, in two words at most. */
const LABEL: Record<AmbientState, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  done: 'Finished',
  failed: 'Stopped',
  idle: 'Idle'
}

const IDLE: AmbientStatus = {
  state: 'idle',
  message: 'Nothing running',
  lane: null,
  agents: 0,
  startedAt: 0,
  runId: null
}

/**
 * `M:SS` (or `H:MM:SS` past an hour) since the run began. Elapsed time is the one
 * number here that must never be invented, so a missing/zero stamp renders nothing.
 */
function elapsedLabel(startedAt: number, now: number): string | null {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const mm = Math.floor(seconds / 60) % 60
  const ss = seconds % 60
  const hh = Math.floor(seconds / 3600)
  const tail = `${String(mm).padStart(hh > 0 ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`
  return hh > 0 ? `${hh}:${tail}` : tail
}

export function StatusWidget() {
  const [status, setStatus] = useState<AmbientStatus>(IDLE)
  const [now, setNow] = useState(() => Date.now())

  // Ask once on mount AND subscribe: the window can open mid-run (the preference is
  // toggled while Sylor is working), and a card that started blank until the next
  // event would be reporting "idle" about a live run.
  useEffect(() => {
    const ambient = window.sylor?.ambient
    if (ambient == null) return
    let live = true
    void ambient.get().then((current) => {
      if (live) setStatus(current)
    })
    const dispose = ambient.onStatus(setStatus)
    return () => {
      live = false
      dispose()
    }
  }, [])

  // The theme is not in this window's state — there is no app store here — so read
  // it from the same persisted settings the chat window uses. Without this the card
  // would render the light palette on a dark desktop.
  useEffect(() => {
    let live = true
    void window.sylor?.providers?.getSettings().then((settings) => {
      const theme: Theme = settings.ui.theme
      if (live) document.documentElement.dataset.theme = theme
    })
    return () => {
      live = false
    }
  }, [])

  const live = status.state === 'running' || status.state === 'waiting'

  // One interval, only while something is running: a ticking clock on an idle card
  // is a wakeup every second for a number that cannot change.
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const elapsed = live ? elapsedLabel(status.startedAt, now) : null

  return (
    <div
      // The whole card is the drag handle (it is a frameless window with no title
      // bar); the buttons opt out below, or they could never be clicked.
      style={{ WebkitAppRegion: 'drag' }}
      className="flex h-screen w-screen select-none flex-col justify-between overflow-hidden border border-border bg-surface px-2.5 py-2 text-text"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${DOT[status.state]} ${
            status.state === 'running' ? 'animate-pulse' : ''
          }`}
          aria-hidden="true"
        />
        <span className="shrink-0 text-[11px] font-medium tracking-tight">
          {LABEL[status.state]}
        </span>
        {status.agents > 0 && (
          <span
            className="shrink-0 rounded bg-surface-2 px-1 font-mono text-[9.5px] text-muted"
            title={`${status.agents} subagent${status.agents === 1 ? '' : 's'} still open`}
          >
            {status.agents}×
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {elapsed != null && (
          <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">{elapsed}</span>
        )}
      </div>

      <p className="truncate text-[11px] leading-snug text-muted" title={status.message}>
        {status.message}
      </p>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' }}>
        <button
          type="button"
          onClick={() => window.sylor?.ambient?.focus(status.lane)}
          title={
            status.lane != null
              ? 'Show Sylor and open the run log on this lane'
              : 'Show Sylor and open the run log'
          }
          className="sylor-press rounded px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => window.sylor?.ambient?.stop()}
          disabled={!live}
          title={live ? 'Ask the run to stop' : 'Nothing is running'}
          className={
            'sylor-press rounded px-1.5 py-0.5 text-[10.5px] transition-colors ' +
            (live
              ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
              : 'cursor-not-allowed text-muted/40')
          }
        >
          Stop
        </button>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 pr-0.5 text-[9.5px] text-muted/50">Sylor</span>
      </div>
    </div>
  )
}
