import { memo, useEffect, useState, type ReactNode } from 'react'
import { basename, toolHeadline, type ToolSegment } from '../lib/fileBlocks'
import { CodeBody } from './Markdown'
import { DiffView } from './DiffView'
import { useChatStore } from '../store/useChatStore'

/**
 * Renders one tool round-trip — the call the model made and the result Myto fed
 * back — as a compact card in the transcript, mirroring {@link FileCard}. The
 * header shows a per-tool glyph, a friendly label, and a phase pill; the body
 * (collapsed by default) shows the call input as JSON and the result text.
 *
 * The phase is derived from the segment the parser hands us: a call whose closing
 * fence hasn't arrived is still "Preparing", a closed call with no result yet is
 * "Running", and once the result block arrives the card settles. Purely
 * presentational — the raw blocks in the reply are what get persisted, so a reload
 * re-renders the same card.
 */

/** A small glyph per tool family. */
function ToolGlyph({ name }: { name: string | null }): ReactNode {
  const common = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true } as const
  const stroke = { stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  if (name === 'web_search' || name === 'wiki_search') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="4.25" {...stroke} />
        <path d="M10.5 10.5L14 14" {...stroke} />
      </svg>
    )
  }
  if (name === 'web_fetch') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" {...stroke} />
        <path d="M2 8h12M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14M8 2C6.2 3.6 5.2 5.8 5.2 8S6.2 12.4 8 14" {...stroke} />
      </svg>
    )
  }
  if (name === 'run_code') {
    return (
      <svg {...common}>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" {...stroke} />
        <path d="M4.5 6.5L6.5 8.5 4.5 10.5M8 10.5h3.5" {...stroke} />
      </svg>
    )
  }
  if (name === 'list_dir') {
    return (
      <svg {...common}>
        <path d="M1.75 4.5A1 1 0 0 1 2.75 3.5h3l1.5 1.5h5.25a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-8Z" {...stroke} />
      </svg>
    )
  }
  if (name === 'preview') {
    return (
      <svg {...common}>
        <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" {...stroke} />
        <path d="M1.75 5.75h12.5" {...stroke} />
        <circle cx="3.9" cy="4.4" r="0.4" fill="currentColor" />
      </svg>
    )
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'read_file' || name === 'delete_file') {
    return (
      <svg {...common}>
        <path d="M9 1.75H4a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.75L9 1.75Z" {...stroke} />
        <path d="M9 1.75V5.75h4" {...stroke} />
      </svg>
    )
  }
  if (name === 'search_code' || name === 'find_files') {
    return (
      <svg {...common}>
        <circle cx="6.75" cy="6.75" r="4" {...stroke} />
        <path d="M10 10l3.25 3.25" {...stroke} />
      </svg>
    )
  }
  if (name === 'run_command') {
    return (
      <svg {...common}>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" {...stroke} />
        <path d="M4.25 6l2 2-2 2M7.75 10.25h3.5" {...stroke} />
      </svg>
    )
  }
  if (name === 'run_dev_server') {
    return (
      <svg {...common}>
        <rect x="2" y="2.5" width="12" height="4.5" rx="1" {...stroke} />
        <rect x="2" y="9" width="12" height="4.5" rx="1" {...stroke} />
        <path d="M4.25 4.75h0.01M4.25 11.25h0.01" {...stroke} />
      </svg>
    )
  }
  if (name === 'spawn_agent') {
    return (
      <svg {...common}>
        <circle cx="4" cy="4" r="1.75" {...stroke} />
        <circle cx="11.5" cy="5" r="1.75" {...stroke} />
        <circle cx="8" cy="12" r="1.75" {...stroke} />
        <path d="M5.4 5.1 8 10.4M10.3 6.4 8.4 10.6" {...stroke} />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path
        d="M10.6 3.2a2.6 2.6 0 0 0-3.3 3.3l-4.4 4.4a1 1 0 1 0 1.4 1.4l4.4-4.4a2.6 2.6 0 0 0 3.3-3.3l-1.4 1.4-1.4-.4-.4-1.4 1.4-1.4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The Cowork tools rendered as quiet, borderless activity lines (fs + search + preview). */
const FS_TOOLS = new Set([
  'write_file',
  'edit_file',
  'read_file',
  'list_dir',
  'delete_file',
  'preview',
  'search_code',
  'find_files'
])

/**
 * Tools rendered as a single borderless, continuous-tense line ("Asking you",
 * "Clicking", "Reading page") — no border, no chevron, no "Running…" pill. The verb
 * just blinks while the step is live and settles to a steady muted line when done.
 */
const ACTIVITY_TOOLS = new Set([
  'ask_user',
  'browser_navigate',
  'browser_snapshot',
  'browser_read',
  'browser_click',
  'browser_type'
])

/**
 * Lines added / removed for a file-authoring call, computed from the call input
 * (never the content itself). write_file counts the whole body as additions;
 * edit_file counts the new vs old snippet. Null for anything that isn't a diff.
 */
function diffCounts(tool: ToolSegment): { add: number; del: number } | null {
  const input = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : null
  if (!input) return null
  const lines = (s: string): number => (s === '' ? 0 : s.split('\n').length)
  if (tool.name === 'write_file' && typeof input.content === 'string') {
    return { add: lines(input.content), del: 0 }
  }
  if (tool.name === 'edit_file' && typeof input.old === 'string' && typeof input.new === 'string') {
    return { add: lines(input.new), del: lines(input.old) }
  }
  return null
}

/** Pretty-print the call input; a raw string (malformed JSON) passes through as-is. */
function formatInput(input: unknown): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function ToolCardInner({
  tool,
  cowork = false,
  pending = false
}: {
  tool: ToolSegment
  cowork?: boolean
  /** Whether the reply this card belongs to is still streaming. A tool with no
   *  result only reads as "running" while this is true; once the turn ends, an
   *  unresolved call settles to a static "Stopped" instead of a stuck spinner. */
  pending?: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const sessionId = useChatStore((s) => s.sessionId)
  // The pre-overwrite bytes for a write_file diff base (#5), fetched lazily on
  // expand. edit_file already carries both sides on the segment, so only write_file
  // needs this; null → a fresh create, which shows an all-additions view.
  const [snapBefore, setSnapBefore] = useState<string | null>(null)

  const running = tool.result === null
  const input = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : null
  const isWrite = tool.name === 'write_file'
  const content = isWrite && input && typeof input.content === 'string' ? input.content : ''

  // Fetch the pre-overwrite bytes only when a completed write card is opened (#5):
  // an overwrite then diffs old→new; a fresh create keeps its all-additions view.
  // Content-addressed so the card's relative path needn't match the snapshot's.
  useEffect(() => {
    if (!expanded || !isWrite || running || content === '' || sessionId == null) {
      setSnapBefore(null)
      return
    }
    let alive = true
    void window.myto.sessions.snapshotBefore(sessionId, content).then((b) => {
      if (alive) setSnapBefore(b)
    })
    return () => {
      alive = false
    }
  }, [expanded, isWrite, running, content, sessionId])

  // update_plan has no card of its own — its whole purpose is the live PlanPanel
  // that AssistantMessage pins above the reply, so a tool card here would just
  // duplicate it. Render nothing.
  if (tool.name === 'update_plan') return null

  // A tool with no result is "running" only while the turn is still live. Once the
  // turn ends (finished or stopped), an unresolved call was cut off mid-flight — so
  // show a quiet, static "Stopped" rather than a spinner that never settles. This is
  // the fix for the "Running…" badge that used to stick forever after Stop / reload.
  const phaseLive = running && pending
  const phase = !running ? null : phaseLive ? (tool.complete ? 'Running…' : 'Preparing…') : 'Stopped'
  const phaseClass = (phaseLive ? 'myto-thinking ' : 'text-muted ') + 'shrink-0 text-[10px] font-medium'

  // ask_user + the browser tools: one borderless, continuous-tense line that blinks
  // until the step completes, then settles. No border, no chevron, no "Running…".
  if (ACTIVITY_TOOLS.has(tool.name ?? '')) {
    return (
      <div className="myto-step-in my-1.5">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="shrink-0 text-muted">
            <ToolGlyph name={tool.name} />
          </span>
          <span className={phaseLive ? 'myto-thinking font-medium' : 'font-medium text-muted'}>
            {toolHeadline(tool)}
          </span>
        </div>
      </div>
    )
  }

  // Cowork filesystem tools render as a quiet, borderless one-liner — no expand,
  // no content dump. Code writes just show +added / -removed on the right; the
  // richer bordered/expandable card below is reserved for the normal chat tools.
  if (FS_TOOLS.has(tool.name ?? '')) {
    // Once an overwrite's pre-change bytes have loaded, the badge shows the real
    // −removed (old line count) rather than write_file's default all-additions.
    const counts =
      isWrite && snapBefore != null
        ? { add: content === '' ? 0 : content.split('\n').length, del: snapBefore === '' ? 0 : snapBefore.split('\n').length }
        : diffCounts(tool)
    const fileName = input && typeof input.path === 'string' ? basename(input.path) : ''
    const isFileWrite = tool.name === 'write_file' || tool.name === 'edit_file'
    // While it streams, show the reason-style action ("Creating index.html"); once the
    // write lands, collapse to the bare filename ("index.html") beside its +N −N.
    const label = !running && isFileWrite && fileName ? fileName : toolHeadline(tool)

    // A completed file write expands to an inline diff (#5): edit_file diffs old→new
    // from the segment; write_file diffs the fetched pre-overwrite bytes → new body
    // (falling back to all-additions when it was a fresh create / not yet loaded).
    const oldText = isWrite
      ? (snapBefore ?? '')
      : tool.name === 'edit_file' && typeof input?.old === 'string'
        ? input.old
        : ''
    const newText = isWrite
      ? content
      : tool.name === 'edit_file' && typeof input?.new === 'string'
        ? input.new
        : ''
    const canDiff = !running && isFileWrite && (oldText !== '' || newText !== '')

    return (
      <div className="myto-step-in my-1.5">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="shrink-0 text-muted">
            <ToolGlyph name={tool.name} />
          </span>
          {canDiff ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="truncate font-medium text-text hover:underline">{label}</span>
              {phase && <span className={phaseClass}>{phase}</span>}
              <span className="flex-1" />
              {counts && (
                <span className="shrink-0 font-mono text-[11px]">
                  <span className="text-green-500">+{counts.add}</span>{' '}
                  <span className="text-red-500">-{counts.del}</span>
                </span>
              )}
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className={'shrink-0 text-muted transition-transform ' + (expanded ? 'rotate-180' : '')}
              >
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <>
              <span className="truncate font-medium text-text">{label}</span>
              {phase && <span className={phaseClass}>{phase}</span>}
              <span className="flex-1" />
              {counts && (
                <span className="shrink-0 font-mono text-[11px]">
                  <span className="text-green-500">+{counts.add}</span>{' '}
                  <span className="text-red-500">-{counts.del}</span>
                </span>
              )}
            </>
          )}
        </div>
        {canDiff && expanded && (
          <div className="mt-1.5 overflow-hidden rounded-md border border-border/60">
            <DiffView oldText={oldText} newText={newText} />
          </div>
        )}
      </div>
    )
  }

  const inputText = formatInput(tool.input)

  // In a Cowork turn there is no card border/background — just a quiet expandable
  // row (the user still taps to see run_code output / web results). The bordered
  // card is reserved for the normal chat section.
  return (
    <div
      className={
        cowork
          ? 'my-2 overflow-hidden'
          : 'my-3 overflow-hidden rounded-lg border border-border/70 bg-surface/40'
      }
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="text-muted">
          <ToolGlyph name={tool.name} />
        </span>
        <span className="truncate text-[12px] font-medium text-text">{toolHeadline(tool)}</span>
        {/* A live phase ("Running…") shows while the turn streams; once the result
            is in the badge disappears, and a call left unresolved after the turn
            ends settles to a static "Stopped" — never a lingering spinner. */}
        {phase && <span className={phaseClass}>{phase}</span>}
        <span className="flex-1" />
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={'shrink-0 text-muted transition-transform ' + (expanded ? 'rotate-180' : '')}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-border/70">
          {inputText && (
            <div>
              <div className="px-2.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">Request</div>
              <CodeBody code={inputText} lang="json" />
            </div>
          )}
          {tool.result !== null && (
            <div>
              <div className="px-2.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">Result</div>
              <CodeBody code={tool.result} lang="" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Memoized export: a streaming reply re-parses its segments every tick (~15×/s),
 * handing each card a fresh ToolSegment object even when nothing it displays
 * changed. The comparator compares only what the card renders — name, phase
 * inputs, result — by value (string === is a fast memcmp) plus a key/length
 * fingerprint of the input, so a growing write_file body still re-renders (its
 * live +N badge advances) without ever stringifying megabytes of JSON.
 */
export const ToolCard = memo(ToolCardInner, (a, b) => {
  if (a.cowork !== b.cowork || a.pending !== b.pending) return false
  const at = a.tool
  const bt = b.tool
  if (at === bt) return true
  if (at.name !== bt.name || at.complete !== bt.complete) return false
  if (at.result !== bt.result) return false
  return inputFingerprint(at.input) === inputFingerprint(bt.input)
})

/** Cheap shape fingerprint of a tool input: sorted keys + value kind/length. */
function inputFingerprint(input: unknown): string {
  if (input === null || input === undefined) return String(input)
  if (typeof input !== 'object') return `${typeof input}:${String(input).length}`
  const rec = input as Record<string, unknown>
  return Object.keys(rec)
    .sort()
    .map((k) => {
      const v = rec[k]
      return typeof v === 'string' ? `${k}:${v.length}` : `${k}:${typeof v}`
    })
    .join('|')
}
