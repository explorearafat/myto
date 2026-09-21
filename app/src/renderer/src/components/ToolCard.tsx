import { useState, type ReactNode } from 'react'
import { basename, type ToolSegment } from '../lib/fileBlocks'
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

/**
 * A friendly, present-tense headline for a tool round-trip — what Sylor is doing,
 * with the target when there is one (e.g. "Creating ai-news.pdf", "Running python
 * code"). This is the ONLY thing shown by default; the file's contents / diff stay
 * behind the collapsed body, so the transcript reads as activity, not a data dump.
 */
function toolHeadline(tool: ToolSegment): string {
  const input = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : {}
  const path = typeof input.path === 'string' ? input.path : ''
  const name = basename(path)
  switch (tool.name) {
    case 'write_file':
      return name ? `Creating ${name}` : 'Creating file'
    case 'edit_file':
      return name ? `Editing ${name}` : 'Editing file'
    case 'read_file':
      return name ? `Reading ${name}` : 'Reading file'
    case 'delete_file':
      return name ? `Deleting ${name}` : 'Deleting file'
    case 'list_dir':
      return path && path !== '.' ? `Listing ${path}` : 'Listing folder'
    case 'preview': {
      const url = typeof input.url === 'string' ? input.url : ''
      if (name) return `Showing ${name} in preview`
      if (url) return `Opening ${url} in preview`
      return 'Opening preview'
    }
    case 'run_code': {
      const lang = typeof input.language === 'string' ? input.language : ''
      return lang ? `Running ${lang} code` : 'Running code'
    }
    case 'run_command': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      return cmd ? `Running ${cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd}` : 'Running command'
    }
    case 'search_code': {
      const query = typeof input.query === 'string' ? input.query : ''
      return query ? `Searching for “${query.length > 32 ? `${query.slice(0, 32)}…` : query}”` : 'Searching code'
    }
    case 'find_files': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      return pattern ? `Finding ${pattern}` : 'Finding files'
    }
    case 'spawn_agent':
      return 'Delegating to a sub-agent'
    case 'web_search':
      return 'Web search'
    case 'web_fetch':
      return 'Fetch page'
    case 'wiki_search':
      return 'Wikipedia'
    default:
      return tool.name ?? 'Tool'
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

export function ToolCard({ tool, cowork = false }: { tool: ToolSegment; cowork?: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false)

  // update_plan has no card of its own — its whole purpose is the live PlanPanel
  // that AssistantMessage pins above the reply, so a tool card here would just
  // duplicate it. Render nothing.
  if (tool.name === 'update_plan') return null

  const running = tool.result === null
  const phase = running ? (tool.complete ? 'Running…' : 'Preparing…') : tool.complete ? null : 'Running…'

  // Cowork filesystem tools render as a quiet, borderless one-liner — no expand,
  // no content dump. Code writes just show +added / -removed on the right; the
  // richer bordered/expandable card below is reserved for the normal chat tools.
  if (FS_TOOLS.has(tool.name ?? '')) {
    const counts = diffCounts(tool)
    return (
      <div className="my-1.5 flex items-center gap-2 text-[12px]">
        <span className="shrink-0 text-muted">
          <ToolGlyph name={tool.name} />
        </span>
        <span className="truncate font-medium text-text">{toolHeadline(tool)}</span>
        {phase && <span className="sylor-thinking shrink-0 text-[10px] font-medium">{phase}</span>}
        <span className="flex-1" />
        {counts && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-green-500">+{counts.add}</span>{' '}
            <span className="text-red-500">-{counts.del}</span>
          </span>
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
