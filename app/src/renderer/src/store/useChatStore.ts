import { create } from 'zustand'
import type {
  AgentRole,
  Attachment,
  ChatMessage,
  IntentAnalysis,
  PersistedSession,
  PersistedToolOp,
  ToolDecision,
  ToolProposal,
  ToolResult,
  WorkflowEvent,
  WorkflowStage
} from '@shared/types'
import { useAppStore } from './useAppStore'

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
 * An `index.html` that is a *bundler entry point* — a module script pointing at
 * unbuilt source (`/src/…`, or a `.ts`/`.tsx`/`.jsx` file). Serving such a file
 * statically renders a blank page: the browser fetches `/src/main.tsx` as-is and
 * chokes on the raw TypeScript/JSX (this is exactly why "React apps don't
 * preview"). These projects must be shown via their dev server (Vite/Next/…),
 * which compiles on the fly — so auto-preview skips {@link startStatic} for them
 * and lets the engine's `startDev` path drive the live preview instead. A
 * self-contained page (inline scripts, or `src="app.js"` to a built bundle) does
 * NOT match, so plain HTML still previews instantly with no dev server.
 */
const BUNDLER_ENTRY_RE =
  /<script\b[^>]*\bsrc=["'][^"']*(?:\/src\/[^"']*|\.(?:tsx?|jsx))(?:[?#][^"']*)?["']/i

/**
 * How often (ms) buffered stream deltas are flushed into the rendered message.
 * Appending to a growing Markdown message on every token would re-parse and
 * re-highlight the whole thing each time — O(n²) work that freezes the UI on a
 * large response. Coalescing to ~15fps keeps streaming smooth without a hang.
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
}

/** Live activity line shown while a run is in progress. */
export interface ActivityStatus {
  stage: WorkflowStage
  message: string
  /** Set while the engine is between retry attempts, so the UI can dim the line. */
  retrying?: boolean
}

/**
 * One step in the live activity timeline. Every `status` event the engine emits
 * appends a step; the previous step is marked `done` the moment the next arrives,
 * so the UI can render completed phases quietly (with a ✓) and the current phase
 * as active. This turns the engine's already-real status stream into the
 * progressive, sequential timeline the UI shows (Understanding → Reading →
 * Planning → …) instead of a single re-labeling line. Renderer-only UI state:
 * never persisted and never an IPC payload — derived entirely from live events.
 */
export interface ActivityStep {
  id: string
  stage: WorkflowStage
  message: string
  done: boolean
}

/**
 * Append a status to the activity timeline, marking the prior step done. A status
 * identical to the current tail (same stage AND message) is a no-op — the engine
 * can re-emit the same phase and we don't want duplicate rows. Returns the same
 * array reference when nothing changed so callers can skip a needless re-render.
 */
function appendActivity(
  list: ActivityStep[],
  stage: WorkflowStage,
  message: string
): ActivityStep[] {
  const last = list[list.length - 1]
  if (last && last.stage === stage && last.message === message) return list
  const next = last && !last.done ? [...list.slice(0, -1), { ...last, done: true }] : [...list]
  next.push({ id: nextActivityId(), stage, message, done: false })
  return next
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
  /** Ordered activity timeline (one step per distinct status), mirrored while visible. */
  activity: ActivityStep[]
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
   * Ordered live activity timeline for the active run — the progressive sequence
   * of phases (Understanding → Reading → Planning → …) the UI renders in place of
   * a single spinner. Empty when idle.
   */
  activity: ActivityStep[]
  /** The intent interpretation for the active/last run ("You want to…"). */
  intent: IntentAnalysis | null
  /** Disposer for the active run's event subscription. */
  disposer: (() => void) | null
  /** The persisted session this conversation is being written to, or null. */
  sessionId: string | null
  /** Project the active session is filed under (drives per-project instructions). */
  projectId: string | null

  /**
   * Send a user turn and start a workflow run. No-op while already running or
   * when both text and attachments are empty. Attachments are bound to the user
   * message and their content is folded into the engine history.
   */
  send: (text: string, attachments?: OutgoingAttachment[]) => void
  /** Approve or reject a pending tool proposal. */
  decideTool: (toolId: string, decision: ToolDecision) => void
  /** Cancel the active run, keeping whatever was streamed so far. */
  cancel: () => void
  /** Clear the whole conversation (cancels any active run first). */
  clear: () => void
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
  /** Reset to an empty conversation bound to a fresh session id (synchronous). */
  resetTo: (sessionId: string, projectId?: string | null) => void
}

let idCounter = 0
const nextId = (): string => `msg-${++idCounter}`
let runCounter = 0
const nextRunId = (): string => `run-${++runCounter}`
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

/** Rehydrate UI state from a loaded session (messages + completed tool cards). */
function hydrate(loaded: PersistedSession): {
  messages: ChatMessageUI[]
  tools: ToolCardUI[]
  attachments: Attachment[]
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
  const tools: ToolCardUI[] = loaded.tools.map((t) => ({
    id: t.id,
    runId: t.runId,
    afterMessageId: t.afterMessageId,
    proposal: t.proposal,
    auto: t.auto,
    status: 'complete',
    ...(t.decision != null ? { decision: t.decision } : {}),
    ...(t.result != null ? { result: t.result } : {}),
    ...(t.contentOffset != null ? { contentOffset: t.contentOffset } : {})
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
  return { messages, tools, attachments: loaded.attachments }
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
  base: { messages: ChatMessageUI[]; tools: ToolCardUI[] },
  sessionId: string | null
): {
  messages: ChatMessageUI[]
  tools: ToolCardUI[]
  agents: AgentCardUI[]
  running: boolean
  runId: string | null
  disposer: (() => void) | null
  status: ActivityStatus | null
  activity: ActivityStep[]
  intent: IntentAnalysis | null
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
      activity: [],
      intent: null
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
    activity: run.activity,
    intent: run.intent
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

    const run: LiveRun = {
      runId,
      ownerSessionId,
      assistantId,
      content: '',
      tools: [],
      agents: [],
      status: null,
      activity: [],
      intent: null,
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

    /** Drain buffered deltas (lead prose + each subagent's) into the store, if visible. */
    const flush = (): void => {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer)
        run.flushTimer = null
      }
      // Lead prose accrues into the assistant message (the persisted turn)…
      const leadText = run.buffer
      run.buffer = ''
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
      // …and each subagent's prose accrues into its own nested card.
      const agentDrains: Array<{ agentId: string; text: string }> = []
      for (const [agentId, buf] of run.agentBuffers) {
        if (buf) agentDrains.push({ agentId, text: buf })
      }
      run.agentBuffers.clear()
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
        ...(card.agentRole != null ? { agentRole: card.agentRole } : {})
      }
      window.sylor.sessions.appendToolOp(ownerSessionId, op)
    }

    const onEvent = (event: WorkflowEvent): void => {
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
          run.activity = appendActivity(run.activity, event.stage, event.message)
          if (isVisible()) set({ status: run.status, activity: run.activity })
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
          // Flush first so the anchor offset reflects all prose streamed so far.
          flush()
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
            ...(event.agentId ? { agentId: event.agentId } : {}),
            ...(agent ? { agentRole: agent.role } : {})
          }
          run.tools.push(card)
          if (isVisible()) set((state) => ({ tools: [...state.tools, card] }))
          break
        }
        case 'tool-result': {
          flush()
          const idx = run.tools.findIndex((t) => t.id === event.result.id)
          let card: ToolCardUI | undefined
          if (idx >= 0) {
            card = { ...run.tools[idx], status: 'complete', result: event.result }
            run.tools[idx] = card
          }
          if (isVisible()) {
            set((state) => ({
              tools: state.tools.map((t) =>
                t.id === event.result.id ? { ...t, status: 'complete', result: event.result } : t
              )
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
              /\.html?$/i.test(proposal.path) &&
              !BUNDLER_ENTRY_RE.test(proposal.newContent)
            ) {
              useAppStore.getState().openPreview()
              void window.sylor.preview.startStatic(proposal.path)
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
          // Flush first so the card anchors after all lead prose streamed so far.
          flush()
          const card: AgentCardUI = {
            agentId: event.agentId,
            runId,
            afterMessageId: assistantId,
            role: event.role,
            task: event.task,
            status: 'running',
            content: '',
            contentOffset: run.content.length
          }
          run.agents.push(card)
          // Surface the hand-off on the top-level line; the lead is blocked here
          // until the subagent reports back, so this stays put meanwhile.
          run.status = { stage: 'generating', message: `Delegating to the ${event.role}…` }
          run.activity = appendActivity(run.activity, 'generating', run.status.message)
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
              ok: event.ok
            }
          }
          if (isVisible()) {
            set((state) => ({
              agents: state.agents.map((a) =>
                a.agentId === event.agentId
                  ? { ...a, status: 'complete', report: event.report, ok: event.ok }
                  : a
              )
            }))
          }
          break
        }
        case 'done': {
          flush()
          run.disposer() // detach the listener (cancel is a no-op post-completion)
          if (ownerSessionId) liveRuns.delete(ownerSessionId)
          if (ownerSessionId) {
            window.sylor.sessions.appendMessage(ownerSessionId, {
              id: assistantId,
              role: 'assistant',
              content: run.content
            })
          }
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
              activity: [],
              runId: null,
              disposer: null
            }))
          }
          break
        }
        case 'error': {
          flush()
          run.disposer()
          if (ownerSessionId) liveRuns.delete(ownerSessionId)
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
              activity: [],
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
        ...(projectId ? { projectId } : {})
      },
      onEvent
    )
    run.disposer = disposer
    if (ownerSessionId) liveRuns.set(ownerSessionId, run)

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
  }

  return {
    messages: [],
    tools: [],
    agents: [],
    attachments: [],
    running: false,
    runId: null,
    status: null,
    activity: [],
    intent: null,
    disposer: null,
    sessionId: null,
    projectId: null,

    send: (text, attachments = []) => {
      const trimmed = text.trim()
      if ((!trimmed && attachments.length === 0) || get().running) return

      const userMsg: ChatMessageUI = { id: nextId(), role: 'user', content: trimmed }
      const assistantId = nextId()
      const assistantMsg: ChatMessageUI = {
        id: assistantId,
        role: 'assistant',
        content: '',
        pending: true
      }

      // History sent to the engine: prior turns + this user turn. The user turn's
      // content is augmented with attachment context (inline text for text files, a
      // note for binaries/images) so the model can see what was attached — the
      // *displayed* content stays as the user typed it.
      const historyBase: ChatMessage[] = get().messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
      const attachmentContext = buildAttachmentContext(attachments)
      const userContentForEngine =
        attachmentContext === '' ? trimmed : `${trimmed}\n\n${attachmentContext}`.trim()
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
        activity: [],
        intent: null
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

    decideTool: (toolId, decision) => {
      const { runId, tools } = get()
      const card = tools.find((t) => t.id === toolId)
      if (!runId || !card || card.status !== 'awaiting') return
      window.sylor.workflow.toolDecision(runId, toolId, decision)
      // Record the decision on the live run too, so it survives a session switch
      // and is persisted with the op when the result arrives.
      const run = liveRuns.get(get().sessionId ?? '')
      if (run) {
        const rc = run.tools.find((t) => t.id === toolId)
        if (rc) {
          rc.status = 'running'
          rc.decision = decision
        }
      }
      set((state) => ({
        tools: state.tools.map((t) => (t.id === toolId ? { ...t, status: 'running', decision } : t))
      }))
    },

    cancel: () => {
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
        activity: [],
        runId: null,
        disposer: null
      }))
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
        activity: [],
        intent: null,
        runId: null,
        disposer: null
      })
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
        activity: [],
        intent: null
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
      const { messages, tools, attachments } = hydrate(loaded)
      set({
        sessionId: loaded.session.id,
        projectId: loaded.session.projectId,
        attachments,
        ...projectLiveRun({ messages, tools }, loaded.session.id)
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
