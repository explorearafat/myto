import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SVGProps
} from 'react'
import { DiffEditor } from '@monaco-editor/react'
import {
  useChatStore,
  type ActivityStatus,
  type AgentCardUI,
  type ChatMessageUI,
  type OutgoingAttachment,
  type RunProgressUI,
  type ToolCardUI
} from '../store/useChatStore'
import { useSessionStore } from '../store/useSessionStore'
import { useAppStore } from '../store/useAppStore'
import { Markdown } from './Markdown'
import { ZeroStateDashboard } from './ZeroState'
import { ModelSelector, EffortSelector, ModeSelector, PlanFirstToggle } from './ModelSelector'
import { monacoThemeFor, languageForPath } from '../lib/monaco-theme'
import { lineDiffStats, estimateTokens, formatCount } from '../lib/diff-stats'
import { formatDuration } from '../lib/duration'
import { threadCards } from '../lib/threadCards'
import type {
  AgentRole,
  Attachment,
  ContextUsage,
  Followup,
  PendingPlan,
  PendingQuestion,
  TodoItem,
  ToolDecision,
  ToolDecisionDetail,
  ToolProposal,
  WorkflowStage
} from '@shared/types'
import { CHARS_PER_TOKEN } from '@shared/context-window'
import { parseSlash } from '@shared/commands'
import {
  buildSlashItems,
  loadSlashSources,
  NO_SLASH_SOURCES,
  type SlashItem as SlashItemShape,
  type SlashSources
} from '../lib/slashSources'
import { startRun } from '../lib/startRun'
import { buildFollowupPrompt } from '@shared/followups'
import { describeStandingKey, standingApprovalLabel } from '@shared/approvals'

/** Human-readable byte size for an attachment chip (e.g. "12.4 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Whether a file's bytes can usefully be inlined as text for the engine. */
function isTextLike(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true
  if (/^application\/(json|xml|javascript|typescript|x-sh|x-yaml|yaml|toml)$/.test(mime))
    return true
  // Fall back on the extension when the OS reports a vague/empty mime.
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return [
    'txt',
    'md',
    'markdown',
    'json',
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'css',
    'html',
    'htm',
    'yml',
    'yaml',
    'py',
    'sh',
    'bash',
    'xml',
    'csv',
    'toml',
    'ini',
    'cfg',
    'conf',
    'log',
    'env'
  ].includes(ext)
}

/** Read a browser File as base64 (without the `data:<mime>;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** A file staged in the composer, already stored (pending, no message yet). */
interface PendingAttachment {
  attachment: Attachment
  /** Data URL for an image thumbnail (images only). */
  thumbnailUrl?: string
  /** Decoded body for text-like files, inlined into the engine history. */
  textContent?: string
}

/** Presentational attachment chip: image thumb or file pill, optional remove ×. */
function AttachmentChip({
  name,
  mime,
  size,
  thumbnailUrl,
  onRemove
}: {
  name: string
  mime: string
  size: number
  thumbnailUrl?: string | null
  onRemove?: () => void
}) {
  const isImage = mime.startsWith('image/')
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
      {isImage && thumbnailUrl ? (
        <img src={thumbnailUrl} alt={name} className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded bg-surface-2 text-muted">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </div>
      )}
      <div className="min-w-0">
        <div className="max-w-[140px] truncate text-[11px] font-medium text-text">{name}</div>
        <div className="text-[10px] text-muted">{formatBytes(size)}</div>
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-surface-2 text-muted transition-colors hover:bg-red-500/20 hover:text-red-400"
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M2 2l6 6M8 2l-6 6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}

/** A persisted-message attachment chip; lazily reads an image's data URL. */
function MessageAttachmentChip({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mime.startsWith('image/')
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    void window.sylor.attachments.read(attachment.id).then((url) => {
      if (!cancelled) setThumbnailUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.id, isImage])
  return (
    <AttachmentChip
      name={attachment.name}
      mime={attachment.mime}
      size={attachment.size}
      thumbnailUrl={thumbnailUrl}
    />
  )
}

/** Formats elapsed seconds for the live status line: `12s`, then `1m 03s`. */
function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

/** Formats a rough token estimate: `840`, then `1.2k`. */
function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`
}

/**
 * Distinct line-style vector icon per workflow phase: the live status line reads
 * at a glance as it advances (Understanding → Scanning → Reading → Planning →
 * Generating → Executing → Verifying → Done). Drawn with `currentColor` so it
 * inherits the status line's tint. These label the high-level phase; concrete file
 * ops (read/edit/create/run) render as tool cards in the prose, so the two never
 * duplicate.
 */
function StageIcon({ stage }: { stage: WorkflowStage }): ReactNode {
  const base: SVGProps<SVGSVGElement> = {
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true
  }
  switch (stage) {
    case 'understanding': // compass — getting oriented
      return (
        <svg {...base}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M10.6 5.4 8.7 8.7 5.4 10.6 7.3 7.3z" />
        </svg>
      )
    case 'scanning': // magnifying glass — searching the tree
      return (
        <svg {...base}>
          <circle cx="7" cy="7" r="3.8" />
          <path d="M9.8 9.8 13.5 13.5" />
        </svg>
      )
    case 'reading': // open book
      return (
        <svg {...base}>
          <path d="M8 4.7C6.6 3.6 4.9 3.3 3 3.4v8c1.9-.1 3.6.2 5 1.3 1.4-1.1 3.1-1.4 5-1.3v-8c-1.9-.1-3.6.2-5 1.3z" />
          <path d="M8 4.7v8" />
        </svg>
      )
    case 'planning': // checklist / document
      return (
        <svg {...base}>
          <rect x="3.5" y="2.5" width="9" height="11" rx="1.2" />
          <path d="M5.8 6.2h4.4M5.8 8.6h4.4M5.8 11h2.6" />
        </svg>
      )
    case 'generating': // sparkle
      return (
        <svg {...base}>
          <path d="M8 2.4c.35 2.7 1.05 3.4 3.6 3.6-2.55.2-3.25.9-3.6 3.6-.35-2.7-1.05-3.4-3.6-3.6 2.55-.2 3.25-.9 3.6-3.6z" />
          <path d="M12.2 10.3c.15 1.1.45 1.4 1.4 1.4-.95.05-1.25.35-1.4 1.4-.15-1.05-.45-1.35-1.4-1.4.95 0 1.25-.3 1.4-1.4z" />
        </svg>
      )
    case 'executing': // lightning bolt
      return (
        <svg {...base}>
          <path d="M9 2 4 9h3.2l-1 5 5-7.2H8z" />
        </svg>
      )
    case 'verifying': // flask
      return (
        <svg {...base}>
          <path d="M6.5 2.5v3.7L3.7 11.8a1 1 0 0 0 .9 1.4h6.8a1 1 0 0 0 .9-1.4L9.5 6.2V2.5" />
          <path d="M6 2.5h4M5.2 9.3h5.6" />
        </svg>
      )
    case 'done': // check in a circle
      return (
        <svg {...base}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.6 8.1 7.3 9.8 10.6 6.2" />
        </svg>
      )
  }
}

/** A faint interpunct between two stats on the status row. */
function Sep(): ReactNode {
  return (
    <span aria-hidden className="text-muted/50">
      ·
    </span>
  )
}

/**
 * How each preview state reads on the status row (§23/§33). A preview that isn't
 * showing the current code says so — the whole point is that a stale or broken
 * preview is never presented as if it were live. UNAVAILABLE/UNKNOWN render
 * nothing at all: there's no preview to report on, so the row stays quiet.
 */
const PREVIEW_CHIPS: Partial<
  Record<NonNullable<RunProgressUI['preview']>, { label: string; tone: string; title: string }>
> = {
  RUNNING: {
    label: 'preview live',
    tone: 'bg-emerald-400',
    title: 'The preview is serving the current code'
  },
  STALE: {
    label: 'preview stale',
    tone: 'bg-amber-400',
    title: 'The preview is still showing an older build — not the current code'
  },
  COMPILE_ERROR: {
    label: 'preview broken',
    tone: 'bg-amber-400',
    title: 'The current code does not compile, so the preview cannot show it'
  },
  RUNTIME_ERROR: {
    label: 'preview erroring',
    tone: 'bg-amber-400',
    title: 'The preview loaded but threw a runtime error'
  }
}

/**
 * Where the whole build stands, as compact chips on the SAME single status row
 * (§33): which phase of how many, how far through the phase's tasks, whether the
 * project's own checks passed, and what the preview is really showing. Never a
 * second row and never an accumulating list — the row re-labels itself, so one
 * glance answers "where are we" without the internal tool output being dumped
 * into the chat. Each chip is omitted when there's nothing honest to say about it.
 */
function ProgressChips({ progress }: { progress: RunProgressUI }): ReactNode {
  const { tasks, checks } = progress
  const preview = progress.preview ? PREVIEW_CHIPS[progress.preview] : undefined
  return (
    <>
      {tasks && (
        <>
          <Sep />
          <span
            className="tabular-nums"
            title={`${tasks.done} of ${tasks.total} planned tasks finished`}
          >
            {tasks.done}/{tasks.total} tasks
          </span>
        </>
      )}
      {checks === 'PASSING' && (
        <>
          <Sep />
          <span className="text-emerald-400" title="The project's own checks passed this turn">
            checks ✓
          </span>
        </>
      )}
      {checks === 'FAILING' && (
        <>
          <Sep />
          <span className="text-amber-300" title="The project's own checks did not pass this turn">
            checks !
          </span>
        </>
      )}
      {preview && (
        <>
          <Sep />
          <span className="inline-flex items-center gap-1" title={preview.title}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${preview.tone}`} />
            {preview.label}
          </span>
        </>
      )}
    </>
  )
}

/**
 * The live task checklist for the active turn (#4). The model owns it through the
 * `update_todos` tool and re-sends the whole list each time, so this is a pure
 * projection — no local state, no ✓ we invented. It sits just above the status
 * line: the plan on top, the "what I'm doing right now" row beneath it. Shown only
 * while the turn is streaming and the list is non-empty (see the render gate), so a
 * finished or checklist-less turn shows nothing.
 *
 * Exported for its own test: the "pure projection, no ✓ we invented" shape is a
 * requirement worth pinning independently of the panel it renders in.
 */
export function TodoPanel({ todos }: { todos: TodoItem[] }): ReactNode {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-surface-2/40 px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-muted">
        <span>Tasks</span>
        <span className="tabular-nums">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px]">
            <span className="mt-0.5 shrink-0">
              <TodoGlyph status={todo.status} />
            </span>
            <span
              className={
                todo.status === 'completed'
                  ? 'text-muted line-through'
                  : todo.status === 'in_progress'
                    ? 'font-medium text-foreground'
                    : 'text-muted'
              }
            >
              {todo.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The leading status glyph for a single checklist row. */
function TodoGlyph({ status }: { status: TodoItem['status'] }): ReactNode {
  if (status === 'completed') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-label="done">
        <path
          d="M3.5 8.5l3 3 6-6.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-500"
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        className="grid h-3 w-3 place-items-center"
        aria-label="in progress"
        title="In progress"
      >
        <span className="h-2 w-2 rounded-full bg-primary sylor-blink" />
      </span>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-label="to do">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" className="text-muted" />
    </svg>
  )
}

/**
 * The live status line shown at the BOTTOM of the active turn (Claude-Code style):
 * a SINGLE evolving row — pulsing phase icon, the current phase message, elapsed
 * time, and a rough token estimate — that re-labels itself as the engine advances
 * (Understanding → Scanning → … → Generating → Executing …). It never accumulates
 * rows and never shows a ✓, so it can't claim a phase finished that didn't, and it
 * can't stack a second block of text above the model's own prose. The model's
 * natural reply is the acknowledgment; this line only reports what is happening now.
 *
 * When the turn is a phase of a staged build, `progress` adds the sticky
 * where-are-we chips (§33) to the same row — phase, tasks, checks, preview.
 *
 * Exported for the row's own test: the "one evolving row, never a second block"
 * shape is a requirement, so it's worth pinning independently of the panel.
 */
export function StatusLine({
  status,
  progress,
  tokens
}: {
  status: ActivityStatus | null
  progress: RunProgressUI | null
  tokens: number
}): ReactNode {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const stage = status?.stage ?? 'understanding'
  const message = status?.message ?? 'Thinking…'
  // While the engine is waiting out a retry backoff, the whole line drops to a
  // low opacity (requirement: "retrying … low opacity text diye") and the phase
  // icon stops pulsing — a quiet "holding, will resume" state rather than the
  // active shimmer, so a stalled request reads as paused, not working.
  const retrying = status?.retrying === true
  const phase = progress?.phase

  return (
    <div
      className={`mt-1.5 flex items-center gap-2 text-[12px] transition-opacity ${
        retrying ? 'opacity-45' : ''
      }`}
      role="status"
      aria-live="polite"
    >
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded bg-primary/12 text-primary ${
          retrying ? '' : 'sylor-blink'
        }`}
      >
        <StageIcon stage={stage} />
      </span>
      {phase && (
        <span
          className="shrink-0 rounded-sm bg-border/50 px-1 py-px text-[10px] font-medium text-muted"
          title={`Phase ${phase.n} of ${phase.total} — ${phase.name}`}
        >
          <span className="tabular-nums">
            {phase.n}/{phase.total}
          </span>{' '}
          <span className="inline-block max-w-[7rem] truncate align-bottom">{phase.name}</span>
        </span>
      )}
      <span
        className={`min-w-0 truncate font-medium ${retrying ? 'text-muted' : 'sylor-thinking'}`}
      >
        {message}
      </span>
      <span className="ml-0.5 flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
        <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        {progress && <ProgressChips progress={progress} />}
        {tokens > 0 && (
          <>
            <Sep />
            <span className="tabular-nums">~{formatTokens(tokens)} tokens</span>
          </>
        )}
      </span>
    </div>
  )
}

/** Strips a run's leading `sylor-tool` fenced blocks that leaked into prose. */
const TOOL_FENCE_RE = /```sylor-tool[\s\S]*?```/g

/** Last path segment, for compact labels (the full path stays in a title attr). */
function basename(path: string): string {
  const norm = path.replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return i >= 0 ? norm.slice(i + 1) : norm
}

/**
 * Compact, status-aware label for a tool card's one-line row (requirement C):
 * "Edit App.tsx" while pending → "Edited App.tsx" once applied. Commands and MCP
 * calls get a short verb + target so the thread reads at a glance without code.
 */
function toolLabel(card: ToolCardUI): string {
  const { proposal } = card
  const done = card.status === 'complete'
  const running = card.status === 'running'
  const tense = (verb: string, gerund: string, past: string): string =>
    done ? past : running ? gerund : verb
  if (proposal.kind === 'write_file') {
    const base = basename(proposal.path)
    return proposal.exists
      ? `${tense('Edit', 'Editing', 'Edited')} ${base}`
      : `${tense('Create', 'Creating', 'Created')} ${base}`
  }
  if (proposal.kind === 'mcp_call') {
    return `${proposal.server}/${proposal.name}`
  }
  if (proposal.kind === 'read') {
    if (proposal.op === 'search_files') {
      return `${tense('Search', 'Searching', 'Searched')} "${proposal.query ?? ''}"`
    }
    if (proposal.op === 'find_files') {
      return `${tense('Find', 'Finding', 'Found')} ${proposal.glob ?? ''}`
    }
    if (proposal.op === 'list_files') {
      return `${tense('List', 'Listing', 'Listed')} ${proposal.path}`
    }
    // "Read" is its own past tense, so this row reads naturally in every state.
    return `${tense('Read', 'Reading', 'Read')} ${basename(proposal.path)}`
  }
  if (proposal.kind === 'web_fetch') {
    return `${tense('Fetch', 'Fetching', 'Fetched')} ${hostOf(proposal.url)}`
  }
  if (proposal.kind === 'web_search') {
    return `${tense('Search', 'Searching', 'Searched')} "${proposal.query}"`
  }
  if (proposal.kind === 'install_plugin') {
    return `${tense('Install', 'Installing', 'Installed')} ${proposal.source}`
  }
  if (proposal.kind === 'preview_inspect') {
    return previewLabel(proposal, tense)
  }
  if (proposal.kind === 'browse') {
    return browseLabel(proposal, tense)
  }
  if (proposal.kind === 'diagnostics') {
    const what = proposal.scope === 'all' ? 'for problems' : `${proposal.scope} problems`
    return `${tense('Check', 'Checking', 'Checked')} ${what}`
  }
  const head = proposal.command.trim().split(/\s+/).slice(0, 3).join(' ')
  return `${tense('Run', 'Running', 'Ran')} ${head}`
}

/**
 * Row label for a preview step, phrased as what the user can watch happen in the
 * preview pane ("Looking at the preview", "Opening /about") rather than as an
 * action name — the sibling of {@link browseLabel} for the pane beside it.
 */
function previewLabel(
  proposal: Extract<ToolProposal, { kind: 'preview_inspect' }>,
  tense: (verb: string, gerund: string, past: string) => string
): string {
  const target = proposal.selector ?? 'an element'
  switch (proposal.action) {
    case 'screenshot':
      return `${tense('Look at', 'Looking at', 'Looked at')} the preview`
    case 'snapshot':
      return `${tense('Read', 'Reading', 'Read')} the preview`
    case 'inspect':
      return `${tense('Inspect', 'Inspecting', 'Inspected')} ${target}`
    case 'console_logs':
      return `${tense('Check', 'Checking', 'Checked')} the preview console`
    case 'network':
      return `${tense('Check', 'Checking', 'Checked')} the preview requests`
    case 'click':
      return `${tense('Click', 'Clicking', 'Clicked')} ${target}`
    case 'fill':
      return `${tense('Type', 'Typing', 'Typed')} into ${target}`
    case 'resize':
      return `${tense('Resize', 'Resizing', 'Resized')} the preview${
        proposal.preset
          ? ` to ${proposal.preset}`
          : proposal.width && proposal.height
            ? ` to ${proposal.width}×${proposal.height}`
            : ''
      }`
    case 'eval':
      return `${tense('Run', 'Running', 'Ran')} JS in the preview`
    case 'navigate':
      return proposal.url
        ? `${tense('Open', 'Opening', 'Opened')} ${proposal.url}`
        : `${tense('Reload', 'Reloading', 'Reloaded')} the preview`
    case 'server_logs':
      return `${tense('Check', 'Checking', 'Checked')} the dev server log`
    default:
      return `${tense('Check', 'Checking', 'Checked')} the preview`
  }
}

/**
 * Row label for a browse step, phrased the way the user would say it ("Open
 * gmail.com", "Click Compose"). Mirrors the main process's `describeBrowse` but
 * tensed like every other card, so a running step reads "Clicking Compose".
 */
function browseLabel(
  proposal: Extract<ToolProposal, { kind: 'browse' }>,
  tense: (verb: string, gerund: string, past: string) => string
): string {
  const what = proposal.target ? ` ${proposal.target}` : ''
  switch (proposal.action) {
    case 'navigate':
      return `${tense('Open', 'Opening', 'Opened')} ${hostOf(proposal.url ?? '')}`
    case 'click':
      return `${tense('Click', 'Clicking', 'Clicked')}${what}`
    case 'type':
      return `${tense('Type', 'Typing', 'Typed')} into${what}`
    case 'scroll':
      return `${tense('Scroll', 'Scrolling', 'Scrolled')} ${proposal.direction ?? 'down'}`
    case 'console':
      return `${tense('Check', 'Checking', 'Checked')} the page console`
    case 'network':
      return `${tense('Check', 'Checking', 'Checked')} the page requests`
    case 'inspect':
      return `${tense('Inspect', 'Inspecting', 'Inspected')} ${proposal.selector ?? 'an element'}`
    default:
      return `${tense('Read', 'Reading', 'Read')} the page`
  }
}

/** The host of a URL for a compact label, falling back to the raw string. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Full, untruncated description of a proposal (used as a hover title). */
function proposalFullTitle(proposal: ToolProposal): string {
  if (proposal.kind === 'write_file') {
    return proposal.purpose ? `${proposal.path} — ${proposal.purpose}` : proposal.path
  }
  if (proposal.kind === 'mcp_call') return `${proposal.server}/${proposal.name}`
  if (proposal.kind === 'read') {
    return proposal.op === 'search_files'
      ? `search "${proposal.query ?? ''}" in ${proposal.path}`
      : proposal.op === 'find_files'
        ? `find "${proposal.glob ?? ''}" in ${proposal.path}`
        : proposal.path
  }
  if (proposal.kind === 'web_fetch') return proposal.url
  if (proposal.kind === 'web_search') return `search "${proposal.query}"`
  if (proposal.kind === 'install_plugin') return `install ${proposal.source} (${proposal.scope})`
  if (proposal.kind === 'preview_inspect') {
    // The raw detail, so hovering an `eval` row shows the exact code that ran.
    const detail = [proposal.selector, proposal.url, proposal.expression].filter(Boolean).join(' ')
    return `preview ${proposal.action}${detail ? ` ${detail}` : ''}`
  }
  if (proposal.kind === 'browse') {
    const bits = [
      proposal.action,
      proposal.url,
      proposal.target,
      proposal.selector,
      proposal.direction,
      proposal.level,
      proposal.filter
    ].filter(Boolean)
    return `browse · ${bits.join(' ')}`
  }
  if (proposal.kind === 'diagnostics') {
    const where = proposal.files?.length ? ` · ${proposal.files.join(', ')}` : ''
    return `diagnostics · ${proposal.scope}${where}`
  }
  return proposal.command
}

/**
 * A short, human reason a completed op did NOT succeed, or null when it applied
 * cleanly (or the user skipped it). Drives the calm inline note beside a card:
 * the user sees WHAT went wrong, never a bare alarming "Failed".
 */
function cardError(card: ToolCardUI): string | null {
  if (card.status !== 'complete' || card.decision === 'reject') return null
  const r = card.result
  if (r?.kind === 'write_file' && !r.ok) return r.error ?? 'write failed'
  if (r?.kind === 'read' && !r.ok) return r.error ?? 'read failed'
  if (r?.kind === 'mcp_call' && !r.ok) return r.error ?? 'call failed'
  if (r?.kind === 'web_fetch' && !r.ok) return r.error ?? 'fetch failed'
  if (r?.kind === 'web_search' && !r.ok) return r.error ?? 'search failed'
  if (r?.kind === 'install_plugin' && !r.ok) return r.error ?? 'install failed'
  if (r?.kind === 'preview_inspect' && !r.ok) return r.error ?? 'preview check failed'
  if (r?.kind === 'browse' && !r.ok) return r.error ?? 'could not do that on the page'
  // A diagnostics run is only "failed" when NO checker could run — findings are a
  // successful check, and reporting them as an error would be a lie about the tool.
  if (r?.kind === 'diagnostics' && !r.ok) return r.error ?? 'nothing was checked'
  if (r?.kind === 'run_command' && r.exitCode !== 0 && r.exitCode !== null) return `exit ${r.exitCode}`
  return null
}

/**
 * Header indicator reflecting a card's lifecycle. A clean success is a quiet
 * green tick — no "Applied" text. A failure is deliberately calm: a soft amber
 * dot, not an alarming red "Failed" pill, because the agent loop feeds the error
 * back and tries again (the short reason renders beside the row, and the retry
 * shows up as the next card's tick). A user-skipped op reads as a flat "skipped".
 */
function StatusBadge({ card }: { card: ToolCardUI }) {
  if (card.status === 'complete') {
    if (card.decision === 'reject') return <span className="text-[10px] text-muted">skipped</span>
    if (cardError(card)) {
      return (
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400/80"
          aria-label="retrying"
          title="Ran into a problem — retrying"
        />
      )
    }
    return (
      <span className="text-[12px] font-semibold text-emerald-500" aria-label="applied" title="Applied">
        ✓
      </span>
    )
  }
  if (card.status === 'running') {
    return (
      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
        {card.auto ? 'Auto · running' : 'Running'}
      </span>
    )
  }
  return (
    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
      Needs approval
    </span>
  )
}

/** Renders the result footer (exit code / error / output tail). */
function ToolResultFooter({ card }: { card: ToolCardUI }) {
  const result = card.result
  if (!result) return null
  if (result.kind === 'write_file') {
    if (result.ok) return null
    return (
      <div className="border-t border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90">
        {result.error ?? 'Write failed.'}
      </div>
    )
  }
  if (result.kind === 'mcp_call') {
    const mcpOut = result.output.trimEnd()
    return (
      <div className="border-t border-border bg-bg px-3 py-1.5">
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
          <span className={result.ok ? 'text-emerald-300' : 'text-amber-300'}>
            {result.ok ? 'ok' : 'error'}
          </span>
          {result.truncated && <span className="text-amber-300">output truncated</span>}
        </div>
        {!result.ok && result.error && (
          <div className="mb-1 text-[11px] text-amber-200/90">{result.error}</div>
        )}
        {mcpOut.length > 0 && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
            {mcpOut}
          </pre>
        )}
      </div>
    )
  }
  if (result.kind === 'read') {
    if (!result.ok) {
      return (
        <div className="border-t border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90">
          {result.error ?? 'Read failed.'}
        </div>
      )
    }
    return (
      <div className="border-t border-border bg-bg px-3 py-1.5">
        {result.truncated && (
          <div className="mb-1 text-[10px] text-amber-300">output truncated</div>
        )}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
          {result.output.trimEnd()}
        </pre>
      </div>
    )
  }
  if (result.kind === 'web_fetch') {
    if (!result.ok) {
      return (
        <div className="border-t border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90">
          {result.error ?? 'Fetch failed.'}
        </div>
      )
    }
    return (
      <div className="border-t border-border bg-bg px-3 py-1.5">
        {result.truncated && (
          <div className="mb-1 text-[10px] text-amber-300">content truncated</div>
        )}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
          {result.output.trimEnd()}
        </pre>
      </div>
    )
  }
  if (result.kind === 'web_search') {
    if (!result.ok) {
      return (
        <div className="border-t border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90">
          {result.error ?? 'Search failed.'}
        </div>
      )
    }
    return (
      <div className="border-t border-border bg-bg px-3 py-1.5">
        {result.truncated && (
          <div className="mb-1 text-[10px] text-amber-300">results truncated</div>
        )}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
          {result.output.trimEnd()}
        </pre>
      </div>
    )
  }
  if (result.kind === 'install_plugin') {
    if (!result.ok) {
      return (
        <div className="border-t border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90">
          {result.error ?? 'Install failed.'}
        </div>
      )
    }
    const installOut = result.output.trimEnd()
    return (
      <div className="border-t border-border bg-bg px-3 py-1.5">
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
          <span className="text-emerald-300">installed</span>
          {result.plugin && <span>{result.plugin}</span>}
        </div>
        {installOut.length > 0 && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
            {installOut}
          </pre>
        )}
      </div>
    )
  }
  if (result.kind === 'preview_inspect') {
    // Preview checks are rendered by PreviewInspectCard (a quiet row with the
    // screenshot/output inline), never inside a bordered card, so nothing here.
    return null
  }
  if (result.kind === 'browse') {
    // Same as preview_inspect: BrowseCard owns the rendering (a quiet row), because
    // a browse step is a look/act on a page the user can already see beside the chat.
    return null
  }
  if (result.kind === 'diagnostics') {
    // `ok: false` means NO checker ran. That is the one thing the user must not read
    // as a clean project, so it gets the amber note; findings are an ordinary result.
    if (!result.ok) {
      return (
        <div className="border-t border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90">
          {result.error ?? 'No checker could be run.'}
        </div>
      )
    }
    const report = result.output.trimEnd()
    return (
      <div className="border-t border-border bg-bg px-3 py-1.5">
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
          <span className={result.errors > 0 ? 'text-amber-300' : 'text-emerald-300'}>
            {result.summary}
          </span>
          {result.truncated && <span className="text-amber-300">list truncated</span>}
        </div>
        {report.length > 0 && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
            {report}
          </pre>
        )}
      </div>
    )
  }
  // run_command
  const output = result.output.trimEnd()
  return (
    <div className="border-t border-border bg-bg px-3 py-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
        <span>
          exit code{' '}
          <span className={result.exitCode === 0 ? 'text-emerald-300' : 'text-amber-300'}>
            {result.exitCode ?? 'killed'}
          </span>
        </span>
        {result.truncated && <span className="text-amber-300">output truncated</span>}
      </div>
      {output.length > 0 && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text/80">
          {output}
        </pre>
      )}
    </div>
  )
}

/**
 * A read op rendered as a single quiet line — "⌕ Read useChatStore.ts · 1158
 * lines". Deliberately lighter than {@link ToolCard}: nothing was changed here, so
 * there is no diff and no status badge — just what was looked at and what came
 * back, expandable if the user wants to see exactly what Sylor saw.
 *
 * In the chat thread only FAILED reads reach this component ({@link threadCards}
 * drops the rest — a dozen bordered "Read x" rows would bury the actual answer).
 * The Run Log shows every one of them and routes here through
 * {@link ToolCardDetail}, so this row is still the one place a read is drawn.
 */
function ReadCard({ card }: { card: ToolCardUI }) {
  const [expanded, setExpanded] = useState(false)
  const result = card.result?.kind === 'read' ? card.result : null
  const failed = result !== null && !result.ok

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={proposalFullTitle(card.proposal)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="shrink-0 text-[11px] text-muted">⌕</span>
        <span className="min-w-0 truncate text-[11.5px] text-text/70">{toolLabel(card)}</span>
        <span
          className={
            'min-w-0 shrink truncate text-[10.5px] ' + (failed ? 'text-red-300' : 'text-muted')
          }
        >
          {result ? `· ${failed ? (result.error ?? 'failed') : result.summary}` : '· …'}
        </span>
      </button>

      {expanded && result?.ok && (
        <div className="mt-0.5 space-y-1.5">
          {result.media?.kind === 'image' && (
            <img
              src={`data:${result.media.mediaType};base64,${result.media.dataBase64}`}
              alt={toolLabel(card)}
              className="max-h-64 rounded border border-border object-contain"
            />
          )}
          <pre className="max-h-64 overflow-auto rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text/80">
            {result.output.trimEnd()}
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * A `preview_inspect` op rendered as a quiet line, like {@link ReadCard} — it is
 * auto-approved observation/interaction of the user's own live preview, carries
 * no diff and no approval. A `screenshot` shows the rendered image; the other
 * actions show their text result (snapshot, computed styles, console/network).
 */
function PreviewInspectCard({ card }: { card: ToolCardUI }) {
  const [expanded, setExpanded] = useState(false)
  const result = card.result?.kind === 'preview_inspect' ? card.result : null
  const failed = result !== null && !result.ok

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={proposalFullTitle(card.proposal)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="shrink-0 text-[11px] text-muted">🔍</span>
        <span className="min-w-0 truncate text-[11.5px] text-text/70">{toolLabel(card)}</span>
        <span
          className={
            'min-w-0 shrink truncate text-[10.5px] ' + (failed ? 'text-red-300' : 'text-muted')
          }
        >
          {result ? `· ${failed ? (result.error ?? 'failed') : result.summary}` : '· …'}
        </span>
      </button>

      {expanded && result?.ok && (
        <div className="mt-0.5 space-y-1.5">
          {result.media?.kind === 'image' && (
            <img
              src={`data:${result.media.mediaType};base64,${result.media.dataBase64}`}
              alt={toolLabel(card)}
              className="max-h-64 rounded border border-border object-contain"
            />
          )}
          {result.output.trim().length > 0 && (
            <pre className="max-h-64 overflow-auto rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text/80">
              {result.output.trimEnd()}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A `browse` step rendered as a quiet line, like {@link PreviewInspectCard}. The
 * page itself is right there in the BROWSER panel beside the chat, so the card's
 * job is only to say what Sylor did and let the user open up what it actually saw
 * — the perceived page text, and the screenshot when it took a visual read.
 *
 * Unlike a write there is no diff and (for read/navigate) no approval; a step the
 * user was asked about and declined still lands here, flagged "skipped" by the
 * shared {@link StatusBadge} logic through `cardError`.
 */
function BrowseCard({ card }: { card: ToolCardUI }) {
  const [expanded, setExpanded] = useState(false)
  const result = card.result?.kind === 'browse' ? card.result : null
  const failed = result !== null && !result.ok

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={proposalFullTitle(card.proposal)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="shrink-0 text-[11px] text-muted">🌐</span>
        <span className="min-w-0 truncate text-[11.5px] text-text/70">{toolLabel(card)}</span>
        <span
          className={
            'min-w-0 shrink truncate text-[10.5px] ' + (failed ? 'text-amber-300' : 'text-muted')
          }
        >
          {result ? `· ${failed ? (result.error ?? 'failed') : result.summary}` : '· …'}
        </span>
      </button>

      {expanded && result?.ok && (
        <div className="mt-0.5 space-y-1.5">
          {result.media?.kind === 'image' && (
            <img
              src={`data:${result.media.mediaType};base64,${result.media.dataBase64}`}
              alt={toolLabel(card)}
              className="max-h-64 rounded border border-border object-contain"
            />
          )}
          {result.output.trim().length > 0 && (
            <pre className="max-h-64 overflow-auto rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text/80">
              {result.output.trimEnd()}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A tool op rendered as a flat, tappable activity line (requirement C) — no
 * bordered card around it: a single row (chevron, icon, "Edited App.tsx", +/−
 * line stats, a quiet tick/status) with the diff / command / output tucked
 * behind a tap. This matches the flat assistant turn so the transcript reads as
 * one calm feed instead of a stack of boxes. Approval is NOT here; pending ops
 * are approved from the permission bar above the composer (requirement D). If an
 * op errored, a soft one-line reason shows beneath the row — calm, never a red
 * "Failed" — because the agent loop retries it (the fix lands as the next tick).
 */
/**
 * A tool op's payload — the diff, the command, the arguments — with its result
 * footer beneath. Split out of {@link ToolCard} so the Run Log can show the SAME
 * detail without nesting a second disclosure toggle inside its own expanded row
 * (and without a copy of this markup drifting from the card's).
 *
 * The three quiet kinds (read, preview check, browse) own their whole
 * presentation — row and payload together — so for them the detail *is* the card.
 * `ToolCard` short-circuits those before it ever reaches this component, so that
 * delegation terminates.
 */
export function ToolCardDetail({ card }: { card: ToolCardUI }) {
  const { proposal } = card
  const theme = useAppStore((s) => s.theme)
  if (proposal.kind === 'read' || proposal.kind === 'preview_inspect' || proposal.kind === 'browse')
    return <ToolCard card={card} />
  const language = proposal.kind === 'write_file' ? languageForPath(proposal.path) : 'plaintext'
  return (
    <div className="mt-1 overflow-hidden rounded-md border border-border">
      {proposal.kind === 'write_file' ? (
        <div className="h-56">
          <DiffEditor
            theme={monacoThemeFor(theme)}
            language={language}
            original={proposal.oldContent}
            modified={proposal.newContent}
            options={{
              readOnly: true,
              renderSideBySide: false,
              fontFamily: 'JetBrains Mono Variable, monospace',
              fontSize: 12,
              lineHeight: 18,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderOverviewRuler: false,
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }
            }}
            loading={<div className="p-3 text-[11px] text-muted">Loading diff…</div>}
          />
        </div>
      ) : proposal.kind === 'mcp_call' ? (
        <div className="bg-bg px-3 py-2">
          <div className="mb-1 font-mono text-[11px] text-muted">
            {proposal.server}/{proposal.name}
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-text/90">
            {JSON.stringify(proposal.arguments, null, 2)}
          </pre>
        </div>
      ) : proposal.kind === 'web_fetch' ? (
        <div className="bg-bg px-3 py-2 font-mono text-[12px] text-text/90">
          <span className="text-muted">🌐 </span>
          {proposal.url}
        </div>
      ) : proposal.kind === 'web_search' ? (
        <div className="bg-bg px-3 py-2 font-mono text-[12px] text-text/90">
          <span className="text-muted">🔎 </span>
          {proposal.query}
        </div>
      ) : proposal.kind === 'install_plugin' ? (
        <div className="bg-bg px-3 py-2 font-mono text-[12px] text-text/90">
          <span className="text-muted">📦 </span>
          {proposal.source}
          <span className="text-muted"> · {proposal.scope}</span>
        </div>
      ) : proposal.kind === 'diagnostics' ? (
        <div className="bg-bg px-3 py-2 font-mono text-[12px] text-text/90">
          <span className="text-muted">🩺 </span>
          {proposal.scope === 'all' ? 'typescript + eslint' : proposal.scope}
          {proposal.files?.length ? (
            <span className="text-muted"> · {proposal.files.join(', ')}</span>
          ) : null}
        </div>
      ) : (
        <pre className="bg-bg px-3 py-2 font-mono text-[12px] text-text/90">
          <span className="text-muted">$ </span>
          {proposal.command}
        </pre>
      )}
      <ToolResultFooter card={card} />
    </div>
  )
}

function ToolCard({ card }: { card: ToolCardUI }) {
  const { proposal } = card
  const [expanded, setExpanded] = useState(false)
  // Reads get their own much quieter row — they carry no diff and no approval.
  if (proposal.kind === 'read') return <ReadCard card={card} />
  // Preview checks are auto-approved observation of the user's own live preview
  // — a quiet row like a read, showing the screenshot/console/style result.
  if (proposal.kind === 'preview_inspect') return <PreviewInspectCard card={card} />
  // Browsing is a look/act on a page the user can already see in the BROWSER panel
  // — also a quiet row, with the perceived page (and screenshot) behind a tap.
  if (proposal.kind === 'browse') return <BrowseCard card={card} />
  const icon =
    proposal.kind === 'write_file'
      ? '✎'
      : proposal.kind === 'mcp_call'
        ? '⚙'
        : proposal.kind === 'web_fetch'
          ? '🌐'
          : proposal.kind === 'web_search'
            ? '🔎'
            : proposal.kind === 'install_plugin'
              ? '📦'
              : proposal.kind === 'diagnostics'
                ? '🩺'
                : '❯'
  const stats =
    proposal.kind === 'write_file' ? lineDiffStats(proposal.oldContent, proposal.newContent) : null
  const error = cardError(card)
  const took = formatDuration(card)

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={proposalFullTitle(proposal)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-2"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={'shrink-0 text-muted transition-transform ' + (expanded ? 'rotate-90' : '')}
        >
          <path
            d="M3.5 2l3 3-3 3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="shrink-0 text-[11px] text-muted">{icon}</span>
        <span className="min-w-0 truncate text-[12px] text-text/90">{toolLabel(card)}</span>
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-emerald-500">+{stats.added}</span>{' '}
            <span className="text-red-400">−{stats.removed}</span>
          </span>
        )}
        {/* The user rewrote the body at the permission bar, so the diff below is
            theirs, not the model's proposal. Worth saying: it explains why the file
            does not match what the reply claims it wrote. */}
        {card.edited && (
          <span
            className="shrink-0 rounded bg-primary/10 px-1 py-px text-[9px] text-primary"
            title="You edited this before approving it — the diff shown is what was written"
          >
            your edit
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* How long it actually took — measured from the op's own start/end stamps,
              so it is absent (not zero) for anything that was never timed. */}
          {took && <span className="font-mono text-[10px] text-muted">{took}</span>}
          <StatusBadge card={card} />
        </span>
      </button>

      {error && !expanded && (
        <div className="ml-[26px] truncate text-[10.5px] text-amber-300/70" title={error}>
          {error} · retrying
        </div>
      )}

      {/* What the file is FOR, as the model described it. A transcript scrolled past
          its prose still explains itself; an error outranks it for the same slot. */}
      {!error && proposal.kind === 'write_file' && proposal.purpose && (
        <div className="ml-[26px] truncate text-[10.5px] text-muted" title={proposal.purpose}>
          {proposal.purpose}
        </div>
      )}

      {expanded && <ToolCardDetail card={card} />}
    </div>
  )
}

/**
 * A block in an assistant turn's interleaved stream: prose, a lead tool card, or
 * a nested subagent card — ordered by the offset at which each was emitted.
 */
type Block =
  | { kind: 'prose'; text: string }
  | { kind: 'card'; card: ToolCardUI }
  | { kind: 'agent'; agent: AgentCardUI }

/**
 * Interleave streamed `content` with anchored blocks (tool cards / agent cards)
 * by the offset at which each arrived, so the thread reads think → act → think.
 * Anchors without an offset (older persisted ops) fall to the end.
 */
function interleave(
  content: string,
  anchors: Array<{ offset: number | undefined; block: Exclude<Block, { kind: 'prose' }> }>
): Block[] {
  const ordered = [...anchors].sort(
    (a, b) => (a.offset ?? Number.POSITIVE_INFINITY) - (b.offset ?? Number.POSITIVE_INFINITY)
  )
  const out: Block[] = []
  let cursor = 0
  for (const { offset, block } of ordered) {
    const at = offset == null ? content.length : Math.min(offset, content.length)
    if (at > cursor) {
      out.push({ kind: 'prose', text: content.slice(cursor, at) })
      cursor = at
    }
    out.push(block)
  }
  if (cursor < content.length) out.push({ kind: 'prose', text: content.slice(cursor) })
  return out
}

/**
 * Display metadata per subagent role (requirement B). The orchestrator can spawn
 * any role from the engine's extensible registry (backend, frontend, database,
 * security, …), so this map is INCOMPLETE by design — a `Partial` keyed lookup
 * that must go through {@link roleMeta}, never `ROLE_META[role]` directly. A raw
 * index for an unregistered role returns `undefined`, and reading `.icon`/`.label`
 * off it throws — with no error boundary that blanked the whole window mid-plan.
 */
const ROLE_META: Partial<Record<AgentRole, { label: string; icon: string }>> = {
  lead: { label: 'Lead', icon: '◆' },
  planner: { label: 'Planner', icon: '✐' },
  builder: { label: 'Builder', icon: '⚒' },
  reviewer: { label: 'Reviewer', icon: '✓' },
  'project-analyst': { label: 'Analyst', icon: '🔍' },
  frontend: { label: 'Frontend', icon: '🎨' },
  backend: { label: 'Backend', icon: '⚙' },
  database: { label: 'Database', icon: '🗄' },
  security: { label: 'Security', icon: '🛡' },
  research: { label: 'Researcher', icon: '📚' },
  devops: { label: 'DevOps', icon: '🚀' },
  testing: { label: 'Testing', icon: '🧪' },
  docs: { label: 'Docs', icon: '📝' },
  integration: { label: 'Integration', icon: '🔗' }
}

/**
 * Total lookup for a role's UI metadata. Falls back to a title-cased label + a
 * neutral dot for any role not in {@link ROLE_META}, so a newly-added specialist
 * renders sensibly instead of crashing the renderer.
 */
function roleMeta(role: AgentRole): { label: string; icon: string } {
  return (
    ROLE_META[role] ?? {
      label: role.charAt(0).toUpperCase() + role.slice(1).replace(/[-_]/g, ' '),
      icon: '●'
    }
  )
}

/**
 * A subagent the lead delegated to (requirement B), rendered flat — no bordered
 * box: a header row (role + assigned task + a quiet working/tick state) and,
 * beneath it, a subtly left-ruled column holding the subagent's own streamed
 * prose and (now flat) tool lines. The left rule is the only chrome — just
 * enough to read as "nested under the lead" without a card around it, matching
 * the flat assistant turn. This is the visible "agents communicating": lead →
 * task in, subagent → work + report out. A problem reads as a calm amber dot
 * (the loop retries), never a red "Failed".
 *
 * A running lane also carries its own Stop, because "one of the four is off down a
 * wrong path" should not cost the whole turn: it aborts that subagent only, and the
 * lead is told it was cancelled so it can carry on without that report.
 */
function AgentCard({ agent, tools }: { agent: AgentCardUI; tools: ToolCardUI[] }) {
  const meta = roleMeta(agent.role)
  const running = agent.status === 'running'
  const cancelAgent = useChatStore((s) => s.cancelAgent)
  const blocks = useMemo(
    () =>
      interleave(
        agent.content,
        threadCards(tools).map((c) => ({
          offset: c.contentOffset,
          block: { kind: 'card' as const, card: c }
        }))
      ),
    [agent.content, tools]
  )

  return (
    <div className="my-2">
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <span className="shrink-0 text-[12px] text-primary">{meta.icon}</span>
        <span className="shrink-0 text-[12px] font-semibold text-text">{meta.label}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={agent.task}>
          {agent.task}
        </span>
        {agent.background && (
          <span
            className="shrink-0 rounded-sm bg-border/50 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted"
            title="Running in the background — the lead kept working while this ran"
          >
            bg
          </span>
        )}
        {agent.isolation && (
          <span
            className="shrink-0 rounded-sm bg-border/50 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted"
            title="Isolated in a private git worktree; changes merged back when done"
          >
            isolated
          </span>
        )}
        {running ? (
          agent.cancelling ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-amber-300"
              title="You asked this one to stop; it is unwinding whatever it was mid-way through"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              stopping…
            </span>
          ) : (
            <>
              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                working
              </span>
              <button
                type="button"
                onClick={() => cancelAgent(agent.agentId)}
                title="Stop this subagent — the rest of the run keeps going"
                className="sylor-press shrink-0 rounded px-1 py-px text-[10px] font-medium text-muted transition-colors hover:bg-amber-500/10 hover:text-amber-300"
              >
                stop
              </button>
            </>
          )
        ) : agent.ok ? (
          <span className="shrink-0 text-[10px] font-medium text-muted" title="Done">
            done
          </span>
        ) : (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400/80"
            aria-label="retrying"
            title="Ran into a problem — retrying"
          />
        )}
      </div>
      <div className="ml-[7px] border-l border-border/60 pl-3">
        {blocks.length > 0 ? (
          blocks.map((block, i) =>
            block.kind === 'card' ? (
              <ToolCard key={block.card.id} card={block.card} />
            ) : block.kind === 'prose' ? (
              <ProseBlock key={`prose-${i}`} text={block.text} />
            ) : null
          )
        ) : running ? (
          <span className="sylor-thinking text-[12px] font-medium">Working…</span>
        ) : null}
      </div>
    </div>
  )
}

interface MessageProps {
  message: ChatMessageUI
  /** Whether this is the active (last, streaming) assistant message. */
  isActive: boolean
  /** The live status of the active run — a single evolving phase line. */
  status: ActivityStatus | null
  /** Sticky where-are-we chips for the active run (§33), or null for a one-off turn. */
  progress: RunProgressUI | null
  /** The live task checklist for the active run (#4), replaced wholesale by the model. */
  todos: TodoItem[]
  /** Lead (top-level) tool cards anchored beneath this message, in stream order. */
  cards: ToolCardUI[]
  /** Subagent cards anchored beneath this message (requirement B), in stream order. */
  agents: AgentCardUI[]
  /** Subagent tool cards keyed by agentId — rendered inside their agent card. */
  agentTools: Map<string, ToolCardUI[]>
  /** Attachments the user sent with this message (chips above the text). */
  attachments: Attachment[]
}

/** A single icon action button in the message-actions row. */
function ActionButton({
  label,
  active,
  disabled,
  onClick,
  children
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={
        'grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ' +
        (active ? 'text-primary' : 'text-muted hover:text-text')
      }
    >
      {children}
    </button>
  )
}

/**
 * Local-only actions under a finished assistant reply (Claude/ChatGPT-style):
 * Copy to clipboard, Rewrite (regenerate), like/dislike feedback, and Report.
 * Feedback and Report are markers persisted for reload only — nothing is sent.
 */
function MessageActions({ message }: { message: ChatMessageUI }) {
  const running = useChatStore((s) => s.running)
  const setFeedback = useChatStore((s) => s.setFeedback)
  const toggleFlag = useChatStore((s) => s.toggleFlag)
  const regenerate = useChatStore((s) => s.regenerate)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3 8.5l3 3 7-7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="5"
              y="5"
              width="8.5"
              height="8.5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        )}
      </ActionButton>
      <ActionButton label="Rewrite" disabled={running} onClick={() => regenerate(message.id)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ActionButton>
      <ActionButton
        label="Good response"
        active={message.feedback === 'like'}
        onClick={() => setFeedback(message.id, 'like')}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill={message.feedback === 'like' ? 'currentColor' : 'none'}
          aria-hidden="true"
        >
          <path
            d="M5 7v6.5H3.5A1 1 0 0 1 2.5 12.5V8a1 1 0 0 1 1-1H5zm0 0 2.5-5a1.5 1.5 0 0 1 1.5 1.5V6h3.3a1 1 0 0 1 1 1.2l-1 4.5a1.2 1.2 0 0 1-1.2 1H5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </ActionButton>
      <ActionButton
        label="Bad response"
        active={message.feedback === 'dislike'}
        onClick={() => setFeedback(message.id, 'dislike')}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill={message.feedback === 'dislike' ? 'currentColor' : 'none'}
          aria-hidden="true"
          style={{ transform: 'rotate(180deg)' }}
        >
          <path
            d="M5 7v6.5H3.5A1 1 0 0 1 2.5 12.5V8a1 1 0 0 1 1-1H5zm0 0 2.5-5a1.5 1.5 0 0 1 1.5 1.5V6h3.3a1 1 0 0 1 1 1.2l-1 4.5a1.2 1.2 0 0 1-1.2 1H5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </ActionButton>
      <ActionButton
        label={message.flagged ? 'Reported' : 'Report'}
        active={message.flagged}
        onClick={() => toggleFlag(message.id)}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 2v12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path
            d="M3.5 2.8h8.2l-1.6 2.7 1.6 2.7H3.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
            fill={message.flagged ? 'currentColor' : 'none'}
          />
        </svg>
      </ActionButton>
    </div>
  )
}

/**
 * One prose segment of an assistant turn (before/between/after tool cards).
 * Applies the same sylor-tool fence backstop + trim as the whole-message path
 * and renders nothing when empty (e.g. two cards emitted back-to-back).
 */
const ProseBlock = memo(function ProseBlock({ text }: { text: string }) {
  const content = useMemo(() => text.replace(TOOL_FENCE_RE, '').trim(), [text])
  if (content.length === 0) return null
  return <Markdown content={content} />
})

/**
 * User prose clamped to three lines with a Show more/less toggle (requirement F).
 * Overflow is measured after layout so the toggle only appears when the text is
 * actually taller than the clamp.
 */
function ClampedUserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 2)
  }, [text, expanded])
  return (
    <div>
      <div
        ref={ref}
        className={
          'whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text ' +
          (expanded ? '' : 'line-clamp-3')
        }
      >
        {text}
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-primary/80 transition-colors hover:text-primary"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/**
 * A user turn that began as a `/command`: the command renders as a blue mention
 * chip (Claude-CLI style) rather than the expanded prompt the engine actually
 * received. Any text the user typed after the command name follows the chip.
 */
function SlashUserText({ content, name }: { content: string; name: string }): ReactNode {
  const parsed = parseSlash(content)
  const label = parsed?.name ?? name
  const args = parsed?.args ?? ''
  return (
    <div className="text-[13px] leading-relaxed text-text">
      <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-500">
        /{label}
      </span>
      {args && <span className="ml-1.5 whitespace-pre-wrap break-words">{args}</span>}
    </div>
  )
}

/** A user turn: right-aligned bubble with its attachments (requirement F). */
function UserMessage({ message, attachments }: MessageProps) {
  const displayContent = useMemo(
    () => message.content.replace(TOOL_FENCE_RE, '').trimEnd(),
    [message.content]
  )
  if (displayContent.length === 0 && attachments.length === 0) return null
  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {attachments.map((a) => (
            <MessageAttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {displayContent.length > 0 && (
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-surface-2 px-3.5 py-2">
          {message.slashCommand ? (
            <SlashUserText content={displayContent} name={message.slashCommand} />
          ) : (
            <ClampedUserText text={displayContent} />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * An assistant turn: left-aligned with avatar, and a body that interleaves prose,
 * lead tool cards, and nested subagent cards (requirement B) in stream order.
 */
function AssistantMessage({
  message,
  isActive,
  status,
  progress,
  todos,
  cards,
  agents,
  agentTools
}: MessageProps) {
  // Backstop: never show raw sylor-tool JSON if a fence leaked past the extractor.
  const displayContent = useMemo(
    () => message.content.replace(TOOL_FENCE_RE, '').trimEnd(),
    [message.content]
  )

  // Interleave prose with the lead's tool cards AND the subagent cards anchored
  // beneath this turn, in stream order (think → act → delegate → think). Cards
  // without an offset fall to the end. Subagent tool cards live inside their
  // agent card, not here. Reads are filtered by {@link threadCards} — they still
  // count toward `tokenEstimate` below, because a hidden read costs context all
  // the same and the meter must not flatter itself.
  const blocks = useMemo(() => {
    const anchors = [
      ...threadCards(cards).map((c) => ({
        offset: c.contentOffset,
        block: { kind: 'card' as const, card: c }
      })),
      ...agents.map((a) => ({
        offset: a.contentOffset,
        block: { kind: 'agent' as const, agent: a }
      }))
    ]
    return interleave(message.content, anchors)
  }, [message.content, cards, agents])

  // Rough running token estimate for the live status line (≈ chars ÷ 4): the
  // lead's prose, every subagent's prose, any file contents the model wrote, and
  // whatever it read back — the visible "output so far". A renderer-side
  // approximation (no provider usage plumbing, per the low-token constraint), so
  // the UI prefixes it with ~.
  const tokenEstimate = useMemo(() => {
    let chars = message.content.length
    for (const c of cards) {
      if (c.proposal.kind === 'write_file') chars += c.proposal.newContent.length
      // A read's (or web fetch's) output is fed straight back to the model, so it
      // costs context too.
      if (c.result?.kind === 'read') chars += c.result.output.length
      if (c.result?.kind === 'web_fetch') chars += c.result.output.length
      if (c.result?.kind === 'web_search') chars += c.result.output.length
      if (c.result?.kind === 'diagnostics') chars += c.result.output.length
    }
    for (const a of agents) chars += a.content.length
    return Math.round(chars / 4)
  }, [message.content, cards, agents])

  // Claude-Code-style flat turn: the assistant reply renders directly on the
  // surface — no avatar, no name badge. Only the user's turn keeps a bubble, so
  // the two speakers still read distinctly (user = right-aligned pill, Sylor =
  // flat full-width prose on the background). A small `pl-4` gives the prose a
  // little breathing room from the left edge without reintroducing a gutter.
  return (
    <div className="min-w-0 pl-4">
      {message.error && (
        <div className="mb-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {message.error}
        </div>
      )}

      {blocks.length > 0 && (
        <div className="min-w-0">
          {blocks.map((block, i) =>
            block.kind === 'card' ? (
              <ToolCard key={block.card.id} card={block.card} />
            ) : block.kind === 'agent' ? (
              <AgentCard
                key={block.agent.agentId}
                agent={block.agent}
                tools={agentTools.get(block.agent.agentId) ?? []}
              />
            ) : (
              <ProseBlock key={`prose-${i}`} text={block.text} />
            )
          )}
        </div>
      )}

      {isActive && message.pending && todos.length > 0 && <TodoPanel todos={todos} />}

      {isActive && message.pending && (
        <StatusLine status={status} progress={progress} tokens={tokenEstimate} />
      )}

      {!message.pending && (displayContent.length > 0 || message.error != null) && (
        <MessageActions message={message} />
      )}
    </div>
  )
}

/** Dispatches to the user/assistant layout (each keeps its own hook order). */
function Message(props: MessageProps) {
  return props.message.role === 'user' ? (
    <UserMessage {...props} />
  ) : (
    <AssistantMessage {...props} />
  )
}

/**
 * Folder-first gate for Code mode (requirement A): before Sylor will read, edit,
 * or run anything, the user must pick a working folder. Rendered in place of the
 * composer input until one is chosen; the mode selectors stay visible below so
 * the user can switch back to Cowork (which needs no folder).
 */
function FolderGate({ onChoose }: { onChoose: () => void }) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-primary/50 bg-surface px-3 py-4 text-center transition-colors hover:bg-primary/5"
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold text-primary">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M2.5 5.5a1 1 0 0 1 1-1h3.2l1.5 1.8h7.3a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V5.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        Choose a folder to work in
      </span>
      <span className="text-[11px] text-muted">
        Code mode reads, edits, and runs commands inside a folder you pick.
      </span>
    </button>
  )
}

/**
 * One row of the permission bar: the op, its verdict buttons, and — for a
 * `write_file` — the diff itself, collapsed behind a `+n/−m` header.
 *
 * The diff is here rather than only in the card because the card is the record of
 * what happened; this is the moment BEFORE it happens, and "no silent writes"
 * means the bytes are reviewable while refusing them still costs nothing. The
 * modified side is editable, so a nearly-right file does not need a whole
 * reject → re-ask round trip: fix the two lines, approve, and the engine writes
 * exactly what is on screen (and tells the model the file holds the user's
 * version). Rejecting takes an optional reason for the same reason — "no" without
 * "because" makes the model guess at the correction.
 */
function PermissionRow({
  card,
  onDecide
}: {
  card: ToolCardUI
  onDecide: (toolId: string, decision: ToolDecision, detail?: ToolDecisionDetail) => void
}) {
  const theme = useAppStore((s) => s.theme)
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState('')
  const [asking, setAsking] = useState(false)
  // The user's in-progress edit of the proposed body. `null` = untouched, so an
  // approval without an edit sends no `editedContent` at all.
  const [edited, setEdited] = useState<string | null>(null)
  const proposal = card.proposal
  const write = proposal.kind === 'write_file' ? proposal : null
  const body = edited ?? write?.newContent ?? ''
  const stat = write ? lineDiffStats(write.oldContent, body) : null
  const role = card.agentRole ? roleMeta(card.agentRole) : null
  const icon =
    proposal.kind === 'write_file'
      ? '✎'
      : proposal.kind === 'mcp_call'
        ? '⚙'
        : proposal.kind === 'web_fetch'
          ? '🌐'
          : proposal.kind === 'web_search'
            ? '🔎'
            : proposal.kind === 'read'
              ? '⌕'
              : proposal.kind === 'diagnostics'
                ? '🩺'
                : '❯'
  const approve = (decision: ToolDecision): void =>
    onDecide(
      card.id,
      decision,
      edited != null && edited !== write?.newContent ? { editedContent: edited } : undefined
    )

  return (
    <div className="[&:not(:last-child)]:border-b [&:not(:last-child)]:border-amber-500/10">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <span className="shrink-0 text-[11px] text-muted">{icon}</span>
        {write ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={open ? 'Hide the diff' : 'Review the diff before it is written'}
          >
            <span className={'shrink-0 text-[9px] text-muted ' + (open ? 'rotate-90' : '')}>▶</span>
            <span className="min-w-0 flex-1 truncate font-medium text-text">{toolLabel(card)}</span>
            {stat && (
              <span className="shrink-0 font-mono text-[10px]">
                <span className="text-emerald-400">+{stat.added}</span>{' '}
                <span className="text-red-400">−{stat.removed}</span>
              </span>
            )}
          </button>
        ) : (
          <span
            className="min-w-0 flex-1 truncate font-medium text-text"
            title={proposalFullTitle(proposal)}
          >
            {toolLabel(card)}
          </span>
        )}
        {edited != null && edited !== write?.newContent && (
          <span
            className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
            title="Approving writes YOUR version of this file, not the proposed one"
          >
            your edit
          </span>
        )}
        {role && (
          <span
            className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
            title={`Requested by the ${role.label.toLowerCase()}`}
          >
            {role.icon} {role.label}
          </span>
        )}
        <button
          type="button"
          onClick={() => (asking ? onDecide(card.id, 'reject', { reason: why }) : setAsking(true))}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-red-500/50 hover:text-red-300"
        >
          Reject
        </button>
        {standingApprovalLabel(proposal) && (
          <button
            type="button"
            onClick={() => approve('approve-always')}
            title={standingApprovalLabel(proposal) ?? undefined}
            className="shrink-0 rounded-md border border-primary/40 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            Always
          </button>
        )}
        <button
          type="button"
          onClick={() => approve('approve')}
          className="shrink-0 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
        >
          Approve
        </button>
      </div>
      {asking && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onDecide(card.id, 'reject', { reason: why })
              if (e.key === 'Escape') setAsking(false)
            }}
            placeholder="Why not? (optional — it goes to the model)"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted focus:border-primary/50"
          />
          <button
            type="button"
            onClick={() => onDecide(card.id, 'reject', { reason: why })}
            className="shrink-0 rounded-md border border-red-500/40 px-2 py-0.5 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
          >
            Send
          </button>
        </div>
      )}
      {write && open && (
        <div className="px-3 pb-2">
          <div className="h-56 overflow-hidden rounded-md border border-border">
            <DiffEditor
              theme={monacoThemeFor(theme)}
              language={languageForPath(write.path)}
              original={write.oldContent}
              modified={body}
              onMount={(editor) => {
                // Edit-then-approve: the modified pane is a real editor, and every
                // keystroke lands in `edited`, which is what Approve then sends.
                const mod = editor.getModifiedEditor()
                mod.updateOptions({ readOnly: false })
                mod.onDidChangeModelContent(() => setEdited(mod.getValue()))
              }}
              options={{
                originalEditable: false,
                renderSideBySide: false,
                fontFamily: 'JetBrains Mono Variable, monospace',
                fontSize: 12,
                lineHeight: 18,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
                renderOverviewRuler: false,
                scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }
              }}
              loading={<div className="p-3 text-[11px] text-muted">Loading diff…</div>}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
            <span>Nothing is on disk yet — edit here and Approve writes your version.</span>
            {edited != null && edited !== write.newContent && (
              <button
                type="button"
                onClick={() => setEdited(null)}
                className="rounded px-1.5 py-0.5 transition-colors hover:bg-surface-2 hover:text-text"
              >
                Revert my edits
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Pending-approval bar shown directly ABOVE the composer (requirement D): every
 * tool op still awaiting a decision — the lead's or a subagent's — is listed
 * here with Reject / Approve, so approvals live at the input rather than being
 * hunted down in the thread. With more than one waiting, Approve all / Reject
 * all act on the batch. Routes through the same gate as the engine — nothing is
 * auto-applied here; autonomous mode simply never leaves ops in this state.
 *
 * Ops that can carry a run-scoped standing grant also offer "Always", so a long
 * build stops asking about every file it writes. The button appears only where
 * {@link standingApprovalLabel} can say plainly what the grant covers, and the
 * engine re-derives that scope itself — this UI cannot widen it.
 */
export function PermissionBar({
  awaiting,
  onDecide
}: {
  awaiting: ToolCardUI[]
  onDecide: (toolId: string, decision: ToolDecision, detail?: ToolDecisionDetail) => void
}) {
  if (awaiting.length === 0) return null
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/5">
      <div className="flex items-center justify-between gap-2 border-b border-amber-500/20 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {awaiting.length === 1 ? 'Approval needed' : `${awaiting.length} actions need approval`}
        </span>
        {awaiting.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => awaiting.forEach((c) => onDecide(c.id, 'reject'))}
              className="rounded-md px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={() => awaiting.forEach((c) => onDecide(c.id, 'approve'))}
              className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
            >
              Approve all
            </button>
          </div>
        )}
      </div>
      {/* Taller than the old 40 (`max-h-40`): a row can now unfold a diff, and a
          review surface you have to scroll a 10rem window to read is not one. */}
      <div className="max-h-[26rem] overflow-y-auto">
        {awaiting.map((card) => (
          <PermissionRow key={card.id} card={card} onDecide={onDecide} />
        ))}
      </div>
    </div>
  )
}

/**
 * The standing grants in force, as chips above the composer with an × on each.
 *
 * A grant's whole effect is that the permission bar stops appearing, so without
 * this the UI would go quiet in exactly the way it goes quiet when nothing is
 * happening. The chips make "I'm not being asked because I said so" legible, and
 * withdrawable in one click — a one-way door for the rest of a long run is not a
 * reasonable price for skipping a few clicks.
 */
export function StandingBar({
  keys,
  onRevoke
}: {
  keys: string[]
  onRevoke: (key: string) => void
}) {
  if (keys.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted">Not asking about:</span>
      {keys.map((key) => (
        <span
          key={key}
          className="flex max-w-[16rem] items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] text-primary"
          title={`You approved this for the rest of the run — click × to start being asked again`}
        >
          <span className="truncate font-mono">{describeStandingKey(key)}</span>
          <button
            type="button"
            onClick={() => onRevoke(key)}
            aria-label={`Ask me again about ${describeStandingKey(key)}`}
            className="shrink-0 text-muted transition-colors hover:text-text"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * The footer context meter — how much of the run's context is in use, and by what.
 *
 * The denominator is deliberately Sylor's OWN fold threshold, not the model's
 * context window: Sylor talks to whatever a gateway or a local Ollama exposes, so
 * for most model ids the real window is genuinely unknowable here, and the limit
 * that actually applies to a run is where the engine condenses. The window appears
 * only as a secondary line, and only when it is known — otherwise it says
 * "unknown" rather than becoming a percentage of a guess.
 *
 * Measured, not estimated: `usage` is taken in the engine at the top of a step,
 * the one place that can see the assembled system prompt and the tool output fed
 * back between turns. With no run live there is nothing measured to show, so the
 * chip falls back to the renderer's own conversation estimate and says which of
 * the two it is showing.
 */
export function ContextMeter({ estimate }: { estimate: number }) {
  const usage = useChatStore((s) => s.usage)
  const [open, setOpen] = useState(false)

  if (!usage) {
    return (
      <span
        className="text-[11px] text-muted"
        title={
          'Approximate token count for this conversation (estimate).\n' +
          'A measured breakdown appears here while a run is going.'
        }
      >
        ~{formatCount(estimate)} tokens
      </span>
    )
  }

  const pct = Math.min(100, Math.round((usage.chars / usage.budget) * 100))
  const text = pct >= 90 ? 'text-red-400' : pct >= 70 ? 'text-amber-300' : 'text-muted'
  const fill = pct >= 90 ? 'bg-red-400' : pct >= 70 ? 'bg-amber-300' : 'bg-primary/70'
  const tokens = Math.round(usage.chars / CHARS_PER_TOKEN)

  return (
    <span className="relative flex items-center gap-1.5">
      {open && <ContextBreakdown usage={usage} pct={pct} />}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${pct}% of the fold budget in use · click for the breakdown`}
        className="sylor-press flex items-center gap-1.5 rounded text-[11px] transition-colors hover:bg-surface-2"
      >
        <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-2">
          <span className={'block h-full ' + fill} style={{ width: `${Math.max(pct, 2)}%` }} />
        </span>
        <span className={'tabular-nums ' + text}>~{formatCount(tokens)} tokens</span>
      </button>
    </span>
  )
}

/**
 * The meter's popover: where the context actually went, plus what the next fold
 * will do about it. Every row is a measured character count turned into tokens at
 * the same 4-chars heuristic used everywhere else — never a provider-reported
 * figure, so it stays marked with a `~`.
 */
function ContextBreakdown({ usage, pct }: { usage: ContextUsage; pct: number }) {
  const rows: Array<[string, number, string]> = [
    ['System prompt', usage.systemChars, 'Instructions, project context, skills'],
    ['Conversation', usage.historyChars, 'Earlier turns and this request'],
    ['Sylor this turn', usage.assistantChars, 'Prose and tool calls written this run'],
    ['Tool output', usage.toolChars, 'File reads, command output, subagent reports']
  ]

  return (
    <div className="absolute bottom-full right-0 mb-1.5 w-60 rounded-lg border border-border bg-surface p-2 text-[11px] shadow-lg">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-medium text-text">Context in use</span>
        <span className="tabular-nums text-muted">
          {pct}% of ~{formatCount(Math.round(usage.budget / CHARS_PER_TOKEN))}
        </span>
      </div>
      {rows.map(([label, chars, why]) => (
        <div key={label} className="flex items-baseline justify-between gap-2 py-[1px]" title={why}>
          <span className="min-w-0 truncate text-muted">{label}</span>
          <span className="shrink-0 tabular-nums text-text/80">
            ~{formatCount(Math.round(chars / CHARS_PER_TOKEN))}
          </span>
        </div>
      ))}
      <p className="mt-1.5 border-t border-border pt-1.5 leading-snug text-muted">
        {usage.foldSteps > 0
          ? `Next fold condenses ${usage.foldSteps} earlier step${usage.foldSteps === 1 ? '' : 's'}.`
          : 'Nothing is queued to be condensed yet.'}
      </p>
      <p className="mt-1 leading-snug text-muted/70">
        {usage.windowTokens != null
          ? `This model's window is ~${formatCount(usage.windowTokens)} tokens; Sylor folds well before it.`
          : "This model's real window is unknown to Sylor, so the bar measures its own fold budget."}
      </p>
    </div>
  )
}

function EmptyState() {
  return <ZeroStateDashboard />
}

/**
 * The plan-approval bar (the "Plan first" checkpoint). Shown when the run has
 * finished planning and is parked before it touches a single file: the steps it is
 * about to run, and Approve / Reject. Approving builds the plan in the SAME turn —
 * no re-sending — and rejecting stops the run having changed nothing, which is a
 * decision rather than a failure, so nothing is retried.
 */
export function PlanApprovalBar({
  approval,
  onDecide
}: {
  approval: PendingPlan
  onDecide: (decision: 'approve' | 'reject') => void
}): ReactNode {
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-primary/40 bg-primary/5">
      <div className="flex items-center justify-between gap-2 border-b border-primary/20 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
          <span className="h-1.5 w-1.5 rounded-full bg-primary sylor-blink" />
          {approval.phase
            ? `Plan — phase ${approval.phase.n} of ${approval.phase.total}: ${approval.phase.name}`
            : 'Plan ready for your go-ahead'}
        </span>
        <span className="shrink-0 text-[10px] text-muted">
          {approval.steps.length === 1 ? '1 step' : `${approval.steps.length} steps`}
          {` · ${approval.complexity}`}
        </span>
      </div>
      <ol className="max-h-40 list-none overflow-y-auto">
        {approval.steps.map((step, i) => (
          <li
            key={`${i}-${step}`}
            className="flex gap-2 px-3 py-1.5 text-[12px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-primary/10"
          >
            <span className="shrink-0 text-[11px] text-muted">{i + 1}.</span>
            <span className="min-w-0 flex-1 text-text" title={step}>
              {step}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-2 border-t border-primary/20 px-3 py-1.5">
        <span className="min-w-0 truncate text-[10px] text-muted">
          {approval.planPath
            ? `Full plan written to ${approval.planPath} — nothing else has been touched yet.`
            : 'Nothing has been written yet.'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onDecide('reject')}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-red-500/50 hover:text-red-300"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => onDecide('approve')}
            className="rounded-md bg-primary px-2.5 py-0.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
          >
            Build it
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The clarifying-question bar (the `ask_user` tool). When the run blocks on a
 * question, this sits above the composer: it shows the question, any suggested
 * answer chips, and a free-text field so the user is never boxed into the offered
 * choices. Answering (a chip click or a typed reply) resumes the paused run. The
 * accent is the primary colour, distinct from the amber approval bar — this is a
 * question, not a permission gate.
 */
export function QuestionBar({
  question,
  onAnswer
}: {
  question: PendingQuestion
  onAnswer: (answer: string) => void
}): ReactNode {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const submit = (): void => {
    if (!trimmed) return
    onAnswer(trimmed)
    setText('')
  }
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-primary/40 bg-primary/5">
      <div className="flex items-center gap-1.5 border-b border-primary/20 px-3 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-primary sylor-blink" />
        <span className="text-[11px] font-semibold text-primary">
          {question.header?.trim() || 'A quick question'}
        </span>
      </div>
      <div className="px-3 py-2">
        <p className="mb-2 text-[13px] font-medium text-text">{question.question}</p>
        {question.options && question.options.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {question.options.map((option, i) => (
              <button
                key={`${i}-${option}`}
                type="button"
                onClick={() => onAnswer(option)}
                className="rounded-md border border-primary/40 px-2 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={
              question.options && question.options.length > 0
                ? 'Or type your own answer…'
                : 'Type your answer…'
            }
            className="min-w-0 flex-1 rounded-md border border-border bg-surface-2/60 px-2 py-1 text-[12px] text-text placeholder:text-muted focus:border-primary/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!trimmed}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Flagged follow-ups (the `flag_followup` tool): out-of-scope work the agent noticed
 * while doing something else and deliberately left undone.
 *
 * Unlike the approval and question bars this blocks nothing — the turn is over and the
 * work is recorded — so it is styled quietly (the neutral border, no primary accent, no
 * blinking dot) and offers only the two things a deferred issue can need: start it as
 * its own turn, or hide the chip. Dismissing never touches the written entry, and the
 * footnote names a file ONLY when one was actually written: an unwritable checkout still
 * flags the finding, and the UI must not claim a record that doesn't exist.
 */
export function FollowupBar({
  followups,
  disabled,
  onStart,
  onDismiss
}: {
  followups: Followup[]
  disabled: boolean
  onStart: (followup: Followup) => void
  onDismiss: (id: string) => void
}): ReactNode {
  if (followups.length === 0) return null
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-surface-2/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
        <span className="text-[11px] font-semibold text-muted">
          Noticed along the way — not done
        </span>
        <span className="shrink-0 text-[10px] text-muted">
          {followups.length === 1 ? '1 follow-up' : `${followups.length} follow-ups`}
        </span>
      </div>
      <ul className="max-h-40 list-none overflow-y-auto">
        {followups.map((followup) => (
          <li
            key={followup.id}
            className="flex items-start justify-between gap-2 px-3 py-1.5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-text">{followup.title}</p>
              {followup.note && <p className="mt-0.5 text-[11px] text-muted">{followup.note}</p>}
              <p className="mt-0.5 truncate text-[10px] text-muted">
                {followup.files?.length ? `${followup.files.join(', ')} · ` : ''}
                {followup.recordedIn
                  ? `noted in ${followup.recordedIn}`
                  : 'this session only — nothing could be written'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onStart(followup)}
                disabled={disabled}
                title={
                  disabled
                    ? 'Finish the current turn first'
                    : 'Start this as its own turn, right now'
                }
                className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40"
              >
                Do it now
              </button>
              <button
                type="button"
                onClick={() => onDismiss(followup.id)}
                aria-label={`Dismiss follow-up: ${followup.title}`}
                title="Hide this — the written entry is kept"
                className="grid h-5 w-5 place-items-center rounded-md text-[11px] text-muted transition-colors hover:bg-surface hover:text-text"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Theme toggle: sun in light, moon in dark. */
function ThemeToggle() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      onClick={() => void setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
    >
      {theme === 'dark' ? (
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )
}

/** Slim chat header: rail toggle, model selector, theme + log/preview controls. */
function ChatHeader({ onNewChat }: { onNewChat: () => void }) {
  const toggleRail = useAppStore((s) => s.toggleRail)
  const previewOpen = useAppStore((s) => s.previewOpen)
  const openPreview = useAppStore((s) => s.openPreview)
  const closePreview = useAppStore((s) => s.closePreview)
  const canvasOpen = useAppStore((s) => s.canvasOpen)
  const canvasMode = useAppStore((s) => s.canvasMode)
  const toggleCanvas = useAppStore((s) => s.toggleCanvas)
  const openPalette = useAppStore((s) => s.openPalette)
  const logOpen = canvasOpen && canvasMode === 'log'

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          onClick={toggleRail}
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect
              x="2.5"
              y="3.5"
              width="15"
              height="13"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onNewChat}
          className="rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface hover:text-text"
        >
          New chat
        </button>
        <ThemeToggle />
        {/* The palette's only visible entry point. Without it, Ctrl+K is a shortcut
            nobody discovers — and the shortcut is the whole feature. */}
        <button
          type="button"
          aria-label="Open the command palette"
          title="Search everything — Ctrl+K"
          onClick={openPalette}
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M12.8 12.8L16.5 16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        {/* The run log lives in the right slot, beside the preview and the browser —
            opening it never changes the conversation, it only shows the receipts. */}
        <button
          type="button"
          aria-label="Toggle run log"
          title="Run log — every step, with times"
          onClick={() => toggleCanvas('log')}
          className={
            'grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-surface hover:text-text ' +
            (logOpen ? 'text-primary' : 'text-muted')
          }
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect
              x="2.5"
              y="3.5"
              width="15"
              height="13"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M5.5 7.5h4M5.5 10h9M5.5 12.5h6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Toggle preview"
          title="Live preview"
          onClick={() => (previewOpen ? closePreview() : openPreview())}
          className={
            'grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-surface hover:text-text ' +
            (previewOpen ? 'text-primary' : 'text-muted')
          }
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect
              x="2.5"
              y="4.5"
              width="15"
              height="11"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path d="M8 8.5l3 1.5-3 1.5v-3z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * One entry in the composer's `/` menu — see `lib/slashSources.ts`, which the
 * Ctrl+K palette reads from too so both surfaces list the same commands.
 */
type SlashItem = SlashItemShape

/** Small leading glyph for each slash-menu row, keyed by item kind. */
function SlashItemIcon({ kind }: { kind: SlashItem['kind'] }): ReactNode {
  if (kind === 'skill') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2l1.6 3.3L13 6l-2.5 2.4L11 12 8 10.3 5 12l.5-3.6L3 6l3.4-.7L8 2Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (kind === 'builtin') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M6 2v3M10 2v3M4.5 5h7v3.5a3.5 3.5 0 0 1-7 0V5ZM8 12v2.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4l3 4-3 4M8 12h5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The `/`-triggered command palette shown directly above the textarea (like the
 * Claude CLI's slash menu). Purely presentational: the composer owns the item
 * list, the active index, and keyboard navigation; this renders the rows and
 * reports hover/click. Highlighting the active row and scrolling it into view is
 * handled here so ↑/↓ stays visible in a long list.
 */
const SlashMenu = memo(function SlashMenu({
  items,
  activeIndex,
  onSelect,
  onHover
}: {
  items: SlashItem[]
  activeIndex: number
  onSelect: (item: SlashItem) => void
  onHover: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
      <div className="border-b border-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
        Commands
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {items.map((item, i) => (
          <button
            key={`${item.kind}:${item.name}`}
            type="button"
            // Use onMouseDown (not onClick) so the textarea doesn't blur first,
            // which would otherwise steal the click and lose composer focus.
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(item)
            }}
            onMouseEnter={() => onHover(i)}
            className={
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ' +
              (i === activeIndex ? 'bg-primary/10' : 'hover:bg-surface-2')
            }
          >
            <span
              className={
                'grid h-6 w-6 shrink-0 place-items-center rounded-md ' +
                (i === activeIndex ? 'text-primary' : 'text-muted')
              }
            >
              <SlashItemIcon kind={item.kind} />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 font-mono text-[12px] font-medium text-text">
                /{item.name}
              </span>
              {item.hint && (
                <span className="shrink-0 font-mono text-[11px] text-muted">{item.hint}</span>
              )}
              {item.description && (
                <span className="min-w-0 truncate text-[11px] text-muted">{item.description}</span>
              )}
            </span>
            {item.kind !== 'command' && (
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
                {item.kind === 'skill' ? 'skill' : 'built-in'}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
})

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages)
  const tools = useChatStore((s) => s.tools)
  const agents = useChatStore((s) => s.agents)
  const attachments = useChatStore((s) => s.attachments)
  const running = useChatStore((s) => s.running)
  const status = useChatStore((s) => s.status)
  const progress = useChatStore((s) => s.progress)
  const todos = useChatStore((s) => s.todos)
  const question = useChatStore((s) => s.question)
  const planApproval = useChatStore((s) => s.planApproval)
  const followups = useChatStore((s) => s.followups)
  const standing = useChatStore((s) => s.standing)
  const send = useChatStore((s) => s.send)
  const sessionId = useChatStore((s) => s.sessionId)
  const decideTool = useChatStore((s) => s.decideTool)
  const revokeStanding = useChatStore((s) => s.revokeStanding)
  const answerQuestion = useChatStore((s) => s.answerQuestion)
  const decidePlan = useChatStore((s) => s.decidePlan)
  const dismissFollowup = useChatStore((s) => s.dismissFollowup)
  const cancel = useChatStore((s) => s.cancel)
  // "New chat" opens a fresh landing page (an unsaved draft) — the row is created
  // lazily on the first send, so the rail never fills with empty 'New session'
  // entries (Claude-Desktop parity).
  const newSession = useSessionStore((s) => s.newDraft)
  const workMode = useAppStore((s) => s.workMode)
  const workspaceChosen = useAppStore((s) => s.workspaceChosen)
  const workspaceRoot = useAppStore((s) => s.workspaceRoot)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)

  const [input, setInput] = useState('')
  // Files staged in the composer (already stored on disk as pending rows).
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  // Slash-menu sources: disk commands + enabled skills, loaded lazily when the
  // user starts a `/` line (so freshly-added ones show without a restart). The
  // Ctrl+K palette loads the same shape from the same module.
  const [sources, setSources] = useState<SlashSources>(NO_SLASH_SOURCES)
  const [menuIndex, setMenuIndex] = useState(0)
  // Escape closes the menu without clearing the text; reset when the line stops
  // being a slash query so the next `/` reopens it.
  const [menuDismissed, setMenuDismissed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // The last message is the "active" one whose intent/status chips we surface.
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null

  // Folder-first gate (requirement A): Code mode is inert until a folder is
  // picked, so the composer is replaced by a chooser and submit is blocked.
  const needsFolder = workMode === 'code' && !workspaceChosen

  // Split tool cards for rendering: the lead's own ops anchor directly beneath
  // their assistant message, while a subagent's ops (agentId set) render inside
  // that agent's nested card (requirement B). Group each accordingly.
  const leadCardsByMessage = useMemo(() => {
    const map = new Map<string, ToolCardUI[]>()
    for (const card of tools) {
      if (card.agentId != null) continue
      const list = map.get(card.afterMessageId)
      if (list) list.push(card)
      else map.set(card.afterMessageId, [card])
    }
    return map
  }, [tools])

  // Subagent tool cards keyed by the agent that ran them (rendered in its card).
  const toolsByAgent = useMemo(() => {
    const map = new Map<string, ToolCardUI[]>()
    for (const card of tools) {
      if (card.agentId == null) continue
      const list = map.get(card.agentId)
      if (list) list.push(card)
      else map.set(card.agentId, [card])
    }
    return map
  }, [tools])

  // Subagent cards grouped by the assistant message they were spawned beneath.
  const agentsByMessage = useMemo(() => {
    const map = new Map<string, AgentCardUI[]>()
    for (const agent of agents) {
      const list = map.get(agent.afterMessageId)
      if (list) list.push(agent)
      else map.set(agent.afterMessageId, [agent])
    }
    return map
  }, [agents])

  // Every op still awaiting a decision — lead or subagent — surfaced together in
  // the permission bar above the composer (requirement D).
  const awaiting = useMemo(() => tools.filter((t) => t.status === 'awaiting'), [tools])

  // Group persisted attachments by the user message they were sent with.
  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, Attachment[]>()
    for (const a of attachments) {
      if (a.messageId == null) continue
      const list = map.get(a.messageId)
      if (list) list.push(a)
      else map.set(a.messageId, [a])
    }
    return map
  }, [attachments])

  // Real context diff: sum added/removed lines across every write_file this
  // conversation proposed (old vs new contents). Reflects actual edits, not a
  // guess. `edited` is how many distinct files were touched — gates the Commit
  // button so it's only offered when there's something concrete to commit.
  const { added, removed, edited } = useMemo(() => {
    let added = 0
    let removed = 0
    const files = new Set<string>()
    for (const card of tools) {
      if (card.proposal.kind !== 'write_file') continue
      // Only count edits that were actually applied (skip rejected/failed ones).
      const applied =
        card.decision !== 'reject' && !(card.result?.kind === 'write_file' && !card.result.ok)
      if (!applied) continue
      const stat = lineDiffStats(card.proposal.oldContent, card.proposal.newContent)
      added += stat.added
      removed += stat.removed
      files.add(card.proposal.path)
    }
    return { added, removed, edited: files.size }
  }, [tools])

  // Rough token estimate (~) for the whole conversation plus the current draft.
  // Labeled with a tilde in the UI so it's never mistaken for an exact count.
  const tokenEstimate = useMemo(() => {
    let chars = input.length
    for (const m of messages) chars += m.content.length
    return estimateTokens('x'.repeat(chars))
  }, [messages, input])

  // ── Slash `/` command palette ────────────────────────────────────────────
  // A line is a slash query while it's a leading `/` followed only by name
  // characters (no space yet). The moment a space is typed the user is entering
  // arguments, so the menu closes and `submit` expands the template.
  const slashActive = /^\/[A-Za-z0-9_-]*$/.test(input)
  const slashQuery = slashActive ? input.slice(1).toLowerCase() : ''

  // Lazily (re)load commands + enabled skills whenever a slash query begins, so
  // anything added via Settings or a plugin install shows up without a restart.
  useEffect(() => {
    if (!slashActive) return
    let alive = true
    void (async () => {
      const next = await loadSlashSources()
      if (alive) setSources(next)
    })()
    return () => {
      alive = false
    }
  }, [slashActive])

  // The full, unfiltered palette: the built-in /install and /remember, then user
  // commands, then enabled skills. Filtering by the typed name happens in the lib.
  const slashItems = useMemo<SlashItem[]>(
    () => buildSlashItems(sources, slashQuery),
    [sources, slashQuery]
  )

  const menuOpen = slashActive && !menuDismissed && slashItems.length > 0

  // Keep the highlight in range as the filter narrows, and let a new `/` reopen
  // a menu that was dismissed with Escape.
  useEffect(() => {
    setMenuIndex(0)
  }, [slashQuery])
  useEffect(() => {
    if (!slashActive) setMenuDismissed(false)
  }, [slashActive])

  // Pick an item: drop `/<name> ` into the composer (trailing space closes the
  // menu and positions the caret for arguments) and refocus the textarea.
  const applySlash = (item: SlashItem): void => {
    setInput(`/${item.name} `)
    setMenuDismissed(false)
    setMenuIndex(0)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  // Auto-scroll to the newest content as it streams in (messages or tool cards).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, tools])

  // Auto-grow the textarea up to its max height. Reset to one line-height first
  // so the caret sits correctly when the field is empty (a bare `auto` collapses
  // to 0 and leaves the caret half-clipped at the top of the box).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 128)}px`
  }, [input])

  // Store each dropped/selected file as a pending attachment and stage it. Text
  // files also carry their decoded body for inlining into the engine history.
  const stageFiles = async (files: File[]): Promise<void> => {
    const sid = useChatStore.getState().sessionId
    if (!sid || files.length === 0) return
    for (const file of files) {
      try {
        const data = await fileToBase64(file)
        const mime = file.type || 'application/octet-stream'
        const attachment = await window.sylor.attachments.add({
          sessionId: sid,
          name: file.name,
          mime,
          data
        })
        const staged: PendingAttachment = { attachment }
        if (mime.startsWith('image/')) {
          staged.thumbnailUrl = `data:${mime};base64,${data}`
        } else if (isTextLike(mime, file.name)) {
          try {
            staged.textContent = await file.text()
          } catch {
            // Unreadable as text: fall back to a metadata-only note.
          }
        }
        setPending((prev) => [...prev, staged])
      } catch (err) {
        console.error('[sylor] failed to stage attachment:', err)
      }
    }
  }

  const removePending = (id: string): void => {
    setPending((prev) => prev.filter((p) => p.attachment.id !== id))
    void window.sylor.attachments.remove(id)
  }

  const onFilesPicked = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files ? Array.from(event.target.files) : []
    void stageFiles(files)
    // Reset so picking the same file again re-fires change.
    event.target.value = ''
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : []
    void stageFiles(files)
  }

  const submit = async (): Promise<void> => {
    const outgoing: OutgoingAttachment[] = pending.map((p) => ({
      attachment: p.attachment,
      ...(p.textContent != null ? { textContent: p.textContent } : {})
    }))
    // `startRun` owns the whole sequence — slash expansion, creating the session row
    // a draft chat doesn't have yet, sending, and titling the chat — so the palette
    // starts a turn exactly the way this composer does. It also re-checks the three
    // blocked states against live store state, which is why there is no guard here.
    const result = await startRun(input, { attachments: outgoing, sources })
    if (!result.sent) return
    // It may have fetched the catalogs to expand a `/command`; keep that copy so the
    // next line doesn't pay for the read again.
    if (result.sources !== sources) setSources(result.sources)
    setInput('')
    setPending([])
  }

  // Commit the session's edits. Routes through the normal permission-gated
  // workflow (the engine proposes `git add`/`git commit` as a run_command the
  // user approves) — no permission bypass here; that lands with the power mode.
  const commitChanges = (): void => {
    if (running || edited === 0) return
    send(
      'Stage all current changes and create a single git commit summarizing this ' +
        "session's edits. Run `git add -A` then `git commit -m` with a concise, " +
        'descriptive message. If this directory is not a git repository, tell me instead ' +
        'of committing.'
    )
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the slash menu is open it owns the arrows, Enter/Tab (select), and
    // Escape (dismiss); Enter must not also submit the raw `/name` line.
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMenuIndex((i) => (i + 1) % slashItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMenuIndex((i) => (i - 1 + slashItems.length) % slashItems.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = slashItems[menuIndex]
        if (item) applySlash(item)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const canSend = (input.trim().length > 0 || pending.length > 0) && !needsFolder
  const canAttach = sessionId != null

  return (
    <div className="flex h-full flex-col bg-bg">
      <ChatHeader onNewChat={() => void newSession()} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-5 px-4 py-4">
            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                isActive={message.id === lastId && message.role === 'assistant'}
                status={status}
                progress={progress}
                todos={todos}
                cards={leadCardsByMessage.get(message.id) ?? []}
                agents={agentsByMessage.get(message.id) ?? []}
                agentTools={toolsByAgent}
                attachments={attachmentsByMessage.get(message.id) ?? []}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="border-t border-border p-3"
        onDragOver={(e) => {
          if (!canAttach) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={canAttach ? onDrop : undefined}
      >
        {/* Pending approvals sit directly above the composer (requirement D). */}
        <PermissionBar awaiting={awaiting} onDecide={decideTool} />
        {/* …and the grants that are keeping that bar from appearing, so "it stopped
            asking" is always visible and always one click from being undone. */}
        <StandingBar keys={standing} onRevoke={revokeStanding} />
        {/* A blocking clarifying question sits in the same spot; the run is paused
            until it's answered. */}
        {question && <QuestionBar question={question} onAnswer={answerQuestion} />}
        {/* And the plan-first checkpoint: the plan is written, nothing is built, and
            the turn waits here for a go-ahead. */}
        {planApproval && <PlanApprovalBar approval={planApproval} onDecide={decidePlan} />}
        {/* Follow-ups flagged during the turn, last because they block nothing: the
            work is already recorded and these are just the "do it now" affordance. */}
        <FollowupBar
          followups={followups}
          disabled={running}
          onStart={(followup) => send(buildFollowupPrompt(followup))}
          onDismiss={dismissFollowup}
        />
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((p) => (
              <AttachmentChip
                key={p.attachment.id}
                name={p.attachment.name}
                mime={p.attachment.mime}
                size={p.attachment.size}
                thumbnailUrl={p.thumbnailUrl ?? null}
                onRemove={() => removePending(p.attachment.id)}
              />
            ))}
          </div>
        )}
        {needsFolder ? (
          <FolderGate onChoose={() => void selectWorkspace()} />
        ) : (
          <div
            className={
              'relative flex items-end gap-2 rounded-lg border bg-surface px-3 py-2 focus-within:border-primary/50 ' +
              (dragging ? 'border-primary' : 'border-border')
            }
          >
            {menuOpen && (
              <SlashMenu
                items={slashItems}
                activeIndex={menuIndex}
                onSelect={applySlash}
                onHover={setMenuIndex}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={onFilesPicked}
              className="hidden"
            />
            <button
              type="button"
              aria-label="Attach files"
              title={canAttach ? 'Attach files' : 'Start a chat to attach files'}
              disabled={!canAttach}
              onClick={() => fileInputRef.current?.click()}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M14 6.5l-6 6a2 2 0 0 1-3-3l6.5-6.5a3 3 0 0 1 4.5 4.5L9 14"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                dragging
                  ? 'Drop files to attach…'
                  : workMode === 'cowork'
                    ? 'Ask Sylor anything…'
                    : 'Ask Sylor to explain, edit, or run something…'
              }
              className="block max-h-32 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-6 text-text placeholder:text-muted focus:outline-none"
            />
            {running ? (
              <button
                type="button"
                onClick={cancel}
                aria-label="Stop"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-2 text-text transition-colors hover:bg-border"
              >
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label="Send"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M2 8h11M9 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {/* Folder chip (requirement A): which folder Code mode is scoped to. */}
            {workMode === 'code' && workspaceChosen && workspaceRoot && (
              <button
                type="button"
                onClick={() => void selectWorkspace()}
                title={`Working in ${workspaceRoot} · click to change folder`}
                className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary/60 hover:text-text"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M2 4.5a1 1 0 0 1 1-1h2.5l1.2 1.4h5.3a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="max-w-[120px] truncate font-medium">
                  {basename(workspaceRoot)}
                </span>
              </button>
            )}
            <ModelSelector openUp />
            <EffortSelector openUp />
            {/* Permission mode + plan-first only apply to Code mode (edits/commands). */}
            {workMode === 'code' && (
              <>
                <ModeSelector openUp />
                <PlanFirstToggle />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Real context diff from applied write_file edits. */}
            {(added > 0 || removed > 0) && (
              <span
                className="flex items-center gap-1 font-mono text-[11px]"
                title={`${added} lines added, ${removed} removed across ${edited} file${edited === 1 ? '' : 's'}`}
              >
                <span className="text-emerald-500">+{formatCount(added)}</span>
                <span className="text-red-400">-{formatCount(removed)}</span>
              </span>
            )}
            {/* Measured context load while a run is live; the conversation
                estimate otherwise (see ContextMeter). */}
            <ContextMeter estimate={tokenEstimate} />
            {/* Commit the session's edits via the permission-gated workflow. */}
            <button
              type="button"
              onClick={commitChanges}
              disabled={running || edited === 0}
              title={
                edited === 0
                  ? 'No edits to commit yet'
                  : `Commit ${edited} changed file${edited === 1 ? '' : 's'}`
              }
              className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text transition-colors hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M8 1.5v4M8 10.5v4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              Commit
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
