import { create } from 'zustand'
import { isBundlerEntryHtml } from '@shared/preview'
import { parseSlash } from '@shared/commands'
import { standingApprovalKey } from '@shared/approvals'
import type {
  AgentRole,
  Attachment,
  ChatMessage,
  CheckpointInfo,
  ContextUsage,
  Followup,
  IntentAnalysis,
  PendingPlan,
  PendingQuestion,
  PersistedSession,
  PersistedToolOp,
  RestoreResult,
  RunProgress,
  TaskState,
  TodoItem,
  ToolDecision,
  ToolDecisionDetail,
  ToolProposal,
  ToolResult,
  WorkflowEvent,
  WorkflowStage
} from '@shared/types'
import { useAppStore } from './useAppStore'
import { takeReveal } from '../lib/reveal'

/**
 * Commands that produce a static build (into dist/, build/, out/, …). After one
 * succeeds, we ask the preview to serve the freshly built HTML: startStatic()
 * with no entry resolves the first built-output entry that exists and, when it
 * finds one, the resulting `ready` event opens the panel. Dev-server commands
 * (npm run dev, vite, …) are handled entirely in the main-process engine, which
 * routes them to the preview's managed pty — the renderer plays no part there.
 */
const BUILD_RE =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?build|(vite|next|astro|parcel|webpack)\s+build)\b/i

/**
 * How often (ms) buffered stream deltas are flushed into the rendered message.
 * Appending to a growing Markdown message on every token would re-parse and
 * re-highlight the whole thing each time — O(n²) work that freezes the UI on a
 * large response. Coalescing to ~15fps keeps streaming smooth without a hang.
 *
 * It doubles as the reveal cadence: a tick shows part of whatever is queued (see
 * `lib/reveal.ts`), so text that arrived as one big delta still types out.
 */
const DELTA_FLUSH_MS = 66

/**
 * How often (ms) the still-streaming assistant reply is checkpointed to the DB.
 *
 * Tool ops are persisted the instant each completes, but the assistant's prose
 * used to be written only once, on `done`. So if a run was interrupted before it
 * finished — the app reopened, a new session started, a crash — every tool op
 * survived while the entire reply was lost, and the reloaded session looked
 * wiped (user turn + orphaned tool cards, no answer). Checkpointing the prose on
 * a ~1s cadence (in addition to the final `done`/`error` write) bounds the
 * worst-case loss to the last second of tokens, matching how durably tool ops
 * and the user turn are already saved. Cheap: a throttled local SQLite upsert.
 */
const ASSISTANT_PERSIST_MS = 1000

/** A chat message as rendered in the UI (adds id + streaming/error metadata). */
export interface ChatMessageUI {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** True while the assistant reply is still streaming. */
  pending?: boolean
  /** Set when the run ended in error. */
  error?: string
  /** Local-only 👍/👎 reaction; absent when none. Never transmitted anywhere. */
  feedback?: 'like' | 'dislike'
  /** Local-only "reported" marker the user toggled. Never transmitted. */
  flagged?: boolean
  /**
   * When the user turn began as a `/command` (Claude-CLI style), this is the
   * recognized command token (sans slash). The composer sends the *expanded*
   * prompt to the engine but stores the raw `/name …` here for display, so the
   * bubble can render the command as a highlighted mention chip instead of the
   * expanded text. Live-only (not persisted) — a reloaded turn shows plain text.
   */
  slashCommand?: string
}

/** Lifecycle of a proposed tool op as shown in the chat thread. */
export type ToolCardStatus = 'awaiting' | 'running' | 'complete'

/** A proposed tool op (edit/command) rendered as an inline card. */
export interface ToolCardUI {
  /** The proposal's tool id (unique per run). */
  id: string
  runId: string
  /** The assistant message this card is anchored beneath. */
  afterMessageId: string
  proposal: ToolProposal
  /** True when the permission mode pre-approved it (informational card). */
  auto: boolean
  status: ToolCardStatus
  /** The user's decision, once made. */
  decision?: ToolDecision
  /** Populated once the op completes. */
  result?: ToolResult
  /**
   * Character offset into the anchor message's streamed content at which this
   * card was proposed — i.e. how much prose had arrived when the tool block was
   * parsed. Lets the thread interleave prose and cards in stream order (think →
   * act → think, across steps). Absent for ops persisted before this was
   * tracked; those sort to the end.
   */
  contentOffset?: number
  /**
   * When set, this op was performed by a subagent (requirement B) and renders
   * *inside* that agent's nested card rather than inline under the assistant
   * message. Absent for the lead's own ops. `contentOffset` on a subagent card
   * is relative to the agent's content, not the lead's.
   */
  agentId?: string
  /** The subagent's role, mirrored from its {@link AgentCardUI} for rendering. */
  agentRole?: AgentRole
  /**
   * Wall-clock ms the op was proposed / its result landed, taken from the event's
   * own stamp (see {@link WorkflowEventMeta}) rather than measured in the renderer,
   * so a card restored from disk reports the same times as the live one. Both
   * absent on ops from before the columns existed; the UI then shows no duration
   * instead of a made-up one.
   */
  startedAt?: number
  endedAt?: number
  /**
   * True when the user rewrote the proposal in the diff before approving it, so
   * what landed on disk is their text. The card's `proposal.newContent` is swapped
   * to the edited body at the same time — the diff you review afterwards is the
   * one that actually happened, not the one that was offered.
   */
  edited?: boolean
}

/** Lifecycle of a nested subagent card in the chat thread. */
export type AgentCardStatus = 'running' | 'complete'

/**
 * A subagent the lead delegated to (requirement B), rendered as a nested card
 * beneath the assistant message: it shows the role + assigned task, streams the
 * subagent's own prose, hosts its tool cards (matched by {@link ToolCardUI.agentId}),
 * and closes with the report handed back to the lead. Live-only — subagent
 * structure isn't persisted, so a reloaded session shows the applied ops flat.
 */
export interface AgentCardUI {
  /** Correlates the subagent's status/delta/tool events (from the engine). */
  agentId: string
  runId: string
  /** The assistant message this nested card is anchored beneath. */
  afterMessageId: string
  role: AgentRole
  /** The task the lead assigned when it spawned this subagent. */
  task: string
  status: AgentCardStatus
  /** The subagent's streamed prose so far. */
  content: string
  /** Final summary the subagent handed back to the lead (set on completion). */
  report?: string
  /** Whether the subagent finished without being aborted/erroring. */
  ok?: boolean
  /** Offset into the LEAD's content at which this card was spawned (stream order). */
  contentOffset?: number
  /** A background (non-blocking) spawn: the lead kept working while it ran. */
  background?: boolean
  /** Running in a private git worktree (isolated writes/commands). */
  isolation?: 'worktree'
  /**
   * Set the moment the user asks for this lane to stop, cleared by the `agent-end`
   * that actually closes it. The engine has to unwind the loop (and any tool it is
   * mid-way through), so the gap is real — the lane says "Stopping…" for it rather
   * than pretending the click already took effect.
   */
  cancelling?: boolean
}

/** Live activity line shown while a run is in progress. */
export interface ActivityStatus {
  stage: WorkflowStage
  message: string
  /** Set while the engine is between retry attempts, so the UI can dim the line. */
  retrying?: boolean
}

/**
 * Where the whole build stands, for the live status row (§33): which phase of how
 * many, how far through the phase's task graph, whether the project's own checks
 * passed, and what the preview is actually showing.
 *
 * Deliberately its OWN store field rather than part of {@link ActivityStatus}:
 * `status` is replaced wholesale on every status/tool-request/agent-start event,
 * so anything living inside it is clobbered a few times a second. This is sticky
 * instead — the engine sends `progress` only when it changes, each field is
 * merged over the last known value, and the whole thing clears when the run ends.
 */
export interface RunProgressUI extends RunProgress {
  /** Derived from the run's own `plan` + `task-update` events, not sent by the engine. */
  tasks?: { done: number; total: number }
}

/**
 * What a run-log row is about, so the log can style it and link it back to the
 * card that holds the full input/output. `phase` rows are the engine's own status
 * stream; the rest mark a concrete event.
 */
export type ActivityKind =
  | 'phase'
  | 'tool'
  | 'agent'
  | 'plan'
  | 'question'
  | 'followup'
  | 'checkpoint'
  | 'run-end'

/**
 * One step in the run log: a flat, append-ordered, timestamped list of everything
 * the engine reported this turn, with `agentId` attributing a row to the subagent
 * that caused it. This is the single event trace the log surface reads — phases,
 * tool proposals and their outcomes, subagent spawns and reports — and `toolId` /
 * `agentId` link a row back to the {@link ToolCardUI} / {@link AgentCardUI} that
 * already holds the full detail, so no payload is duplicated here.
 *
 * `done` marks a *phase* row superseded by the next one, so the log can render
 * finished phases quietly and the current one as active. Renderer-only state: it
 * is never an IPC payload, and it is rebuilt (from persisted ops) rather than
 * stored when a conversation is reopened.
 */
export interface ActivityStep {
  id: string
  /** Wall-clock ms from the event's own stamp; falls back to arrival time. */
  at: number
  kind: ActivityKind
  stage: WorkflowStage
  message: string
  done: boolean
  /** The subagent this row belongs to; absent = the lead. */
  agentId?: string
  agentRole?: AgentRole
  /** The tool op this row is about, matching {@link ToolCardUI.id}. */
  toolId?: string
  /** Outcome, once known: `false` renders calm-amber rather than red. */
  ok?: boolean
}

/**
 * Append a phase row, marking the previous PHASE row done — the previous row may
 * now be a tool/agent row, and a concrete op finishing says nothing about whether
 * the phase around it did. A status identical to the current tail is a no-op (the
 * engine can re-emit the same phase back to back); the same status *after* an op
 * is a new row, because chronologically it happened again. Returns the same array
 * reference when nothing changed so callers can skip a needless re-render.
 */
function appendActivity(
  list: ActivityStep[],
  stage: WorkflowStage,
  message: string,
  at: number
): ActivityStep[] {
  const last = list[list.length - 1]
  if (last && last.kind === 'phase' && last.stage === stage && last.message === message) return list
  const next = closeLastPhase(list)
  next.push({ id: nextActivityId(), at, kind: 'phase', stage, message, done: false })
  return next
}

/**
 * Append a concrete event row (a tool op, a subagent spawn, a flagged follow-up).
 * Never deduplicated — each row records that a specific thing happened at a
 * specific time — and never touches the surrounding phase rows.
 */
function appendEvent(list: ActivityStep[], row: Omit<ActivityStep, 'id'>): ActivityStep[] {
  return [...list, { id: nextActivityId(), ...row }]
}

/**
 * Flip an in-flight row to finished once its outcome is known (a tool result, a
 * subagent's report, an answered question). Matches on the id the row was opened
 * with — `toolId` covers every kind of row keyed by an engine-minted id, since
 * those ids are unique across ops, questions and plans — so an event that arrives
 * for a row we never saw is simply ignored rather than mislabelling one.
 * `ok` is only recorded when the engine actually states it — a tool row leaves it
 * unset and the log reads success/failure off the linked card, so the rule for
 * "did this op fail" lives in exactly one place.
 */
function finishActivity(
  list: ActivityStep[],
  match: { toolId?: string; agentId?: string },
  ok?: boolean
): ActivityStep[] {
  const i = list.findIndex((s) =>
    match.toolId != null
      ? s.toolId === match.toolId
      : s.kind === 'agent' && s.agentId === match.agentId
  )
  if (i < 0) return list
  const next = [...list]
  next[i] = { ...next[i], done: true, ...(ok != null ? { ok } : {}) }
  return next
}

/** Mark the most recent phase row done (a new phase, or the run itself, ended). */
function closeLastPhase(list: ActivityStep[]): ActivityStep[] {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].kind !== 'phase') continue
    if (list[i].done) break
    const next = [...list]
    next[i] = { ...next[i], done: true }
    return next
  }
  return [...list]
}

/**
 * Fold the task-graph tally into the sticky progress (§33). Derived in the
 * renderer because it already receives every node transition — the engine
 * doesn't need to count for us. A single-node graph reports no counter at all:
 * "1/1 tasks" on a one-file edit is noise, not progress.
 */
function withTasks(
  progress: RunProgressUI | null,
  states: Map<string, TaskState>
): RunProgressUI | null {
  const total = states.size
  if (total < 2) return progress
  let done = 0
  for (const state of states.values()) if (state === 'completed') done += 1
  return { ...(progress ?? {}), tasks: { done, total } }
}

/** Last path segment of a POSIX/Windows path, for a compact status label. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/** Clip a long string for a single status line. */
function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Prefix for the sticky row while a gated op sits unanswered. The row is the one
 * line always on screen, so it must not read as work in flight when Sylor is
 * blocked on a decision the user has not made yet.
 */
const AWAITING_PREFIX = 'Waiting for your go-ahead · '

/**
 * Turns a proposed tool op into the live status line the top bar shows — an
 * active-voice "what's happening now" with the concrete target, e.g. "Creating
 * index.html", "Editing App.tsx", "Reading types.ts", "Reviewing engine.ts".
 * When the acting agent is the reviewer, a file read reads as "Reviewing" rather
 * than "Reading", so the four verbs mirror what the user actually sees happening.
 */
function describeProposal(
  proposal: ToolProposal,
  role?: AgentRole
): { stage: WorkflowStage; message: string } {
  switch (proposal.kind) {
    case 'write_file':
      return {
        stage: 'executing',
        // The purpose the model attached, when it did — "Creating Button.tsx" says
        // what is happening, "· the shared button every page uses" says why.
        message:
          `${proposal.exists ? 'Editing' : 'Creating'} ${baseName(proposal.path)}` +
          (proposal.purpose ? ` · ${proposal.purpose}` : '')
      }
    case 'read': {
      if (proposal.op === 'read_file') {
        return {
          stage: 'reading',
          message: `${role === 'reviewer' ? 'Reviewing' : 'Reading'} ${baseName(proposal.path)}`
        }
      }
      if (proposal.op === 'list_files') {
        const where = !proposal.path || proposal.path === '.' ? 'the project' : baseName(proposal.path)
        return { stage: 'reading', message: `Scanning ${where}` }
      }
      return { stage: 'reading', message: `Searching ${clip(proposal.query || proposal.glob || '…', 40)}` }
    }
    case 'run_command':
      return { stage: 'executing', message: `Running ${clip(proposal.command, 48)}` }
    case 'mcp_call':
      return { stage: 'executing', message: `Calling ${proposal.name}` }
    case 'web_fetch':
      return { stage: 'executing', message: `Fetching ${clip(proposal.url, 48)}` }
    case 'web_search':
      return { stage: 'executing', message: `Searching ${clip(proposal.query, 48)}` }
    case 'install_plugin':
      return { stage: 'executing', message: `Installing ${clip(proposal.source, 48)}` }
    case 'preview_inspect':
      return { stage: 'verifying', message: previewStatus(proposal) }
    case 'browse':
      return { stage: 'executing', message: browseStatus(proposal) }
    case 'diagnostics':
      return {
        stage: 'verifying',
        message:
          proposal.scope === 'all'
            ? 'Checking for problems'
            : `Checking for problems · ${proposal.scope}`
      }
  }
}

/**
 * Status line for a browse step, phrased as the page-level action the user can
 * watch happen in the browser panel beside the chat ("Opening gmail.com",
 * "Clicking Compose") rather than as a tool name.
 */
function browseStatus(proposal: Extract<ToolProposal, { kind: 'browse' }>): string {
  const what = proposal.target ? ` ${clip(proposal.target, 32)}` : ''
  switch (proposal.action) {
    case 'navigate': {
      const url = proposal.url ?? ''
      let where = url
      try {
        where = new URL(url.includes('://') ? url : `https://${url}`).host
      } catch {
        // Not a url — the engine searches for it, so show the words as typed.
      }
      return `Opening ${clip(where, 40)}`
    }
    case 'click':
      return `Clicking${what || ' the page'}`
    case 'type':
      return `Typing into${what || ' the page'}`
    case 'scroll':
      return `Scrolling ${proposal.direction ?? 'down'}`
    case 'console':
      return 'Reading the page console'
    case 'network':
      return 'Reading the page requests'
    case 'inspect':
      return `Inspecting ${clip(proposal.selector ?? 'an element', 32)}`
    default:
      return 'Reading the page'
  }
}

/**
 * Status line for a preview step, phrased as the thing the user can watch happen
 * in the preview pane ("Looking at the preview", "Opening /about") rather than as
 * an action name. Mirrors {@link browseStatus} for the pane beside it.
 */
function previewStatus(proposal: Extract<ToolProposal, { kind: 'preview_inspect' }>): string {
  const target = clip(proposal.selector ?? 'an element', 32)
  switch (proposal.action) {
    case 'screenshot':
      return 'Looking at the preview'
    case 'snapshot':
      return 'Reading the preview'
    case 'inspect':
      return `Inspecting ${target}`
    case 'console_logs':
      return 'Checking the preview console'
    case 'network':
      return 'Checking the preview requests'
    case 'click':
      return `Clicking ${target}`
    case 'fill':
      return `Typing into ${target}`
    case 'resize':
      return `Resizing the preview${
        proposal.preset
          ? ` to ${proposal.preset}`
          : proposal.width && proposal.height
            ? ` to ${proposal.width}×${proposal.height}`
            : ''
      }`
    case 'eval':
      return 'Running JS in the preview'
    case 'navigate':
      return proposal.url ? `Opening ${clip(proposal.url, 40)}` : 'Reloading the preview'
    case 'server_logs':
      return 'Checking the dev server log'
    default:
      return 'Checking the preview'
  }
}

/**
 * An attachment being sent with a user turn. `textContent` is the decoded body
 * for text-like files (read by the composer), inlined into the engine history so
 * the model can see the file; binary/image files carry only metadata and are
 * referenced by a note.
 */
export interface OutgoingAttachment {
  attachment: Attachment
  /** Decoded text body for text-like mimes; undefined for binary/images. */
  textContent?: string
}

/**
 * An in-flight run, tracked independently of which conversation is on screen so
 * it keeps going when the user switches sessions ("background processing"). Its
 * IPC event listener stays attached; each event is routed to THIS run's owner
 * session — buffered here and persisted to that session — and mirrored into the
 * visible store only while its owner session is the one being viewed. Switching
 * back re-attaches to the live `content`/`tools` here (see {@link projectLiveRun}).
 */
interface LiveRun {
  runId: string
  /** The session this run writes to (persisted results land here), or null. */
  ownerSessionId: string | null
  /** The assistant message id this run streams into. */
  assistantId: string
  /** Flushed assistant prose so far (authoritative; survives session switches). */
  content: string
  /** Tool cards proposed by this run (awaiting/running/complete). */
  tools: ToolCardUI[]
  /** Nested subagent cards opened by this run (requirement B). */
  agents: AgentCardUI[]
  /** Latest activity status, mirrored to the store while visible. */
  status: ActivityStatus | null
  /** Sticky build progress (§33), merged from every `progress` the engine sends. */
  progress: RunProgressUI | null
  /**
   * State of each planned task node, keyed by id — seeded by the `plan` event and
   * updated by `task-update`. Only exists to derive `progress.tasks`; the engine
   * doesn't count for us because the renderer already receives every transition.
   */
  taskStates: Map<string, TaskState>
  /**
   * The lead's flat, self-maintained TODO checklist for this run (Claude-Code's
   * TodoWrite). Replaced wholesale by each `todos` event. Live-only — never
   * persisted; the finished assistant turn stands on its own, so a reopened run
   * with no live entry shows no checklist.
   */
  todos: TodoItem[]
  /**
   * The clarifying question (the `ask_user` tool) this run is currently BLOCKED on,
   * or null when it isn't waiting on one. Set by a `question` event and cleared when
   * the user answers ({@link ChatStore.answerQuestion}). Live-only — like the
   * checklist it is never persisted; a reopened finished run is never blocked.
   */
  question: PendingQuestion | null
  /**
   * The plan this run is BLOCKED on for a go-ahead (the "Plan first" checkpoint),
   * or null. Set by a `plan-approval` event and cleared when the user decides.
   * Live-only, like {@link question} — a reopened finished run is never waiting.
   */
  planApproval: PendingPlan | null
  /**
   * Out-of-scope issues this run flagged (the `flag_followup` tool), oldest first.
   * Appended to, never replaced. Unlike {@link LiveRun.todos} these are NOT cleared
   * when the turn ends — the user acts on them afterwards — so the chips are dropped
   * only when the conversation moves on (a new send, a regenerate, a clear, a switch).
   */
  followups: Followup[]
  /** Ordered activity timeline (one step per distinct status), mirrored while visible. */
  activity: ActivityStep[]
  /**
   * Measured context load for the next completion, or null before the first step.
   * Comes from the engine (only it can see the assembled array), lead only.
   *
   * Restore points are deliberately NOT here: a checkpoint belongs to the project on
   * disk, not to one conversation, so the list lives on {@link ChatState} alone and
   * is read back with `checkpoints.list()`.
   */
  usage: ContextUsage | null
  /**
   * Standing approvals granted with "Always" this run — the renderer's mirror of the
   * engine's own set, keyed by {@link standingApprovalKey}. Its only job is to make a
   * grant VISIBLE (and withdrawable) while it is in force: an approval that silently
   * changes how the rest of the run behaves is the one thing the permission bar exists
   * to prevent. The engine remains the authority — it re-derives every key itself.
   */
  standing: string[]
  /** Intent interpretation for this run. */
  intent: IntentAnalysis | null
  /** Cancels the main-process run and detaches its event listener. */
  disposer: () => void
  /** Un-flushed lead delta text, drained by the flush timer. */
  buffer: string
  /** Un-flushed subagent delta text, keyed by agentId, drained by the same timer. */
  agentBuffers: Map<string, string>
  /** Pending flush timer id, or null when idle. */
  flushTimer: ReturnType<typeof setTimeout> | null
  /**
   * `Date.now()` of the last time the streaming prose was checkpointed to the DB,
   * or 0 before the first checkpoint. Throttles the mid-run persistence in
   * {@link ASSISTANT_PERSIST_MS} so an interrupted run keeps its reply.
   */
  lastPersist: number
}

/**
 * Live runs keyed by their owner session id. A session has at most one active
 * run (send/regenerate are blocked while `running`). Entries are removed on
 * done/error/cancel/clear.
 */
const liveRuns = new Map<string, LiveRun>()

export interface ChatState {
  messages: ChatMessageUI[]
  /** Proposed tool ops for the conversation, in stream order. */
  tools: ToolCardUI[]
  /** Nested subagent cards for the active/last run (requirement B); live-only. */
  agents: AgentCardUI[]
  /** Attachments tied to sent user messages (chips render under each message). */
  attachments: Attachment[]
  /** True while a workflow run is active. */
  running: boolean
  /** Current run id (for cancellation), or null when idle. */
  runId: string | null
  /** Live activity status ("Reading files…"), or null. */
  status: ActivityStatus | null
  /**
   * Where the build stands for the active run (§33) — phase, tasks, checks,
   * preview — or null when the turn is a one-off with no roadmap behind it.
   * Rendered as chips on the same single status row, never as a second block.
   */
  progress: RunProgressUI | null
  /**
   * The active run's flat TODO checklist — the lead's own `update_todos` list,
   * rendered as a small evolving panel during the turn. Empty when idle or when
   * the turn keeps no checklist. Live-only, cleared when the turn ends.
   */
  todos: TodoItem[]
  /**
   * The clarifying question the active run is blocked on (the `ask_user` tool), or
   * null. When set, the composer shows an answer bar; answering it resumes the run.
   * Live-only, cleared when the turn ends or the user answers.
   */
  question: PendingQuestion | null
  /**
   * The plan the active run is waiting on a go-ahead for ("Plan first"), or null.
   * When set, an approval bar is shown; approving builds the plan in the same turn,
   * rejecting stops the run. Live-only, cleared when the turn ends or is decided.
   */
  planApproval: PendingPlan | null
  /**
   * Out-of-scope issues the last/active run flagged, rendered as chips above the
   * composer: each one can be started as its own turn or dismissed. They deliberately
   * OUTLIVE the turn (the user reads the answer, then decides), and are cleared when
   * the conversation moves on — the next send, a regenerate, a clear, a session switch.
   * The project's `FOLLOWUPS.md` is the durable record; these chips are the affordance.
   */
  followups: Followup[]
  /**
   * Ordered live activity timeline for the active run — the progressive sequence
   * of phases (Understanding → Reading → Planning → …) the UI renders in place of
   * a single spinner. Empty when idle.
   */
  activity: ActivityStep[]
  /**
   * Standing approvals in force for the active run (keys from `standingApprovalKey`),
   * shown as chips above the composer so "I stopped being asked" is always something
   * the user can SEE and undo. Empty when idle — a grant dies with its run.
   */
  standing: string[]
  /** The intent interpretation for the active/last run ("You want to…"). */
  intent: IntentAnalysis | null
  /**
   * Restore points recorded for this project, newest first. Read from disk with
   * `checkpoints.list()` ({@link ChatState.refreshCheckpoints}) and extended live by
   * the engine's `checkpoint` events. Project-scoped, not conversation-scoped: the
   * timeline is about the folder, so it survives switching chats.
   */
  checkpoints: CheckpointInfo[]
  /**
   * Measured context load for the active run's next completion, or null when idle /
   * before its first step. Drives the footer meter.
   */
  usage: ContextUsage | null
  /** Disposer for the active run's event subscription. */
  disposer: (() => void) | null
  /** The persisted session this conversation is being written to, or null. */
  sessionId: string | null
  /** Project the active session is filed under (drives per-project instructions). */
  projectId: string | null
  /**
   * Ids of every session with a run still in flight — including runs owned by
   * conversations that are NOT on screen. A reactive mirror of the module-level
   * {@link liveRuns} map, which React can't subscribe to. Without it, background
   * runs were invisible: opening a New Chat mid-task left no trace of the old one
   * anywhere in the UI, so a run that was still going looked paused or lost.
   */
  liveSessionIds: string[]

  /**
   * Send a user turn and start a workflow run. No-op while already running or
   * when both text and attachments are empty. Attachments are bound to the user
   * message and their content is folded into the engine history.
   *
   * `text` is what the user sees (stored on the message). `engineText`, when
   * given, is what the engine actually receives instead — used for `/command`
   * expansion, where the bubble shows the raw `/name …` but the model gets the
   * expanded prompt.
   */
  send: (text: string, attachments?: OutgoingAttachment[], engineText?: string) => void
  /**
   * Approve or reject a pending tool proposal. `detail` carries the two things a
   * verdict can come with: the file body the user edited in the diff before letting
   * it through, and the reason they said no (both fed to the engine as-is).
   */
  decideTool: (toolId: string, decision: ToolDecision, detail?: ToolDecisionDetail) => void
  /**
   * Stop ONE subagent lane without ending the run. The lane shows "Stopping…" until
   * the engine's `agent-end` closes it; the lead carries on with that report.
   */
  cancelAgent: (agentId: string) => void
  /**
   * Withdraw a standing "Always" approval, so the next op of that class asks again.
   * Keyed by {@link standingApprovalKey}; a no-op once the run has ended.
   */
  revokeStanding: (key: string) => void
  /**
   * Answer the clarifying question the active run is blocked on (the `ask_user`
   * tool), resuming it. No-op when nothing is waiting. Clears {@link ChatState.question}.
   */
  answerQuestion: (answer: string) => void
  /**
   * Approve or reject the plan the active run is waiting on ("Plan first").
   * Approving lets the SAME turn build it; rejecting stops the run without a retry —
   * a reject is a decision, not a failure. No-op when nothing is waiting.
   */
  decidePlan: (decision: 'approve' | 'reject') => void
  /**
   * Drop a flagged follow-up's chip. The entry in `FOLLOWUPS.md` is deliberately
   * LEFT ALONE — dismissing means "not now", and the written record is the whole
   * point of flagging it. A no-op when the id isn't showing.
   */
  dismissFollowup: (id: string) => void
  /** Cancel the active run, keeping whatever was streamed so far. */
  cancel: () => void
  /**
   * Re-read the project's restore points from disk into {@link ChatState.checkpoints}.
   * Called when the timeline opens and after a restore, so the list is never a stale
   * copy of a folder that has moved on.
   */
  refreshCheckpoints: () => void
  /**
   * Roll the project back to one checkpoint. Resolves the engine's own verdict — how
   * many files were rewritten, and the safety point taken first — so the caller can
   * report what actually happened instead of assuming it worked. Refreshes the list.
   */
  restoreCheckpoint: (id: string) => Promise<RestoreResult>
  /** Clear the whole conversation (cancels any active run first). */
  clear: () => void
  /**
   * Cancel the background run owned by `sessionId`, whichever conversation is on
   * screen. Used before deleting a chat: otherwise its run kept going against a
   * row that no longer exists — still spending tokens and still writing files —
   * with nowhere left in the UI to stop it. A no-op when that session has no run.
   */
  cancelSession: (sessionId: string) => void
  /**
   * Toggle a local like/dislike reaction on a message. Clicking the same value
   * again clears it. Local-only (persisted for reload, never transmitted).
   */
  setFeedback: (messageId: string, feedback: 'like' | 'dislike') => void
  /** Toggle the local "reported" flag on a message. Local-only. */
  toggleFlag: (messageId: string) => void
  /**
   * Rewrite/regenerate an assistant message: re-run the workflow over the history
   * up to (but not including) it, streaming into the SAME message id. Drops the
   * message's old tool cards and clears its content first. No new user turn is
   * appended. No-op while a run is active or if the id isn't an assistant turn.
   */
  regenerate: (messageId: string) => void
  /**
   * Rehydrate the conversation from a loaded session (synchronous). Replaces
   * messages/tools, binds to the session id, and reconciles the id counters so
   * new ids never collide with restored ones. Orchestrated by the session store.
   */
  applyLoaded: (loaded: PersistedSession) => void
  /**
   * Reset to an empty conversation (synchronous). Pass a session id to bind to a
   * freshly-created row, or `null` for an unsaved draft — the landing page shown
   * on launch and after "New chat", before the first message persists a row.
   */
  resetTo: (sessionId: string | null, projectId?: string | null) => void
}

/**
 * A salt fixed once per app launch, mixed into every id that gets persisted as a
 * DB primary key (messages, runs). The counters below reset to 0 on every launch,
 * so a bare `msg-1` minted in a fresh session reuses an id a PREVIOUS run already
 * wrote — and `appendMessage`'s `INSERT … ON CONFLICT(id) DO UPDATE` then
 * overwrites that other session's row and saves nothing to the new one: the turn
 * vanishes AND the older chat is silently corrupted. The launch-time salt makes
 * ids globally unique across runs, exactly like the main-process generators that
 * embed `Date.now()` (`sess-`/`att-`/`proj-`). base36 keeps it compact.
 */
const ID_SALT = Date.now().toString(36)
let idCounter = 0
const nextId = (): string => `msg-${ID_SALT}-${++idCounter}`
let runCounter = 0
const nextRunId = (): string => `run-${ID_SALT}-${++runCounter}`
// Activity-step ids are render-only (never persisted), so they need no salt.
let activityCounter = 0
const nextActivityId = (): string => `act-${++activityCounter}`

/**
 * After rehydrating persisted ids ('msg-7', 'run-3'), advance the in-memory
 * counters past the highest seen so freshly-minted ids never collide with
 * restored ones. Ids that don't match the numeric pattern are ignored.
 */
function bumpCountersFrom(ids: string[], prefix: string, set: (n: number) => void): void {
  let max = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  set(max)
}

/** Human-readable byte size for an attachment note (e.g. "12.4 KB"). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Fold outgoing attachments into a block appended to the engine's user turn.
 * Text-like files are inlined in a fenced block (so the model can read them);
 * binaries/images become a one-line note with name/mime/size. Empty when there
 * are no attachments.
 */
function buildAttachmentContext(attachments: OutgoingAttachment[]): string {
  if (attachments.length === 0) return ''
  const parts = attachments.map(({ attachment, textContent }) => {
    if (textContent != null) {
      return `Attached file "${attachment.name}" (${attachment.mime}):\n\`\`\`\n${textContent}\n\`\`\``
    }
    return `[Attached file: ${attachment.name} (${attachment.mime}, ${formatSize(attachment.size)})]`
  })
  return parts.join('\n\n')
}

/**
 * Rebuild Run Log rows for a reopened conversation from its persisted tool ops.
 *
 * Only the LAST run's ops become rows: the log is a trace of one turn, and a
 * reload should show the turn that just happened rather than every op the
 * conversation ever ran. Ops written before migration v9 carry no `startedAt`,
 * so their row time is 0 — the sentinel the log renders as `--:--:--` instead of
 * inventing a clock reading (an op that was never timed must not look timed).
 */
function restoredActivity(tools: ToolCardUI[]): ActivityStep[] {
  if (tools.length === 0) return []
  const lastRunId = tools[tools.length - 1].runId
  return tools
    .filter((t) => t.runId === lastRunId)
    .map((t) => {
      const desc = describeProposal(t.proposal, t.agentRole)
      return {
        id: nextActivityId(),
        at: t.startedAt ?? 0,
        kind: 'tool' as ActivityKind,
        stage: desc.stage,
        message: desc.message,
        done: true,
        toolId: t.id,
        ...(t.agentId != null ? { agentId: t.agentId } : {}),
        ...(t.agentRole != null ? { agentRole: t.agentRole } : {})
      }
    })
}

/** Rehydrate UI state from a loaded session (messages + completed tool cards). */
function hydrate(loaded: PersistedSession): {
  messages: ChatMessageUI[]
  tools: ToolCardUI[]
  attachments: Attachment[]
  activity: ActivityStep[]
} {
  const messages: ChatMessageUI[] = loaded.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.error != null ? { error: m.error } : {}),
    ...(m.feedback != null ? { feedback: m.feedback } : {}),
    ...(m.flagged ? { flagged: true } : {})
  }))
  // Persisted tool ops are always terminal → restored as read-only 'complete'.
  // Attribution and timing ride along (migration v9) so a reopened conversation
  // shows which subagent did what, and when, instead of flattening it to the lead.
  const tools: ToolCardUI[] = loaded.tools.map((t) => ({
    id: t.id,
    runId: t.runId,
    afterMessageId: t.afterMessageId,
    proposal: t.proposal,
    auto: t.auto,
    status: 'complete',
    ...(t.decision != null ? { decision: t.decision } : {}),
    ...(t.result != null ? { result: t.result } : {}),
    ...(t.contentOffset != null ? { contentOffset: t.contentOffset } : {}),
    ...(t.agentId != null ? { agentId: t.agentId } : {}),
    ...(t.agentRole != null ? { agentRole: t.agentRole } : {}),
    ...(t.startedAt != null ? { startedAt: t.startedAt } : {}),
    ...(t.endedAt != null ? { endedAt: t.endedAt } : {})
  }))

  // Advance id/run counters past everything restored.
  bumpCountersFrom(
    messages.map((m) => m.id),
    'msg-',
    (n) => {
      idCounter = Math.max(idCounter, n)
    }
  )
  bumpCountersFrom(
    tools.map((t) => t.runId),
    'run-',
    (n) => {
      runCounter = Math.max(runCounter, n)
    }
  )
  return {
    messages,
    tools,
    attachments: loaded.attachments,
    activity: restoredActivity(tools)
  }
}

/**
 * Overlay any live background run onto a freshly-hydrated view of `sessionId`,
 * so switching back to a session whose run is still going re-attaches to the
 * exact live stream rather than showing a stale, frozen partial. Returns the
 * transient run fields (`running`/`runId`/`disposer`/`status`/`intent`) plus the
 * messages/tools with the run's live assistant content and cards merged in. When
 * the session has no live run, returns the base view marked idle.
 */
function projectLiveRun(
  base: { messages: ChatMessageUI[]; tools: ToolCardUI[]; activity?: ActivityStep[] },
  sessionId: string | null
): {
  messages: ChatMessageUI[]
  tools: ToolCardUI[]
  agents: AgentCardUI[]
  running: boolean
  runId: string | null
  disposer: (() => void) | null
  status: ActivityStatus | null
  progress: RunProgressUI | null
  todos: TodoItem[]
  question: PendingQuestion | null
  planApproval: PendingPlan | null
  followups: Followup[]
  activity: ActivityStep[]
  standing: string[]
  intent: IntentAnalysis | null
  usage: ContextUsage | null
} {
  const run = sessionId ? liveRuns.get(sessionId) : undefined
  if (!run) {
    return {
      ...base,
      // Subagent structure isn't persisted, so a session with no live run has
      // no nested cards (its applied ops render flat under the assistant turn).
      agents: [],
      running: false,
      runId: null,
      disposer: null,
      status: null,
      progress: null,
      todos: [],
      question: null,
      planApproval: null,
      // Follow-up chips belong to the run that raised them and aren't persisted, so
      // opening a conversation with no live run shows none. Nothing is lost: the
      // finding is in FOLLOWUPS.md, which is why the chip can be this transient.
      followups: [],
      // Rebuilt from the persisted ops of the last turn (see `restoredActivity`), so
      // reopening a conversation still has a Run Log rather than an empty panel.
      activity: base.activity ?? [],
      // A standing grant is scoped to the run that gave it, so an idle conversation
      // holds none — nothing is being auto-approved behind the user's back.
      standing: [],
      intent: null,
      // The meter measures the array a LIVE run is about to send, so an idle
      // conversation has nothing to report — and says "no reading" rather than
      // leaving the last run's number on screen as if it still applied.
      usage: null
    }
  }

  // The assistant turn isn't persisted until the run finishes, so mid-run it may
  // be absent from the reloaded messages — add (or refresh) it with the live,
  // still-pending content.
  const messages = [...base.messages]
  const idx = messages.findIndex((m) => m.id === run.assistantId)
  if (idx >= 0) {
    messages[idx] = { ...messages[idx], content: run.content, pending: true, error: undefined }
  } else {
    messages.push({ id: run.assistantId, role: 'assistant', content: run.content, pending: true })
  }

  // Merge the run's live cards, preferring any already restored from disk (which
  // carry the persisted decision/result) and appending the not-yet-persisted ones.
  const known = new Set(base.tools.map((t) => t.id))
  const tools = [...base.tools, ...run.tools.filter((t) => !known.has(t.id))]

  return {
    messages,
    tools,
    agents: run.agents,
    running: true,
    runId: run.runId,
    disposer: run.disposer,
    status: run.status,
    progress: run.progress,
    todos: run.todos,
    question: run.question,
    planApproval: run.planApproval,
    followups: run.followups,
    activity: run.activity,
    standing: run.standing,
    intent: run.intent,
    usage: run.usage
  }
}

/**
 * Conversation + workflow state. `send` drives the agent pipeline: it appends
 * the user turn and a pending assistant turn, then streams events from the main
 * process (intent → status → deltas → tool-request/result → done/error) into
 * that assistant message and the tool-card list.
 *
 * Runs are tracked in {@link liveRuns} independently of which conversation is on
 * screen, so a run started in one session keeps going — and lands its results in
 * that session — when the user switches away (background processing).
 */
export const useChatStore = create<ChatState>((set, get) => {
  /**
   * Publish the current {@link liveRuns} keys to `liveSessionIds` so the rail can
   * badge chats that are still working. Called at every point the map is mutated.
   * Bails when the key list is unchanged, so this never triggers a re-render on
   * its own (it runs on the same paths as run start/finish, which are frequent).
   */
  const syncLiveSessions = (): void => {
    const next = [...liveRuns.keys()]
    const prev = get().liveSessionIds
    if (prev.length === next.length && next.every((id, i) => prev[i] === id)) return
    set({ liveSessionIds: next })
  }

  /**
   * Launch a workflow run that streams into the assistant message `assistantId`,
   * feeding the engine `history`. Shared by `send` (fresh user turn) and
   * `regenerate` (re-run over trimmed history into the same slot). The run is
   * registered in {@link liveRuns} under its owner session; its event handler
   * updates the visible store only while that session is on screen, but always
   * buffers content and persists results to the owner session.
   */
  const startRun = (assistantId: string, history: ChatMessage[]): void => {
    const ownerSessionId = get().sessionId
    const runId = nextRunId()
    const permissionMode = useAppStore.getState().permissionMode
    const effort = useAppStore.getState().effort
    const planFirst = useAppStore.getState().planFirst
    const mode = useAppStore.getState().workMode
    const projectId = get().projectId
    // Pin this run to the folder that's active right now. `loadInto` re-points the
    // active root to the open conversation's own folder before a send is possible,
    // so this snapshot is this chat's folder; capturing it here lets the engine
    // wrap the run in `runWithRoot`, keeping reads/writes on this folder even if
    // the user opens a different conversation (and root) while the run is in flight.
    const runRoot = useAppStore.getState().workspaceRoot

    const run: LiveRun = {
      runId,
      ownerSessionId,
      assistantId,
      content: '',
      tools: [],
      agents: [],
      status: null,
      progress: null,
      taskStates: new Map(),
      todos: [],
      question: null,
      planApproval: null,
      followups: [],
      activity: [],
      standing: [],
      intent: null,
      usage: null,
      disposer: () => {},
      buffer: '',
      agentBuffers: new Map(),
      flushTimer: null,
      lastPersist: 0
    }

    // Create the assistant row up-front (empty), right after the user turn that
    // was just persisted in `send`. This anchors the run's tool ops — which are
    // saved incrementally and reference this id — even if the run is interrupted
    // before it streams any prose, so a reload never shows orphaned tool cards
    // under a missing answer. `appendMessage` upserts by id, so the regenerate
    // path (row already blanked) and the streaming checkpoints below reuse it.
    if (ownerSessionId) {
      window.sylor.sessions.appendMessage(ownerSessionId, {
        id: assistantId,
        role: 'assistant',
        content: ''
      })
    }

    /** Is this run's owner session the conversation currently on screen? */
    const isVisible = (): boolean => get().sessionId === ownerSessionId

    /**
     * Drain buffered deltas (lead prose + each subagent's) into the store, if visible.
     *
     * `all` drains the queue completely, for the moments where a partial reveal would
     * be *wrong* rather than just slower: a tool or subagent card anchors at the
     * current prose length, so any text still queued would land after the card it was
     * written before; and the end of a run must show the whole reply. Everything else
     * goes through {@link takeReveal}, which passes a live token stream straight
     * through and types out a block that arrived all at once.
     */
    const flush = (all = false): void => {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer)
        run.flushTimer = null
      }
      // Lead prose accrues into the assistant message (the persisted turn)…
      const lead = all ? { shown: run.buffer, rest: '' } : takeReveal(run.buffer)
      const leadText = lead.shown
      run.buffer = lead.rest
      if (leadText) run.content += leadText
      // …and is checkpointed to the DB on a throttled cadence so an interrupted
      // run (app reopened / new session / crash) keeps its reply, not just its
      // tool ops. Persists to the OWNER session regardless of what's on screen;
      // the final content is rewritten authoritatively on `done`/`error`.
      if (leadText && ownerSessionId) {
        const now = Date.now()
        if (now - run.lastPersist >= ASSISTANT_PERSIST_MS) {
          run.lastPersist = now
          window.sylor.sessions.appendMessage(ownerSessionId, {
            id: assistantId,
            role: 'assistant',
            content: run.content
          })
        }
      }
      // …and each subagent's prose accrues into its own nested card, revealed the
      // same way: a subagent narrates in a stream, but its closing report can land
      // as one block.
      const agentDrains: Array<{ agentId: string; text: string }> = []
      for (const [agentId, buf] of run.agentBuffers) {
        if (!buf) continue
        const part = all ? { shown: buf, rest: '' } : takeReveal(buf)
        if (part.shown) agentDrains.push({ agentId, text: part.shown })
        if (part.rest) run.agentBuffers.set(agentId, part.rest)
        else run.agentBuffers.delete(agentId)
      }
      // Keep the reveal ticking while text is still queued — the next tick has to
      // come from here, since no further delta may arrive to schedule one.
      if (run.buffer !== '' || run.agentBuffers.size > 0) scheduleFlush()
      // Update the background source of truth immutably (used on session switch),
      // reading each card's pre-flush content so the delta is applied exactly once.
      for (const { agentId, text } of agentDrains) {
        const i = run.agents.findIndex((a) => a.agentId === agentId)
        if (i >= 0) run.agents[i] = { ...run.agents[i], content: run.agents[i].content + text }
      }
      if (!leadText && agentDrains.length === 0) return
      if (isVisible()) {
        set((state) => {
          const messages = leadText
            ? state.messages.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + leadText } : m
              )
            : state.messages
          const agents =
            agentDrains.length > 0
              ? state.agents.map((a) => {
                  const d = agentDrains.find((x) => x.agentId === a.agentId)
                  return d ? { ...a, content: a.content + d.text } : a
                })
              : state.agents
          return { messages, agents }
        })
      }
    }
    const scheduleFlush = (): void => {
      if (run.flushTimer == null) run.flushTimer = setTimeout(flush, DELTA_FLUSH_MS)
    }

    /** Persist the now-complete tool op to its OWNER session (not the visible one). */
    const persistToolOp = (card: ToolCardUI, result: ToolResult): void => {
      if (!ownerSessionId) return
      const op: PersistedToolOp = {
        id: card.id,
        afterMessageId: card.afterMessageId,
        runId: card.runId,
        auto: card.auto,
        ...(card.decision != null ? { decision: card.decision } : {}),
        proposal: card.proposal,
        result,
        ...(card.contentOffset != null ? { contentOffset: card.contentOffset } : {}),
        ...(card.agentId != null ? { agentId: card.agentId } : {}),
        ...(card.agentRole != null ? { agentRole: card.agentRole } : {}),
        ...(card.startedAt != null ? { startedAt: card.startedAt } : {}),
        ...(card.endedAt != null ? { endedAt: card.endedAt } : {})
      }
      window.sylor.sessions.appendToolOp(ownerSessionId, op)
    }

    const onEvent = (event: WorkflowEvent): void => {
      // The engine's own stamp (applied once, in the IPC sink) is the log's clock;
      // arrival time is only a fallback for a sink that doesn't stamp (CLI/SDK).
      const at = event.at ?? Date.now()
      switch (event.type) {
        case 'intent':
          run.intent = event.intent
          if (isVisible()) set({ intent: event.intent })
          break
        case 'status':
          // A subagent's status shouldn't overwrite the lead's top-level activity
          // line (the lead is blocked awaiting it); its nested card's spinner and
          // streamed prose convey progress instead.
          if (event.agentId) break
          run.status = { stage: event.stage, message: event.message, retrying: event.retrying }
          run.activity = appendActivity(run.activity, event.stage, event.message, at)
          // §33 — merged, not replaced: the engine sends `progress` when something
          // changes (phase start, then again once the checks have run), so a later
          // event that carries only `checks` must not erase the phase.
          if (event.progress) run.progress = { ...(run.progress ?? {}), ...event.progress }
          if (isVisible())
            set({ status: run.status, activity: run.activity, progress: run.progress })
          break
        case 'delta':
          // Buffer; the flush timer applies it in coalesced batches (see above).
          // Subagent deltas accrue to a per-agent buffer so they land in the
          // nested card, not the lead's assistant message.
          if (event.agentId) {
            run.agentBuffers.set(
              event.agentId,
              (run.agentBuffers.get(event.agentId) ?? '') + event.text
            )
          } else {
            run.buffer += event.text
          }
          scheduleFlush()
          break
        case 'tool-request': {
          // Drain fully first: the anchor offset must cover all prose streamed so
          // far, or text still queued would appear below the card it preceded.
          flush(true)
          // A subagent's op nests inside its card; its offset is relative to the
          // agent's own streamed prose. The lead's ops anchor to the assistant
          // message's content instead.
          const agent = event.agentId
            ? run.agents.find((a) => a.agentId === event.agentId)
            : undefined
          const card: ToolCardUI = {
            id: event.proposal.id,
            runId,
            afterMessageId: assistantId,
            proposal: event.proposal,
            auto: event.auto,
            status: event.auto ? 'running' : 'awaiting',
            contentOffset: agent ? agent.content.length : run.content.length,
            startedAt: at,
            ...(event.agentId ? { agentId: event.agentId } : {}),
            ...(agent ? { agentRole: agent.role } : {})
          }
          run.tools.push(card)
          // Surface the concrete op on the top-level line (Creating/Editing/
          // Reading/Reviewing <file>), replacing the generic delegating/generating
          // text — for the lead and for a subagent alike, so the user sees the
          // actual file work rather than "Delegating to the frontend…".
          const desc = describeProposal(event.proposal, agent?.role)
          // A gated op is NOT happening yet — it is waiting on the user. The sticky
          // row is the one line always on screen, so it says so instead of claiming
          // work is under way; the activity trace keeps the plain description, since
          // the op either runs or is refused moments later.
          run.status = {
            stage: desc.stage,
            message: event.auto ? desc.message : `${AWAITING_PREFIX}${desc.message}`
          }
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'tool',
            stage: desc.stage,
            message: desc.message,
            done: false,
            toolId: event.proposal.id,
            ...(event.agentId ? { agentId: event.agentId } : {}),
            ...(agent ? { agentRole: agent.role } : {})
          })
          if (isVisible()) {
            set((state) => ({
              tools: [...state.tools, card],
              status: run.status,
              activity: run.activity
            }))
          }
          break
        }
        case 'tool-result': {
          flush()
          const idx = run.tools.findIndex((t) => t.id === event.result.id)
          let card: ToolCardUI | undefined
          if (idx >= 0) {
            card = { ...run.tools[idx], status: 'complete', result: event.result, endedAt: at }
            run.tools[idx] = card
          }
          run.activity = finishActivity(run.activity, { toolId: event.result.id })
          if (isVisible()) {
            set((state) => ({
              tools: state.tools.map((t) =>
                t.id === event.result.id
                  ? { ...t, status: 'complete', result: event.result, endedAt: at }
                  : t
              ),
              activity: run.activity
            }))
          }
          if (card) persistToolOp(card, event.result)

          // Auto-open the live preview when the applied op produced something to
          // see — but only for the visible session, so a background run never
          // hijacks the preview the user is currently looking at. Results only
          // arrive after the permission gate, so this never bypasses approval.
          if (isVisible() && card) {
            const proposal = card.proposal
            const result = event.result
            if (
              proposal.kind === 'write_file' &&
              result.kind === 'write_file' &&
              result.ok &&
              /\.html?$/i.test(proposal.path)
            ) {
              useAppStore.getState().openPreview()
              // A bundler entry point (a script tag pointing at unbuilt `/src/…`)
              // is blank when served as a file, so it goes through startAuto — the
              // main process finds the project's dev script, reuses an already
              // running server, and reports honestly when there is nothing that
              // can render it. Everything self-contained still serves instantly.
              void (isBundlerEntryHtml(proposal.newContent)
                ? window.sylor.preview.startAuto(proposal.path)
                : window.sylor.preview.startStatic(proposal.path))
            } else if (
              proposal.kind === 'run_command' &&
              result.kind === 'run_command' &&
              result.exitCode === 0 &&
              BUILD_RE.test(proposal.command)
            ) {
              void window.sylor.preview.startStatic()
            }
          }
          break
        }
        case 'agent-start': {
          // Drain fully so the card anchors after all lead prose streamed so far.
          flush(true)
          const card: AgentCardUI = {
            agentId: event.agentId,
            runId,
            afterMessageId: assistantId,
            role: event.role,
            task: event.task,
            status: 'running',
            content: '',
            contentOffset: run.content.length,
            ...(event.background ? { background: true } : {}),
            ...(event.isolation ? { isolation: event.isolation } : {})
          }
          run.agents.push(card)
          // A FOREGROUND spawn owns the run's status line while it works — the lead
          // is blocked on it, so its verb (Reviewing…/Working…) is what's happening.
          // A BACKGROUND spawn must NOT hijack it: the lead keeps working and its own
          // status line stays live, so we only add the nested card. Concrete file ops
          // (Creating/Editing/Reading <file>) replace the foreground line within a
          // step or two — see the tool-request case.
          if (!event.background) {
            const startStage: WorkflowStage = event.role === 'reviewer' ? 'verifying' : 'generating'
            const startMsg = event.role === 'reviewer' ? 'Reviewing the changes…' : 'Working…'
            run.status = { stage: startStage, message: startMsg }
          }
          // The log gets its own row either way — a background spawn is exactly the
          // work that would otherwise be invisible, so it must be traceable even
          // though it deliberately doesn't own the status line.
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'agent',
            stage: event.role === 'reviewer' ? 'verifying' : 'generating',
            message: `${event.role} · ${clip(event.task, 90)}`,
            done: false,
            agentId: event.agentId,
            agentRole: event.role
          })
          if (isVisible()) {
            // Push a copy so the store and the run's source-of-truth card never
            // share a mutable reference (flush updates each independently).
            set((state) => ({
              agents: [...state.agents, { ...card }],
              status: run.status,
              activity: run.activity
            }))
          }
          break
        }
        case 'agent-end': {
          flush()
          const idx = run.agents.findIndex((a) => a.agentId === event.agentId)
          if (idx >= 0) {
            run.agents[idx] = {
              ...run.agents[idx],
              status: 'complete',
              report: event.report,
              ok: event.ok,
              // The lane has actually stopped now, so "Stopping…" comes off.
              cancelling: false
            }
          }
          run.activity = finishActivity(run.activity, { agentId: event.agentId }, event.ok)
          if (isVisible()) {
            set((state) => ({
              agents: state.agents.map((a) =>
                a.agentId === event.agentId
                  ? {
                      ...a,
                      status: 'complete',
                      report: event.report,
                      ok: event.ok,
                      cancelling: false
                    }
                  : a
              ),
              activity: run.activity
            }))
          }
          break
        }
        case 'plan': {
          // §33 — seed the task tally. `plan` always precedes execution, so the
          // total is known before the first node moves.
          run.taskStates = new Map(event.tasks.map((t) => [t.id, t.state]))
          run.progress = withTasks(run.progress, run.taskStates)
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'plan',
            stage: 'planning',
            message: `Planned ${event.tasks.length} step${event.tasks.length === 1 ? '' : 's'} (${event.complexity})`,
            done: true
          })
          if (isVisible()) set({ progress: run.progress, activity: run.activity })
          break
        }
        case 'task-update': {
          run.taskStates.set(event.task.id, event.task.state)
          run.progress = withTasks(run.progress, run.taskStates)
          if (isVisible()) set({ progress: run.progress })
          break
        }
        case 'todos': {
          // The lead's flat checklist, replaced wholesale each time (the model
          // always re-sends the full list). Mirrored to the view only while this
          // run's session is the one on screen.
          run.todos = event.todos
          if (isVisible()) set({ todos: run.todos })
          break
        }
        case 'question': {
          // The run is blocked on a clarifying question (the `ask_user` tool).
          // Record it so the composer shows an answer bar; answering it calls
          // `answerQuestion`, which resolves the wait in the main process.
          run.question = event.question
          // The row stays OPEN until the answer goes back, so the log shows the
          // wait honestly rather than a question that looks already handled.
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'question',
            stage: 'understanding',
            message: `${AWAITING_PREFIX}${clip(event.question.question, 120)}`,
            done: false,
            toolId: event.question.id
          })
          if (isVisible()) set({ question: run.question, activity: run.activity })
          break
        }
        case 'plan-approval': {
          // "Plan first": the plan exists, nothing has been built, and the run is
          // parked on the user's go-ahead. `decidePlan` answers it over the ordinary
          // tool-decision channel, which is what unblocks the engine.
          run.planApproval = event.approval
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'plan',
            stage: 'planning',
            message: `${AWAITING_PREFIX}approve the plan (${event.approval.steps.length} step${
              event.approval.steps.length === 1 ? '' : 's'
            })`,
            done: false,
            toolId: event.approval.id
          })
          if (isVisible()) set({ planApproval: run.planApproval, activity: run.activity })
          break
        }
        case 'checkpoint': {
          // A restore point the engine took before changing something. Prepended
          // (newest first, deduped by id) rather than replacing the list, because the
          // list also holds points from earlier turns read off disk. Project-scoped,
          // so it is set even when this run's session isn't the one on screen — the
          // folder changed either way, and the timeline is about the folder.
          const known = get().checkpoints
          if (!known.some((c) => c.id === event.checkpoint.id)) {
            set({ checkpoints: [event.checkpoint, ...known] })
          }
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'checkpoint',
            stage: run.status?.stage ?? 'executing',
            message: `Saved a restore point · ${clip(event.checkpoint.label, 90)}`,
            done: true,
            ok: true
          })
          if (isVisible()) set({ activity: run.activity })
          break
        }
        case 'context': {
          // Measured context load for the step about to run. No activity row: this
          // fires every step and would bury the trace in rows nobody asked for — the
          // meter is where it belongs, and the fold it predicts gets its own status.
          run.usage = event.usage
          if (isVisible()) set({ usage: run.usage })
          break
        }
        case 'followup': {
          // An out-of-scope issue the agent spotted and deliberately did NOT do
          // (the `flag_followup` tool). Appended, never replaced: each flag is its
          // own event and the list only grows. These deliberately survive `done` —
          // the user acts on them after the turn — so nothing clears them here.
          run.followups = [...run.followups, event.followup]
          run.activity = appendEvent(run.activity, {
            at,
            kind: 'followup',
            stage: run.status?.stage ?? 'generating',
            message: `Flagged for later · ${clip(event.followup.title, 90)}`,
            done: true
          })
          if (isVisible()) set({ followups: run.followups, activity: run.activity })
          break
        }
        case 'done': {
          flush(true)
          run.disposer() // detach the listener (cancel is a no-op post-completion)
          if (ownerSessionId) liveRuns.delete(ownerSessionId)
          syncLiveSessions()
          if (ownerSessionId) {
            window.sylor.sessions.appendMessage(ownerSessionId, {
              id: assistantId,
              role: 'assistant',
              content: run.content
            })
          }
          run.activity = appendEvent(closeLastPhase(run.activity), {
            at,
            kind: 'run-end',
            stage: 'done',
            message: 'Finished',
            done: true,
            ok: true
          })
          if (isVisible()) {
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === assistantId ? { ...m, pending: false } : m
              ),
              // Any subagent card still marked running (shouldn't happen — the lead
              // only finishes after they report) is closed defensively.
              agents: state.agents.map((a) =>
                a.status === 'running' ? { ...a, status: 'complete' } : a
              ),
              running: false,
              status: null,
              progress: null,
              todos: [],
              question: null,
              planApproval: null,
              // The trace deliberately OUTLIVES the turn: the Run Log is a record of
              // what just happened, and wiping it the instant the answer lands is
              // exactly when the user wants to read it. The next `send` clears it.
              activity: run.activity,
              // Grants do NOT outlive it: the engine drops them with the run, so the
              // chips must go too rather than implying the next turn is pre-approved.
              standing: [],
              // Nor does the meter: it reads the array a live step is about to send,
              // and there is no next step. The chip falls back to its own estimate.
              usage: null,
              runId: null,
              disposer: null
            }))
          }
          break
        }
        case 'error': {
          flush(true)
          run.disposer()
          if (ownerSessionId) liveRuns.delete(ownerSessionId)
          syncLiveSessions()
          const content = run.content || '_Request failed._'
          run.content = content
          if (ownerSessionId) {
            window.sylor.sessions.appendMessage(ownerSessionId, {
              id: assistantId,
              role: 'assistant',
              content,
              error: event.message
            })
          }
          run.activity = appendEvent(closeLastPhase(run.activity), {
            at,
            kind: 'run-end',
            stage: 'done',
            message: `Stopped · ${clip(event.message, 120)}`,
            done: true,
            ok: false
          })
          if (isVisible()) {
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      pending: false,
                      error: event.message,
                      content: m.content || '_Request failed._'
                    }
                  : m
              ),
              agents: state.agents.map((a) =>
                a.status === 'running' ? { ...a, status: 'complete' } : a
              ),
              running: false,
              status: null,
              progress: null,
              todos: [],
              question: null,
              planApproval: null,
              // Kept, like on `done` — a failed turn is precisely the one whose trace
              // the user needs to read.
              activity: run.activity,
              standing: [],
              usage: null,
              runId: null,
              disposer: null
            }))
          }
          break
        }
      }
    }

    const disposer = window.sylor.workflow.run(
      {
        runId,
        messages: history,
        permissionMode,
        effort,
        planFirst,
        mode,
        ...(projectId ? { projectId } : {}),
        ...(runRoot ? { root: runRoot } : {})
      },
      onEvent
    )
    run.disposer = disposer
    if (ownerSessionId) liveRuns.set(ownerSessionId, run)
    syncLiveSessions()

    set({ runId, disposer })
  }

  /** Tear down the live run owning `sessionId` (cancel + detach + drop timer). */
  const disposeRun = (sessionId: string | null): void => {
    const run = sessionId ? liveRuns.get(sessionId) : undefined
    if (run?.flushTimer != null) clearTimeout(run.flushTimer)
    // Persist the final prose before detaching. A Stop (cancel) or a clear can
    // land between checkpoints, and the engine emits no `done` for a cancelled
    // run, so without this the last (<1s) of streamed text — including any delta
    // still sitting un-flushed in the buffer — would be dropped from the saved
    // turn. Fold the pending buffer in, then upsert the assistant row by id.
    if (run?.ownerSessionId) {
      const finalContent = run.content + run.buffer
      run.buffer = ''
      run.content = finalContent
      window.sylor.sessions.appendMessage(run.ownerSessionId, {
        id: run.assistantId,
        role: 'assistant',
        content: finalContent
      })
    }
    // Prefer the run's own disposer; fall back to the visible one (same when the
    // run being cancelled is the on-screen one).
    ;(run?.disposer ?? get().disposer)?.()
    if (sessionId) liveRuns.delete(sessionId)
    syncLiveSessions()
  }

  return {
    messages: [],
    tools: [],
    agents: [],
    attachments: [],
    running: false,
    runId: null,
    status: null,
    progress: null,
    todos: [],
    question: null,
    planApproval: null,
    followups: [],
    activity: [],
    standing: [],
    intent: null,
    checkpoints: [],
    usage: null,
    disposer: null,
    sessionId: null,
    projectId: null,
    liveSessionIds: [],

    send: (text, attachments = [], engineText) => {
      const trimmed = text.trim()
      if ((!trimmed && attachments.length === 0) || get().running) return

      // A resolved `/command` sends its expansion to the engine but shows the raw
      // `/name …` in the bubble as a mention chip. `slashCommand` marks that turn.
      const slash = engineText != null ? parseSlash(trimmed) : null
      const userMsg: ChatMessageUI = {
        id: nextId(),
        role: 'user',
        content: trimmed,
        ...(slash ? { slashCommand: slash.name } : {})
      }
      const assistantId = nextId()
      const assistantMsg: ChatMessageUI = {
        id: assistantId,
        role: 'assistant',
        content: '',
        pending: true
      }

      // History sent to the engine: prior turns + this user turn. The user turn's
      // content is the engine text (a `/command`'s expansion, else what was typed)
      // augmented with attachment context (inline text for text files, a note for
      // binaries/images) so the model can see what was attached — the *displayed*
      // content stays as the user typed it.
      const historyBase: ChatMessage[] = get().messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
      const engineBase = (engineText ?? trimmed).trim()
      const attachmentContext = buildAttachmentContext(attachments)
      const userContentForEngine =
        attachmentContext === '' ? engineBase : `${engineBase}\n\n${attachmentContext}`.trim()
      const history: ChatMessage[] = [
        ...historyBase,
        { role: 'user', content: userContentForEngine }
      ]

      // Bind the (already-stored) attachments to this user message and add them to
      // the conversation's attachment list so their chips render under the message.
      const bound: Attachment[] = attachments.map((a) => ({
        ...a.attachment,
        messageId: userMsg.id
      }))

      set((state) => ({
        messages: [...state.messages, userMsg, assistantMsg],
        attachments: [...state.attachments, ...bound],
        running: true,
        status: null,
        progress: null,
        todos: [],
        question: null,
        planApproval: null,
        // The conversation is moving on, so last turn's follow-up chips go — including
        // when this send IS "Do it now" on one of them. FOLLOWUPS.md keeps the record.
        followups: [],
        activity: [],
        // Last run's grants died with it; this one starts asking again from scratch.
        standing: [],
        intent: null,
        usage: null
      }))

      // Persist the user turn immediately (fire-and-forget). The assistant turn is
      // created up-front and checkpointed as it streams (see startRun/flush), then
      // finalized on 'done'/'error' — so an interruption can't lose the reply.
      const sessionId = get().sessionId
      if (sessionId) {
        window.sylor.sessions.appendMessage(sessionId, {
          id: userMsg.id,
          role: 'user',
          content: userMsg.content
        })
        if (bound.length > 0) {
          void window.sylor.attachments.attachToMessage(
            bound.map((a) => a.id),
            userMsg.id
          )
        }
      }

      startRun(assistantId, history)
    },

    decideTool: (toolId, decision, detail) => {
      const { runId, tools } = get()
      const card = tools.find((t) => t.id === toolId)
      if (!runId || !card || card.status !== 'awaiting') return
      window.sylor.workflow.toolDecision(runId, toolId, decision, detail)
      // "Always" is a standing grant for the rest of the run, so the ops ALREADY
      // waiting under the same grant are answered too — otherwise the bar keeps
      // asking about precisely what the user just said to stop asking about. Only
      // the clicked op carries the escalation over IPC (the engine records the grant
      // from it); the siblings go as plain approvals.
      const standing = decision === 'approve-always' ? standingApprovalKey(card.proposal) : null
      const siblings = standing
        ? tools.filter(
            (t) =>
              t.id !== toolId &&
              t.status === 'awaiting' &&
              standingApprovalKey(t.proposal) === standing
          )
        : []
      // No `detail` for the siblings: an edited body and a reason are about the one
      // proposal the user actually had in front of them.
      for (const s of siblings) window.sylor.workflow.toolDecision(runId, s.id, 'approve')

      // What gets recorded against each op is the plain verb: the standing part
      // belongs to the run, not to any one op, and it is never persisted.
      const settled: ToolDecision = decision === 'reject' ? 'reject' : 'approve'
      const answered = new Set([toolId, ...siblings.map((s) => s.id)])
      // The user changed the body in the diff before letting it through, so the card
      // must carry THEIR version: the diff they scroll back to later is then the one
      // that actually hit the disk, not the model's original proposal.
      const edited =
        settled === 'approve' &&
        card.proposal.kind === 'write_file' &&
        detail?.editedContent != null &&
        detail.editedContent !== card.proposal.newContent
          ? detail.editedContent
          : null
      // The row has been reading "Waiting for your go-ahead"; that stops being true
      // the moment the user answers, so it must change either way — and it must not
      // swing to the opposite lie. Approved, the op is genuinely under way; refused,
      // nothing is happening but the model deciding what to do instead.
      const desc = describeProposal(card.proposal, card.agentRole)
      const status: { stage: WorkflowStage; message: string } =
        settled === 'approve'
          ? { stage: desc.stage, message: desc.message }
          : { stage: 'generating', message: 'Skipped that — deciding what to do next' }
      /** Apply the verdict (and any edit) to one card, live or projected. */
      const settle = <T extends ToolCardUI>(t: T): T =>
        edited != null && t.id === toolId && t.proposal.kind === 'write_file'
          ? {
              ...t,
              status: 'running',
              decision: settled,
              edited: true,
              proposal: { ...t.proposal, newContent: edited }
            }
          : { ...t, status: 'running', decision: settled }
      // Record the decision on the live run too, so it survives a session switch
      // and is persisted with the op when the result arrives.
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) {
        run.tools = run.tools.map((rc) => (answered.has(rc.id) ? settle(rc) : rc))
        run.status = status
        if (standing && !run.standing.includes(standing)) run.standing = [...run.standing, standing]
      }
      set((state) => ({
        tools: state.tools.map((t) => (answered.has(t.id) ? settle(t) : t)),
        status,
        standing:
          standing && !state.standing.includes(standing)
            ? [...state.standing, standing]
            : state.standing
      }))
    },

    cancelAgent: (agentId) => {
      const { runId, agents } = get()
      const lane = agents.find((a) => a.agentId === agentId)
      if (!runId || !lane || lane.status !== 'running' || lane.cancelling) return
      window.sylor.workflow.cancelAgent(runId, agentId)
      // The engine still owns the closing `agent-end`, so the lane isn't marked done
      // here — only "stopping", which is the honest state until that event lands.
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) {
        run.agents = run.agents.map((a) => (a.agentId === agentId ? { ...a, cancelling: true } : a))
      }
      set((state) => ({
        agents: state.agents.map((a) => (a.agentId === agentId ? { ...a, cancelling: true } : a))
      }))
    },

    revokeStanding: (key) => {
      const { runId, standing } = get()
      if (!runId || !standing.includes(key)) return
      window.sylor.workflow.revokeApproval(runId, key)
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) run.standing = run.standing.filter((k) => k !== key)
      set((state) => ({ standing: state.standing.filter((k) => k !== key) }))
    },

    answerQuestion: (answer) => {
      const { runId, question } = get()
      if (!runId || !question) return
      window.sylor.workflow.answerQuestion(runId, question.id, answer)
      // The run was blocked on this answer; it resumes now. Clear the pending
      // question from both the live run (so a session switch doesn't re-show it)
      // and the view, and reflect that we're back to working.
      const status: { stage: WorkflowStage; message: string } = {
        stage: 'generating',
        message: 'Working with your answer…'
      }
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) {
        run.question = null
        run.status = status
        // The engine sends no event for the answer, so the log's open question row
        // is closed here — otherwise it would read as still waiting forever.
        run.activity = finishActivity(run.activity, { toolId: question.id })
        set({ question: null, status, activity: run.activity })
        return
      }
      set({ question: null, status })
    },

    decidePlan: (decision) => {
      const { runId, planApproval } = get()
      if (!runId || !planApproval) return
      // A plan is a proposed action, so it rides the existing tool-decision channel —
      // there is no second answer-back path to keep in sync.
      window.sylor.workflow.toolDecision(runId, planApproval.id, decision)
      // Approved, the build starts now; rejected, the run stops — and it stops as a
      // decision, not a failure, so the row must not read like something broke.
      const status: { stage: WorkflowStage; message: string } =
        decision === 'approve'
          ? { stage: 'executing', message: 'Building the plan…' }
          : { stage: 'generating', message: 'Plan not approved — nothing was built' }
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) {
        run.planApproval = null
        run.status = status
        run.activity = finishActivity(run.activity, { toolId: planApproval.id })
        set({ planApproval: null, status, activity: run.activity })
        return
      }
      set({ planApproval: null, status })
    },

    dismissFollowup: (id) => {
      // "Not now": the chip goes, FOLLOWUPS.md keeps the entry. Dropped from the live
      // run too (not just the view) so it doesn't reappear when this session is
      // re-opened while the run is still going.
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) run.followups = run.followups.filter((f) => f.id !== id)
      set((state) => ({ followups: state.followups.filter((f) => f.id !== id) }))
    },

    cancel: () => {
      // Snapshot the trace BEFORE disposal (which drops the run from the map): a
      // stopped turn keeps its log, closed with a row that says the user stopped it
      // rather than pretending it completed.
      const stopped = liveRuns.get(get().sessionId ?? '')
      const activity = stopped
        ? appendEvent(closeLastPhase(stopped.activity), {
            at: Date.now(),
            kind: 'run-end',
            stage: 'done',
            message: 'Stopped by you',
            done: true
          })
        : []
      disposeRun(get().sessionId)
      set((state) => ({
        messages: state.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
        // Any still-awaiting tool cards are moot once the run is cancelled.
        tools: state.tools.map((t) => (t.status === 'awaiting' ? { ...t, status: 'complete' } : t)),
        // Close any subagent cards left mid-flight.
        agents: state.agents.map((a) =>
          a.status === 'running' ? { ...a, status: 'complete' } : a
        ),
        running: false,
        status: null,
        progress: null,
        todos: [],
        question: null,
        planApproval: null,
        activity,
        usage: null,
        runId: null,
        disposer: null
      }))
    },

    refreshCheckpoints: () => {
      void window.sylor.checkpoints
        .list()
        .then((checkpoints) => set({ checkpoints }))
        .catch(() => set({ checkpoints: [] }))
    },

    restoreCheckpoint: async (id) => {
      const outcome = await window.sylor.checkpoints.restore(id)
      // Re-read rather than patch: the restore took its own safety checkpoint, so the
      // list on disk now has an entry this store has never seen.
      get().refreshCheckpoints()
      return outcome
    },

    clear: () => {
      disposeRun(get().sessionId)
      set({
        messages: [],
        tools: [],
        agents: [],
        attachments: [],
        running: false,
        status: null,
        progress: null,
        todos: [],
        question: null,
        planApproval: null,
        followups: [],
        activity: [],
        standing: [],
        intent: null,
        usage: null,
        runId: null,
        disposer: null
      })
    },

    cancelSession: (sessionId) => {
      // Guarded on `has`: disposeRun falls back to the *visible* run when the id
      // owns none, which would kill the wrong task. Only act on a real live run.
      if (!liveRuns.has(sessionId)) return
      disposeRun(sessionId)
      // If that run was the one on screen, clear the transient view state too.
      if (get().sessionId === sessionId) {
        set((state) => ({
          messages: state.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
          tools: state.tools.map((t) =>
            t.status === 'awaiting' ? { ...t, status: 'complete' } : t
          ),
          agents: state.agents.map((a) =>
            a.status === 'running' ? { ...a, status: 'complete' } : a
          ),
          running: false,
          status: null,
          progress: null,
          todos: [],
          question: null,
          planApproval: null,
          activity: [],
          // The run is gone, and its grants with it.
          standing: [],
          usage: null,
          runId: null,
          disposer: null
        }))
      }
    },

    setFeedback: (messageId, feedback) => {
      const { messages, sessionId } = get()
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      // Clicking the active reaction again clears it (toggle semantics).
      const next = msg.feedback === feedback ? null : feedback
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, feedback: next ?? undefined } : m
        )
      }))
      if (sessionId)
        window.sylor.sessions.setFeedback(sessionId, messageId, next, msg.flagged ?? false)
    },

    toggleFlag: (messageId) => {
      const { messages, sessionId } = get()
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      const next = !msg.flagged
      set((state) => ({
        messages: state.messages.map((m) => (m.id === messageId ? { ...m, flagged: next } : m))
      }))
      if (sessionId)
        window.sylor.sessions.setFeedback(sessionId, messageId, msg.feedback ?? null, next)
    },

    regenerate: (messageId) => {
      if (get().running) return
      const { messages, sessionId } = get()
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx < 0 || messages[idx].role !== 'assistant') return
      // Re-run over every turn before this assistant reply (its prompting user turn
      // included). Attachment bodies aren't re-inlined — regeneration works from the
      // displayed transcript, which is what the user sees and expects.
      const history: ChatMessage[] = messages
        .slice(0, idx)
        .map((m) => ({ role: m.role, content: m.content }))
      if (history.length === 0) return

      // Reset the assistant slot in place (same id): clear content, drop its tool
      // cards and any prior reaction/flag, and mark it streaming again.
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: '',
                pending: true,
                error: undefined,
                feedback: undefined,
                flagged: undefined
              }
            : m
        ),
        tools: state.tools.filter((t) => t.afterMessageId !== messageId),
        agents: state.agents.filter((a) => a.afterMessageId !== messageId),
        running: true,
        status: null,
        progress: null,
        todos: [],
        question: null,
        planApproval: null,
        // The turn that raised them is being replaced, so its chips go with it.
        followups: [],
        activity: [],
        standing: [],
        intent: null,
        usage: null
      }))
      // Clear the persisted copy so a reload shows only the regenerated result.
      if (sessionId) window.sylor.sessions.resetMessage(sessionId, messageId)

      startRun(messageId, history)
    },

    applyLoaded: (loaded) => {
      // Do NOT tear down in-flight runs when switching conversations — they keep
      // running in the background and route their results to their own session.
      // If the session being opened has a live run, re-attach to it (overlay the
      // live content/cards and restore the running state).
      const { messages, tools, attachments, activity } = hydrate(loaded)
      set({
        sessionId: loaded.session.id,
        projectId: loaded.session.projectId,
        attachments,
        ...projectLiveRun({ messages, tools, activity }, loaded.session.id)
      })
    },

    resetTo: (sessionId, projectId = null) => {
      // A fresh session starts empty; it has no live run to re-attach to, but we
      // still route through projectLiveRun for a single, consistent projection.
      set({
        sessionId,
        projectId,
        attachments: [],
        ...projectLiveRun({ messages: [], tools: [] }, sessionId)
      })
    }
  }
})
