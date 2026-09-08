/**
 * RunLog — the timestamped trace of everything the harness did this turn.
 *
 * This is the *opt-in* companion to the chat pane's single evolving status row,
 * not a replacement for it: the chat stays a conversation (prose, tool cards, one
 * live status line), and anyone who wants the receipts opens this instead. It is
 * why the accumulating checklist that once cluttered the thread is gone yet the
 * detail it carried is still reachable.
 *
 * It renders `activity` — the store's flat, append-ordered, per-row-attributed
 * event list — and nothing else: each row links to the {@link ToolCardUI} /
 * {@link AgentCardUI} that already holds the payload, so expanding a row reuses
 * `ToolCardDetail` rather than re-rendering a second copy of the same markup.
 *
 * Honesty rules it keeps:
 *  - a row restored from an op recorded before timing existed shows `--:--:--`
 *    and no duration, never a fabricated one;
 *  - a duration appears only when both stamps are present;
 *  - a row is dimmed as "done" only when the engine actually closed it, so a
 *    still-spinning phase reads as still spinning.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  useChatStore,
  type ActivityStep,
  type AgentCardUI,
  type ToolCardUI
} from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import { ToolCardDetail } from '@renderer/components/ChatPanel'
import { formatClock, formatDuration } from '@renderer/lib/duration'
import { LEAD, lanesOf, type Lane } from '@renderer/lib/lanes'

/** The glyph that opens a row's kind — a shape, so the log scans vertically. */
function kindGlyph(step: ActivityStep): string {
  switch (step.kind) {
    case 'tool':
      return '▸'
    case 'agent':
      return '⌥'
    case 'plan':
      return '≡'
    case 'question':
      return '?'
    case 'followup':
      return '⚑'
    case 'run-end':
      // Only an explicit success is a filled dot. A cancelled run reports no
      // outcome at all, and calling that "finished" would overstate it — the
      // square reads as "stopped here", which is all we actually know.
      return step.ok === true ? '●' : '■'
    default:
      return '·'
  }
}

/** Small state pill for a subagent lane chip. Null state renders nothing. */
function LaneDot({ state, cancelling }: { state: Lane['state']; cancelling?: boolean }) {
  if (state == null) return null
  const cls = cancelling
    ? 'animate-pulse bg-amber-400'
    : state === 'running'
      ? 'animate-pulse bg-primary'
      : state === 'failed'
        ? 'bg-amber-400/80'
        : 'bg-emerald-500'
  return <span className={'h-1.5 w-1.5 shrink-0 rounded-full ' + cls} aria-hidden="true" />
}

export function RunLog() {
  const activity = useChatStore((s) => s.activity)
  const tools = useChatStore((s) => s.tools)
  const agents = useChatStore((s) => s.agents)
  const running = useChatStore((s) => s.running)
  const cancelAgent = useChatStore((s) => s.cancelAgent)

  /** Which lane is being shown, or null for all of them. Shared, because the
   *  command palette can jump straight to a lane (see the store's `showLane`). */
  const lane = useAppStore((s) => s.logLane)
  const setLane = useAppStore((s) => s.setLogLane)
  /**
   * The one expanded row. Single-open on purpose: an expanded write row mounts a
   * Monaco diff editor, and letting every row hold one at once would put a dozen
   * editors in a 42%-wide panel.
   */
  const [openId, setOpenId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** Whether the view is parked at the bottom, so new rows should follow. */
  const pinnedRef = useRef(true)

  const lanes = useMemo(() => lanesOf(activity, agents), [activity, agents])
  const rows = useMemo(
    () => (lane == null ? activity : activity.filter((s) => (s.agentId ?? LEAD) === lane)),
    [activity, lane]
  )

  const toolById = useMemo(() => {
    const map = new Map<string, ToolCardUI>()
    for (const card of tools) map.set(card.id, card)
    return map
  }, [tools])
  const agentById = useMemo(() => {
    const map = new Map<string, AgentCardUI>()
    for (const card of agents) map.set(card.agentId, card)
    return map
  }, [agents])

  // A lane that stops existing (new turn, cleared trace) must not leave the log
  // filtered to nothing — that reads as "no activity" when there is plenty.
  useEffect(() => {
    if (lane != null && !lanes.some((l) => l.key === lane)) setLane(null)
  }, [lane, lanes, setLane])

  // Follow the tail only while parked there, so reading scrollback isn't yanked
  // away by the next row. Layout effect: scroll before the frame is painted.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [rows.length, openId])

  if (activity.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-[15rem]">
          <p className="text-[12px] text-muted">Nothing has run yet.</p>
          <p className="mt-1 text-[11px] text-muted/70">
            Send a message and every step — files read, diffs applied, commands run,
            subagents spawned — shows up here with the time it happened.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The lane strip only earns its space once a subagent has actually run. */}
      {lanes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
          <button
            type="button"
            onClick={() => setLane(null)}
            className={
              'sylor-press rounded px-1.5 py-0.5 text-[10.5px] transition-colors ' +
              (lane == null ? 'bg-surface-2 text-text' : 'text-muted hover:text-text')
            }
          >
            All
          </button>
          {lanes.map((l) => (
            <span
              key={l.key}
              className={
                'flex items-center gap-1 rounded text-[10.5px] transition-colors ' +
                (lane === l.key ? 'bg-surface-2 text-text' : 'text-muted')
              }
            >
              <button
                type="button"
                onClick={() => setLane(l.key)}
                title={
                  `${l.label} · ${l.count} step${l.count === 1 ? '' : 's'}` +
                  (l.current ? `\n${l.current}` : '')
                }
                className="sylor-press flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-text"
              >
                <LaneDot state={l.state} cancelling={l.cancelling} />
                <span className="max-w-[7rem] truncate">{l.label}</span>
                {l.cancelling ? (
                  <span className="font-mono text-[9.5px] text-amber-300/80">stopping…</span>
                ) : (
                  <span className="font-mono text-[9.5px] text-muted/70">{l.count}</span>
                )}
              </button>
              {/* Stop just this lane. The run keeps going: the lead gets a report
                  saying it was cancelled and decides what to do without it. */}
              {l.state === 'running' && !l.cancelling && (
                <button
                  type="button"
                  onClick={() => cancelAgent(l.key)}
                  aria-label={`Stop the ${l.label} subagent`}
                  title={`Stop the ${l.label} subagent — the rest of the run continues`}
                  className="sylor-press mr-0.5 rounded px-1 py-0.5 text-[11px] leading-none text-muted/70 transition-colors hover:bg-amber-500/10 hover:text-amber-300"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
      >
        {rows.map((step) => (
          <LogRow
            key={step.id}
            step={step}
            tool={step.toolId != null ? toolById.get(step.toolId) : undefined}
            agent={
              step.kind === 'agent' && step.agentId != null ? agentById.get(step.agentId) : undefined
            }
            open={openId === step.id}
            onToggle={() => setOpenId((id) => (id === step.id ? null : step.id))}
          />
        ))}

        {/* The trace outlives the turn, so say plainly which state it is in rather
            than leaving the last row ambiguous. */}
        {!running && (
          <div className="px-1.5 pb-1 pt-2 font-mono text-[10px] text-muted/60">
            — end of run —
          </div>
        )}
      </div>
    </div>
  )
}

function LogRow({
  step,
  tool,
  agent,
  open,
  onToggle
}: {
  step: ActivityStep
  tool?: ToolCardUI
  agent?: AgentCardUI
  open: boolean
  onToggle: () => void
}) {
  const took = tool ? formatDuration(tool) : null
  // Only rows with something more to show are clickable; a phase row is the whole
  // fact, and a disclosure arrow on it would promise detail that doesn't exist.
  const detail = tool != null || (agent?.report != null && agent.report !== '')
  const active = !step.done
  const failed = step.ok === false

  const body = (
    <>
      <span className="w-[52px] shrink-0 font-mono text-[10px] text-muted/70 tabular-nums">
        {formatClock(step.at)}
      </span>
      <span
        className={
          'w-3 shrink-0 text-center text-[10px] ' +
          (failed ? 'text-amber-400/90' : active ? 'text-primary' : 'text-muted/60')
        }
        aria-hidden="true"
      >
        {kindGlyph(step)}
      </span>
      <span
        className={
          'min-w-0 flex-1 truncate text-[11.5px] ' +
          (failed ? 'text-amber-300/90' : active ? 'text-text' : 'text-text/70')
        }
      >
        {step.message}
      </span>
      {step.agentId != null && step.agentRole != null && (
        <span className="shrink-0 rounded bg-surface-2 px-1 font-mono text-[9.5px] text-muted">
          {step.agentRole}
        </span>
      )}
      {took && <span className="shrink-0 font-mono text-[9.5px] text-muted/70">{took}</span>}
      {active && (
        <span
          className="h-1 w-1 shrink-0 animate-pulse rounded-full bg-primary"
          aria-label="in progress"
        />
      )}
    </>
  )

  return (
    <div className="border-l border-border/40 pl-1">
      {detail ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors hover:bg-surface-2"
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full items-center gap-1.5 px-1 py-[3px]">{body}</div>
      )}

      {open && tool && (
        <div className="mb-1 ml-[52px]">
          <ToolCardDetail card={tool} />
        </div>
      )}
      {open && !tool && agent?.report && (
        <pre className="mb-1 ml-[52px] max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-text/85">
          {agent.report}
        </pre>
      )}
    </div>
  )
}
