import { useState, type ReactNode } from 'react'
import type { ToolSegment } from '../lib/fileBlocks'
import { CodeBody } from './Markdown'

/**
 * Renders one tool round-trip — the call the model made and the result Sylor fed
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

/** Human label for a tool name (falls back to the raw name). */
function toolLabel(name: string | null): string {
  switch (name) {
    case 'web_search':
      return 'Web search'
    case 'web_fetch':
      return 'Fetch page'
    case 'wiki_search':
      return 'Wikipedia'
    case 'run_code':
      return 'Run code'
    default:
      return name ?? 'Tool'
  }
}

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

export function ToolCard({ tool }: { tool: ToolSegment }): ReactNode {
  const [expanded, setExpanded] = useState(false)

  const running = tool.result === null
  const phase = running ? (tool.complete ? 'Running…' : 'Preparing…') : tool.complete ? null : 'Running…'
  const inputText = formatInput(tool.input)

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border/70 bg-surface/40">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="text-muted">
          <ToolGlyph name={tool.name} />
        </span>
        <span className="truncate text-[12px] font-medium text-text">{toolLabel(tool.name)}</span>
        {phase ? (
          <span className="sylor-thinking shrink-0 text-[10px] font-medium">{phase}</span>
        ) : (
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide text-muted">
            done
          </span>
        )}
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
