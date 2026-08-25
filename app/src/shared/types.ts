/** Whether the active model provider runs locally (Ollama) or via a remote gateway. */
export type EnvStatus = 'local' | 'remote'

/**
 * Permission posture for tool/command execution.
 *  - `ask`        → every file edit and command asks for approval.
 *  - `auto-edit`  → file edits auto-apply; commands still ask.
 *  - `autonomous` → edits, commands, AND mcp calls auto-apply so a build runs
 *    hands-free. An explicit, opt-in, non-persistent posture: it auto-*approves*,
 *    but every action is still surfaced as a tool-request + tool-result to the UI
 *    and stays sandboxed to the workspace root. There is still no *silent* bypass —
 *    Sylor never acts invisibly.
 * Enforced by the workflow engine's permission matrix (see `decideAuto`).
 */
export type PermissionMode = 'ask' | 'auto-edit' | 'autonomous'

/**
 * Top-level working mode, chosen in the composer (Claude-Code-style):
 *  - `cowork` → a ChatGPT-like conversational assistant. Sylor answers and
 *    writes code directly in the reply; it does NOT scan the project, edit
 *    files, or run commands. No folder access.
 *  - `code`   → the full folder agent: reads the project and proposes file
 *    edits / commands under the permission gate.
 * This is orthogonal to {@link PermissionMode}, which only governs approval of
 * edits/commands *within* Code mode.
 */
export type WorkMode = 'cowork' | 'code'

/** Window-control surface exposed to the renderer via the preload bridge. */
export interface WindowApi {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  /** Subscribe to maximize/unmaximize changes. Returns an unsubscribe function. */
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
}

/** Host platform string, as returned by Node's `process.platform`. */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

// ── Model provider configuration (Phase 2) ────────────────────────────────

/** Which provider backs the active model: local Ollama or a remote REST gateway. */
export type ProviderKind = 'ollama' | 'gateway'

/**
 * How the gateway authenticates a request.
 *  - `none`   → no auth header sent.
 *  - `bearer` → `Authorization: Bearer <apiKey>`.
 *  - `header` → a custom header (`headerName: apiKey`), e.g. `x-api-key`.
 */
export type AuthSchema = 'none' | 'bearer' | 'header'

/** Ollama (local) provider settings. */
export interface OllamaConfig {
  /** Base URL of the Ollama server. Default: http://localhost:11434 */
  baseUrl: string
}

/** Remote gateway (OpenAI-compatible REST) provider settings. */
export interface GatewayConfig {
  /** Base URL of the gateway, e.g. https://api.openai.com/v1 */
  baseUrl: string
  /** Secret credential; stored locally, never logged. */
  apiKey: string
  /** How `apiKey` is attached to requests. */
  authSchema: AuthSchema
  /** Header name used when `authSchema` is 'header' (e.g. 'x-api-key'). */
  authHeaderName: string
}

/** Visual theme: Claude's warm light palette (default) or the dark palette. */
export type Theme = 'light' | 'dark'

/**
 * Reasoning effort the model should spend before answering. Threaded from the
 * composer into the workflow run and turned into a system-prompt directive:
 *  - `low`    → answer directly, minimal deliberation (fast).
 *  - `medium` → the default balance (no extra directive).
 *  - `high`   → reason step by step before answering.
 *  - `max`    → deliberate thoroughly, no skipped steps (slowest).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

/** UI preferences persisted alongside the provider config (Phase A redesign). */
export interface UiSettings {
  /** Active color theme; applied via `<html data-theme>`. */
  theme: Theme
  /** Reasoning effort applied to workflow runs (composer control). */
  effort: ReasoningEffort
  /**
   * When true, a substantial edit turn first writes a `plan.md` capturing the
   * full plan and pauses before making other changes (composer "Plan first"
   * toggle). Off by default so ordinary chats aren't slowed.
   */
  planFirst: boolean
  /**
   * Top-level working mode (composer Cowork/Code toggle). `cowork` is a pure
   * chat assistant (no folder access); `code` is the folder agent. Defaults to
   * `cowork` so casual questions never jump to the terminal.
   */
  mode: WorkMode
  /**
   * Absolute path of the folder the user chose to work in (Code mode,
   * requirement A). Persisted so reopening the app restores the workspace; set
   * via the OS folder picker. Absent until a folder is chosen — Code mode is
   * gated (the composer is blocked) until then.
   */
  workspaceRoot?: string
}

/** The full, persisted provider configuration. */
export interface ProviderSettings {
  /** The provider used for completions. */
  activeProvider: ProviderKind
  ollama: OllamaConfig
  gateway: GatewayConfig
  /** Display name of the selected model (human-facing). */
  modelName: string
  /** Actual identifier sent to the provider API. */
  modelId: string
  /** UI preferences (theme). Persisted in the same settings file. */
  ui: UiSettings
}

/** A model advertised by a provider's list endpoint. */
export interface ModelInfo {
  /** Identifier passed to the API (e.g. 'llama3.1:8b', 'gpt-4o-mini'). */
  id: string
  /** Human-facing label; falls back to `id` when the provider gives no name. */
  name: string
}

/** Result of listing a provider's models. */
export interface ListModelsResult {
  ok: boolean
  models: ModelInfo[]
  /** Present when `ok` is false. */
  error?: string
}

/** Result of a Test Connection probe. */
export interface TestConnectionResult {
  ok: boolean
  /** Human-readable status (success detail or failure reason). */
  message: string
  /** Round-trip time of the probe in milliseconds, when it completed. */
  latencyMs?: number
}

/** A single chat turn passed to a completion request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Input to a (non-streaming or streaming) completion call. */
export interface CompletionRequest {
  /** Provider to use; defaults to the active provider when omitted. */
  provider?: ProviderKind
  /** Model id; defaults to the configured `modelId` when omitted. */
  modelId?: string
  messages: ChatMessage[]
}

/** Result of a non-streaming completion. */
export interface CompletionResult {
  ok: boolean
  /** The assistant's reply text when `ok` is true. */
  content: string
  /** Present when `ok` is false. */
  error?: string
}

/** A chunk emitted while streaming a completion. */
export interface CompletionChunk {
  /** Correlates chunks with their originating request. */
  streamId: string
  /** Incremental text; empty on the terminal chunk. */
  delta: string
  /** True on the final chunk of a stream. */
  done: boolean
  /** Present when the stream ended in error. */
  error?: string
}

// ── AI core & workflow engine (Phase 3) ───────────────────────────────────

/**
 * How a prompt should be handled: `chat` for greetings/small talk (a plain
 * conversational reply, no project scan, no tool proposals), `question` for a
 * read-only explanation, or `edit` for a change/build request.
 */
export type IntentKind = 'chat' | 'question' | 'edit'

/**
 * Lightweight interpretation of a user prompt, produced before the full
 * response. Drives the "You want to…" confirmation line and how much project
 * context the engine gathers.
 */
export interface IntentAnalysis {
  kind: IntentKind
  /** One-sentence restatement of what the user wants (the "You want to…" line). */
  summary: string
  /** Whether answering will require reading project files for context. */
  needsContext: boolean
}

/**
 * Phases the workflow engine moves through. Surfaced to the UI as live activity
 * ("Analyzing project…", "Reading files…"). Execution-heavy phases (editing,
 * running commands) are represented but only *acted on* from Phase 4 onward.
 */
export type WorkflowStage =
  | 'understanding'
  | 'scanning'
  | 'reading'
  | 'planning'
  | 'generating'
  | 'executing'
  | 'verifying'
  | 'done'

// ── Tool execution (Phase 4) ──────────────────────────────────────────────

/** The kinds of side-effecting operations the engine can propose. */
export type ToolKind = 'write_file' | 'run_command' | 'mcp_call'

/** A proposed file write: full new contents for a project-relative path. */
export interface WriteFileProposal {
  id: string
  kind: 'write_file'
  /** Project-relative POSIX path (validated against the sandbox root). */
  path: string
  /** Existing file contents, or '' when the file is new. */
  oldContent: string
  /** Proposed new contents (the model's full-file rewrite). */
  newContent: string
  /** Whether the target file already exists (edit vs create). */
  exists: boolean
}

/** A proposed shell command to run in the integrated terminal. */
export interface RunCommandProposal {
  id: string
  kind: 'run_command'
  /** The command line to execute. */
  command: string
}

/**
 * A proposed call to a tool on a connected MCP server. Always permission-gated
 * (like run_command): Sylor never invokes an external MCP tool without explicit
 * approval, since the call may reach the network or spawn work in a local process.
 */
export interface McpCallProposal {
  id: string
  kind: 'mcp_call'
  /** The configured MCP server name (config key). */
  server: string
  /** The tool name advertised by that server. */
  name: string
  /** Arguments object passed to the tool (JSON-serializable). */
  arguments: Record<string, unknown>
}

/** Discriminated union of everything the engine can ask to do. */
export type ToolProposal = WriteFileProposal | RunCommandProposal | McpCallProposal

/** The user's (or permission-mode's) verdict on a proposal. */
export type ToolDecision = 'approve' | 'reject'

/** Outcome of an applied `write_file` proposal. */
export interface WriteFileResult {
  id: string
  kind: 'write_file'
  ok: boolean
  /** Present when `ok` is false (e.g. sandbox violation, write error). */
  error?: string
}

/** Outcome of an executed `run_command` proposal. */
export interface RunCommandResult {
  id: string
  kind: 'run_command'
  /** Process exit code (null if it was killed before exiting). */
  exitCode: number | null
  /** Captured (bounded) combined output. */
  output: string
  /** True when output was truncated at the capture cap. */
  truncated: boolean
}

/** Outcome of an executed `mcp_call` proposal. */
export interface McpCallResult {
  id: string
  kind: 'mcp_call'
  /** Whether the tool call completed without error. */
  ok: boolean
  /** Flattened text content returned by the tool (bounded). */
  output: string
  /** True when `output` was truncated at the capture cap. */
  truncated: boolean
  /** Present when `ok` is false (call failed, server missing, or tool errored). */
  error?: string
}

/** Discriminated union of tool outcomes reported back to the renderer. */
export type ToolResult = WriteFileResult | RunCommandResult | McpCallResult

/**
 * The role an agent plays in a Code build (requirement B). `lead` is the
 * top-level orchestrator (the run itself); it delegates to `planner` (writes /
 * refines plan.md), `builder` (implements a slice), and `reviewer` (verifies)
 * subagents via a `spawn_agent` tool block.
 *
 * The orchestrator (see `main/workflow/orchestrator/roles.ts`) adds a
 * capability-based role registry — `frontend`, `backend`, `database`,
 * `security`, `research`, `devops`, `testing`, `docs`, `integration`,
 * `project-analyst`, … — so this is widened to any registry key while keeping
 * the four historical values valid for persisted sessions and autocomplete.
 */
export type AgentRole = 'lead' | 'planner' | 'builder' | 'reviewer' | (string & {})

// ── Orchestration data model (hierarchical multi-agent) ───────────────────
//
// These types are the cross-process contract for the orchestrator: task-graph
// nodes, shared-context findings, and the typed agent-to-agent messages all
// flow to the renderer over `WorkflowEvent`, so they live here (not in the
// engine-only `orchestrator/` module). Engine-internal shapes (Capability,
// AgentRoleDef) stay under `orchestrator/`.

/**
 * How much team the orchestrator assembles for a work turn. Decided by the
 * complexity router (`orchestrator/complexity.ts`), heuristic-first:
 *  - `simple`  → collapse to a single execution node (no planner LLM call).
 *  - `medium`  → a small plan of a few specialists.
 *  - `complex` → a multi-domain plan with dependencies + parallelism.
 * Team size only — the plan → execute → verify → review gate always runs.
 */
export type Complexity = 'simple' | 'medium' | 'complex'

/**
 * Lifecycle of a {@link TaskNode} in the task graph. The scheduler moves a node
 * pending → ready (deps met) → running → completed | failed; a failed node may
 * go retrying → ready again (bounded), or blocked when a dependency failed, or
 * cancelled when the run is aborted.
 */
export type TaskState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled'

/**
 * One unit of work in the task graph (a DAG). Produced by the planner (or a
 * single synthesized node for SIMPLE turns), executed by a scoped specialist
 * agent of `role`. `dependsOn` references other node ids; the scheduler runs the
 * ready set (all deps completed) in parallel.
 */
export interface TaskNode {
  /** Stable id within the run (e.g. `t1`); referenced by `dependsOn`. */
  id: string
  /** Registry role that executes this node (validated against roles.ts). */
  role: AgentRole
  /** What this node must accomplish (the specialist's task brief). */
  description: string
  /** Ids of nodes that must complete before this one is ready. */
  dependsOn: string[]
  /** Current lifecycle state (drives scheduling + the UI task list). */
  state: TaskState
  /** How many times execution has been attempted (retry bookkeeping). */
  attempts: number
  /** Optional planner hint of files this node is expected to touch. */
  filesHint?: string[]
  /** The specialist's final report once `completed`. */
  result?: string
  /** Failure message once `failed`. */
  error?: string
}

/**
 * A fact discovered, decision made, or artifact produced by an agent, recorded
 * on the shared-context blackboard. Downstream nodes receive a *scoped* digest
 * (their task + upstream dependency findings only) so agents don't rediscover
 * the same facts or drown in unrelated output.
 */
export interface Finding {
  /** The agent that produced it (correlates with agent-start/agent-end). */
  agentId: string
  /** The task node this finding came out of. */
  taskId: string
  /** The producing agent's role. */
  role: AgentRole
  /** The fact / decision / artifact, in one or two sentences. */
  detail: string
  /** Files this finding touched or refers to (optional). */
  files?: string[]
}

/** The kinds of typed agent-to-agent / agent-to-orchestrator control signals. */
export type AgentMessageType =
  | 'TASK_ASSIGNED'
  | 'STARTED'
  | 'FINDING'
  | 'REQUEST_INFO'
  | 'REQUEST_REVIEW'
  | 'HANDOFF'
  | 'BLOCKED'
  | 'DEPENDENCY_READY'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'RETRY_REQUIRED'

/**
 * A structured message exchanged during orchestration. These are real
 * control-flow signals (they drive the scheduler and review routing) *and*
 * surface to the UI as `agent-message` events for the activity view. Unlike the
 * old prose "report", the fields are machine-readable so the orchestrator never
 * has to re-parse natural language.
 */
export interface AgentMessage {
  /** Which control signal this is. */
  type: AgentMessageType
  /** The task node this message concerns. */
  taskId: string
  /** The parent task (for HANDOFF / rework routing), when applicable. */
  parentTaskId?: string
  /** The sender (an agentId, or `'orchestrator'` for engine-emitted messages). */
  agentId: string
  /** The sender's role. */
  role: AgentRole
  /** Intended recipient: a role, a taskId, `'orchestrator'`, or `'all'`. */
  recipient?: string
  /** The task's lifecycle state at send time, when relevant. */
  status?: TaskState
  /** One-line human summary (shown in the UI; safe to display verbatim). */
  summary: string
  /** Structured findings carried with this message. */
  findings?: Finding[]
  /** Files this agent changed. */
  filesChanged?: string[]
  /** Task ids this message depends on / unblocks. */
  dependencies?: string[]
  /** Opaque artifact references (paths, ids) produced. */
  artifacts?: string[]
  /** Error strings, when reporting a failure. */
  errors?: string[]
  /** What should happen next (e.g. a rework instruction), when applicable. */
  nextAction?: string
}

/** Discriminated union of events streamed from the engine to the renderer. */
export type WorkflowEvent =
  | { type: 'intent'; runId: string; intent: IntentAnalysis }
  /**
   * `retrying` marks a transient-failure notice (rate limit / 5xx / timeout) that
   * the engine is about to wait out and re-attempt. The UI renders these dimmed
   * (low opacity) so a retry storm reads as background noise rather than progress.
   */
  | {
      type: 'status'
      runId: string
      stage: WorkflowStage
      message: string
      agentId?: string
      retrying?: boolean
    }
  | { type: 'delta'; runId: string; text: string; agentId?: string }
  /**
   * The engine proposes a side-effecting op and awaits a decision. `auto` is
   * true when the permission mode pre-approved it (UI shows it informationally).
   * `agentId` attributes it to a subagent (absent = the lead).
   */
  | { type: 'tool-request'; runId: string; proposal: ToolProposal; auto: boolean; agentId?: string }
  /** The outcome of a proposal (after approval + execution, or a failure). */
  | { type: 'tool-result'; runId: string; result: ToolResult; agentId?: string }
  /**
   * The lead delegated a task to a subagent (requirement B): the UI opens a
   * nested card. `agentId` correlates the subagent's status/delta/tool events.
   */
  | { type: 'agent-start'; runId: string; agentId: string; role: AgentRole; task: string }
  /** A subagent finished; `report` is its final summary handed back to the lead. */
  | { type: 'agent-end'; runId: string; agentId: string; role: AgentRole; report: string; ok: boolean }
  /**
   * Orchestration events (additive — an older renderer simply ignores unknown
   * `type`s). `plan` announces the task graph the orchestrator will execute;
   * `task-update` reports a node's lifecycle change (drives the task list);
   * `agent-message` carries a typed agent-to-agent/orchestrator control signal.
   */
  | { type: 'plan'; runId: string; complexity: Complexity; tasks: TaskNode[] }
  | { type: 'task-update'; runId: string; task: TaskNode }
  | { type: 'agent-message'; runId: string; message: AgentMessage }
  | { type: 'done'; runId: string }
  | { type: 'error'; runId: string; message: string }

/** Input to start a workflow run for a user turn. */
export interface WorkflowRunRequest {
  /** Client-generated id correlating events and cancellation with this run. */
  runId: string
  /** Full conversation history (system/user/assistant turns) for context. */
  messages: ChatMessage[]
  /** Permission posture governing edit/command auto-approval. */
  permissionMode: PermissionMode
  /**
   * Project this chat is filed under, if any. The engine loads the project's
   * instructions + knowledge and prepends them as a system turn (still
   * root-scoped — no file access beyond the active project root).
   */
  projectId?: string | null
  /**
   * Reasoning effort for this run (composer control). Turned into a
   * system-prompt directive by the engine. Defaults to `medium` when omitted.
   */
  effort?: ReasoningEffort
  /**
   * When true, a substantial edit turn is instructed to write `plan.md` first
   * and stop before other edits ("Plan first" toggle). Defaults to false.
   */
  planFirst?: boolean
  /**
   * Top-level working mode for this run. `cowork` runs a pure conversational
   * turn (no project scan, no tools); `code` runs the folder agent. Defaults to
   * `code` when omitted (full capability), so an unspecified request keeps the
   * agent behavior the engine tests assume.
   */
  mode?: WorkMode
}

/** Renderer-facing API for the AI workflow engine. */
export interface WorkflowApi {
  /**
   * Start a workflow run. `onEvent` fires for each event (intent → status →
   * deltas → tool-request/tool-result → done/error). Returns a disposer that
   * cancels the run and detaches.
   */
  run: (request: WorkflowRunRequest, onEvent: (event: WorkflowEvent) => void) => () => void
  /**
   * Resolve a pending `tool-request` for a run. The engine is blocked awaiting
   * this decision; `approve` executes the proposal, `reject` skips it.
   */
  toolDecision: (runId: string, toolId: string, decision: ToolDecision) => void
}

/** Renderer-facing API for model providers. */
export interface ProvidersApi {
  /** Read the persisted provider settings. */
  getSettings: () => Promise<ProviderSettings>
  /** Persist provider settings; returns the saved (normalised) value. */
  saveSettings: (settings: ProviderSettings) => Promise<ProviderSettings>
  /** List models for a provider using the supplied (unsaved) config. */
  listModels: (
    kind: ProviderKind,
    config: OllamaConfig | GatewayConfig
  ) => Promise<ListModelsResult>
  /** Probe a provider with a model id; used by the Test Connection button. */
  testConnection: (
    kind: ProviderKind,
    config: OllamaConfig | GatewayConfig,
    modelId: string
  ) => Promise<TestConnectionResult>
  /** Run a non-streaming completion against the saved settings. */
  getCompletion: (request: CompletionRequest) => Promise<CompletionResult>
  /**
   * Start a streaming completion. `onChunk` fires for each delta until `done`.
   * Returns a promise resolving to a disposer that cancels the subscription.
   */
  streamCompletion: (
    request: CompletionRequest,
    onChunk: (chunk: CompletionChunk) => void
  ) => Promise<() => void>
}

// ---------------------------------------------------------------------------
// Session persistence (Phase 5)
// ---------------------------------------------------------------------------

/** Lightweight session row for the sidebar list (no message bodies). */
export interface SessionSummary {
  id: string
  title: string
  projectRoot: string
  /** Project this chat is filed under, or null when unfiled (chat-first redesign). */
  projectId: string | null
  /** Epoch ms the session was created. */
  createdAt: number
  /** Epoch ms of the last write; drives sort order and "most recent". */
  updatedAt: number
  /** Number of chat messages stored, for the list preview. */
  messageCount: number
}

/** A persisted chat message (mirrors the terminal fields of {@link ChatMessage}). */
export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Set when the turn failed; surfaced as an error card on reopen. */
  error?: string
  /**
   * Local-only reaction the user left on this message (Phase 5 message actions).
   * Absent when no reaction was given. Never transmitted anywhere.
   */
  feedback?: 'like' | 'dislike'
  /** Local-only "report/flag" marker the user toggled. Absent when not flagged. */
  flagged?: boolean
}

/**
 * A persisted, completed tool operation (proposal + result). Only terminal
 * ('complete') tool states are stored — an awaiting/running card is transient
 * run state, not history — so no status field is persisted; rehydrated cards
 * are always complete and read-only.
 */
export interface PersistedToolOp {
  id: string
  /** Anchor message the card renders after (ChatPanel groups by this). */
  afterMessageId: string
  runId: string
  auto: boolean
  /** The user's approve/reject, if the card required a decision. */
  decision?: ToolDecision
  proposal: ToolProposal
  result?: ToolResult
  /**
   * Character offset into the anchor message's content at which this card was
   * proposed, so the renderer can interleave prose and cards in the order they
   * streamed (think → act → think). Absent on ops persisted before this existed.
   */
  contentOffset?: number
  /**
   * When the op was performed by a subagent (requirement B): its `agentId`
   * (correlates a run's nested group) and `agentRole` (header label on reload).
   * Absent for the lead's own ops.
   */
  agentId?: string
  agentRole?: AgentRole
}

/**
 * A file the user attached to a chat (composer drop / paperclip). Bytes live on
 * disk under `userData/attachments/<sessionId>/`; only this metadata is stored in
 * SQLite. `messageId` is null while the attachment is pending (before send) and
 * set to the user message it rode along with once the turn is sent.
 */
export interface Attachment {
  id: string
  sessionId: string
  /** The user message this attachment belongs to, or null while pending. */
  messageId: string | null
  /** Original (sanitized) filename shown in the chip. */
  name: string
  /** MIME type sniffed from the browser File (e.g. 'image/png', 'text/plain'). */
  mime: string
  /** Absolute on-disk path of the stored bytes (main-process only detail). */
  path: string
  /** File size in bytes, for the chip's label. */
  size: number
  /** Epoch ms the attachment was stored. */
  createdAt: number
}

/** A fully-loaded session: metadata + ordered messages, tools, terminal log. */
export interface PersistedSession {
  session: SessionSummary
  messages: PersistedMessage[]
  tools: PersistedToolOp[]
  /** Raw pty output chunks in append order (ANSI preserved) for replay. */
  terminal: string[]
  /** Attachments tied to sent messages, oldest first (chat-first redesign). */
  attachments: Attachment[]
}

/**
 * Renderer-facing API for session persistence (Phase 5). Query-style ops are
 * promise-returning (invoke/handle); high-frequency appends are fire-and-forget
 * (send/on) so the live chat and terminal never block on a DB round-trip.
 */
export interface SessionsApi {
  /** All sessions for the active project root, newest first. Filter by project. */
  list: (projectId?: string | null) => Promise<SessionSummary[]>
  /** Create a fresh session (optionally filed under a project) and return it. */
  create: (projectId?: string | null) => Promise<SessionSummary>
  /** Load a session's full contents for rehydration. */
  load: (id: string) => Promise<PersistedSession>
  /** Rename a session (bumps updatedAt). */
  rename: (id: string, title: string) => Promise<void>
  /** Delete a session and all its rows (cascades). */
  remove: (id: string) => Promise<void>
  /** The id of the most-recently-updated session, or null if none. */
  mostRecent: () => Promise<string | null>
  /**
   * Search sessions by substring over title + message content, newest first.
   * Scoped to the active project root; pass `projectId` to narrow to a project.
   */
  search: (query: string, projectId?: string | null) => Promise<SessionSummary[]>
  /** Append a chat message (fire-and-forget). */
  appendMessage: (sessionId: string, msg: PersistedMessage) => void
  /** Finalize a streamed assistant turn's content/error (fire-and-forget). */
  updateMessage: (sessionId: string, id: string, content: string, error?: string) => void
  /**
   * Set a message's local feedback (like/dislike) + report flag (fire-and-forget).
   * Both are local-only markers — passing `null`/`false` clears them.
   */
  setFeedback: (
    sessionId: string,
    id: string,
    feedback: 'like' | 'dislike' | null,
    flagged: boolean
  ) => void
  /**
   * Reset an assistant message for a Rewrite/regenerate (fire-and-forget): drops
   * its tool ops and blanks its content/feedback so a reload shows only the
   * regenerated result. Local-only.
   */
  resetMessage: (sessionId: string, id: string) => void
  /** Append a completed tool operation (fire-and-forget). */
  appendToolOp: (sessionId: string, op: PersistedToolOp) => void
  /** Append a raw terminal output chunk (fire-and-forget). */
  appendTerminal: (sessionId: string, data: string) => void
}

// ---------------------------------------------------------------------------
// Live preview (chat-first redesign)
// ---------------------------------------------------------------------------

/**
 * A lifecycle event for the right-side live preview, pushed main → renderer.
 * The renderer mirrors these into store state so the panel is a pure function
 * of state (webview src, loading placeholder, error card, and reload trigger).
 */
export interface PreviewEvent {
  /**
   * - `starting` — a dev server is spawning; no URL yet (show a placeholder).
   * - `ready`    — a localhost URL is available; load/point the webview at it.
   * - `reload`   — watched files changed; the panel reloads the webview.
   * - `stopped`  — the preview was stopped/closed.
   * - `error`    — the preview failed to start (`message` set).
   */
  phase: 'starting' | 'ready' | 'reload' | 'stopped' | 'error'
  /** The localhost URL to load (set on `ready`). Always `127.0.0.1`/`localhost`. */
  url?: string
  /** Human-readable detail (set on `error`). */
  message?: string
}

/** Result of a preview start call: the localhost URL now being served, or an error. */
export interface PreviewStartResult {
  ok: boolean
  /** The localhost URL to load when `ok`. */
  url?: string
  /** Failure detail when `!ok`. */
  error?: string
}

/**
 * Renderer-facing API for the right-side live preview (chat-first redesign). A
 * built-in `node:http` server serves the project's static files; dev-server
 * commands are spawned and their localhost URL scraped from stdout. Everything
 * is bound to `127.0.0.1` — no outbound network, consistent with the sandbox.
 */
export interface PreviewApi {
  /**
   * Boot (or reuse) the static file server rooted at the project and point it at
   * `entry` (project-relative, default `index.html`). Resolves with the URL.
   */
  startStatic: (entry?: string) => Promise<PreviewStartResult>
  /**
   * Spawn a dev-server `command` and resolve once its `http://localhost:PORT`
   * URL is scraped from stdout (or an error/timeout). Kills any prior dev server.
   */
  startDev: (command: string) => Promise<PreviewStartResult>
  /** Stop the dev server, close the static server, and drop the file watcher. */
  stop: () => void
  /** Subscribe to preview lifecycle events; returns a disposer. */
  onEvent: (callback: (event: PreviewEvent) => void) => () => void
}

/**
 * Current workspace root (requirement A) + whether the user explicitly chose it
 * (vs. the `process.cwd()` default). Code mode is gated until `chosen` is true.
 */
export interface WorkspaceInfo {
  root: string
  chosen: boolean
}

/**
 * Renderer-facing API for the working folder (Code mode). Selecting a folder
 * retargets the agent's sandbox root (`contextManager`) — and with it the
 * engine, preview, MCP, and skills — and persists it for next launch.
 */
export interface WorkspaceApi {
  /** Open the OS folder picker; on pick, retarget the root. Null if cancelled. */
  select: () => Promise<WorkspaceInfo | null>
  /** Current workspace root + whether it was explicitly chosen. */
  get: () => Promise<WorkspaceInfo>
  /** Subscribe to workspace-root changes; returns a disposer. */
  onChanged: (callback: (info: WorkspaceInfo) => void) => () => void
}

/** The full `window.sylor` API surface exposed by the preload script. */
export interface SylorApi {
  window: WindowApi
  /** Host platform string (e.g. 'win32', 'darwin', 'linux'). */
  platform: Platform
  /** Model provider configuration, listing, and completions (Phase 2). */
  providers: ProvidersApi
  /** AI workflow engine: intent analysis + streamed responses (Phase 3). */
  workflow: WorkflowApi
  /** Session persistence: history, reopen/rename/delete (Phase 5). */
  sessions: SessionsApi
  /** Projects: group chats with per-project instructions + knowledge. */
  projects: ProjectsApi
  /** Attachments: files dropped into the composer (chat-first redesign). */
  attachments: AttachmentsApi
  /** Right-side live preview: static file server + dev-server URL scraping. */
  preview: PreviewApi
  /** MCP client: connect to configured servers and expose their tools. */
  mcp: McpApi
  /** Skills: disk-authored capability folders the model can invoke. */
  skills: SkillsApi
  /** Working folder (Code mode): select/get the agent's sandbox root. */
  workspace: WorkspaceApi
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) client — extensibility
// ---------------------------------------------------------------------------

/**
 * A local (stdio) MCP server: Sylor spawns `command` as a child process and
 * speaks MCP over its stdio. Reaches only the local machine.
 */
export interface McpStdioServerConfig {
  /** Executable to spawn (e.g. 'npx', 'node', 'uvx'). */
  command: string
  /** Arguments passed to the command. */
  args?: string[]
  /** Extra environment variables for the child process. */
  env?: Record<string, string>
}

/**
 * A remote (HTTP) MCP server. This is the one intentional relaxation of Sylor's
 * offline posture: it reaches out only to a URL the user explicitly configured
 * on disk. `headers` (e.g. Authorization) are stored locally and never logged.
 */
export interface McpHttpServerConfig {
  /** Remote MCP endpoint (Streamable HTTP, with SSE fallback). */
  url: string
  /** Optional headers sent with every request (e.g. auth). Stored locally. */
  headers?: Record<string, string>
}

/** A configured MCP server: local stdio process OR remote HTTP endpoint. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** The on-disk `mcp.json` shape (mirrors the Claude CLI's `.mcp.json`). */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>
}

/** Transport a server uses, surfaced to the UI as a badge. */
export type McpTransport = 'stdio' | 'http'

/**
 * Where a server's definition came from:
 *  - `catalog` → a curated built-in server from Sylor's MCP catalog.
 *  - `global`  → the user's `~/.sylor/mcp.json` (a custom server).
 *  - `project` → the project's `<root>/.sylor/mcp.json` (a custom server).
 * A disk server (global/project) sharing a catalog name overrides the built-in.
 */
export type McpConfigSource = 'catalog' | 'global' | 'project'

/**
 * Broad grouping for the connectors UI (curated built-ins are tagged; custom
 * servers default to `development`). Mirrors the recommended catalog categories.
 */
export type McpCategory =
  | 'core'
  | 'files'
  | 'git'
  | 'development'
  | 'browser'
  | 'web'
  | 'database'
  | 'data'
  | 'productivity'
  | 'external'

/**
 * Coarse risk/scope of a server, so the UI can be honest about what enabling it
 * exposes (and so nothing dangerous is ever a default):
 *  - `read-only` → pure computation / read-only queries, no side effects.
 *  - `local`     → reads/writes on the local machine only.
 *  - `network`   → reaches out over the network.
 *  - `system`    → drives system-level surfaces (a browser, OS automation).
 *  - `high`      → broad shell/system control; never enabled by default.
 */
export type McpRisk = 'read-only' | 'local' | 'network' | 'system' | 'high'

/** A tool advertised by a connected MCP server. */
export interface McpToolInfo {
  /** The server (config key) this tool belongs to. */
  server: string
  /** Tool name, as advertised by the server. */
  name: string
  /** Human description advertised by the server (may be empty). */
  description: string
}

/**
 * Connection state of a configured MCP server.
 *  - `connecting`   → connect in flight.
 *  - `connected`    → connected; tools discovered and exposed to the model.
 *  - `error`        → enabled but the connection/list failed (`error` set).
 *  - `disabled`     → user-set off switch (persisted): listed but never connected,
 *    so its tools never reach the model and calls to it fail.
 *  - `unconfigured` → enabled but it needs an API key or configuration Sylor
 *    doesn't have yet, so it is deliberately NOT connected (no misleading
 *    "connected"/"error"): the UI shows what's required.
 */
export type McpConnectionState =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disabled'
  | 'unconfigured'

/** Status of one configured MCP server, surfaced to the settings UI. */
export interface McpServerStatus {
  /** Server name (config key / catalog id). */
  name: string
  /** Human-facing display name (catalog), falling back to `name`. */
  title: string
  /** One-line description (catalog / empty for custom disk servers). */
  description: string
  /** Category grouping for the connectors list. */
  category: McpCategory
  transport: McpTransport
  source: McpConfigSource
  state: McpConnectionState
  /** Whether the user has this server enabled. A disabled server is never connected. */
  enabled: boolean
  /** Number of tools discovered (0 unless connected). */
  toolCount: number
  /** Error detail when `state` is 'error'. */
  error?: string
  /** True for a curated built-in from the catalog; false for a custom disk server. */
  builtIn: boolean
  /** Whether Sylor suggests enabling this (guides opt-in; never auto-enables). */
  recommended: boolean
  /** True when it runs locally; false when it reaches the network. */
  local: boolean
  /** Always true for the curated catalog (free / open-source / zero-cost). */
  free: boolean
  /** Coarse risk/scope, so the UI is honest about what enabling exposes. */
  risk: McpRisk
  /**
   * When set, enabling needs this credential (e.g. "GitHub personal access
   * token"). Such a server shows `unconfigured` until the key is supplied via
   * `mcp.json`; Sylor never hardcodes or prompts for keys inline.
   */
  requiresApiKey?: string
  /** Documentation/homepage URL (catalog entries). */
  homepage?: string
}

/** Which config file a write targets: the global `~/.sylor` or the project's. */
export type ConfigScope = 'global' | 'project'

/**
 * Input for adding/importing a custom MCP server from the UI. `json` is the raw
 * text the user pasted — a single server object (`{ "command": … }` /
 * `{ "url": … }`), a bare name→server map, or a full `{ "mcpServers": { … } }`
 * block copied from a server's docs. `name` is used only when `json` is a single
 * unnamed server object. Validated + merged into the chosen scope's `mcp.json`.
 */
export interface McpAddServerInput {
  name: string
  json: string
  scope: ConfigScope
}

/** Outcome of an add/import attempt: the fresh server list, or a friendly error. */
export interface McpMutationResult {
  ok: boolean
  /** Present when `ok` is false (invalid JSON, no server found, write failed). */
  error?: string
  /** Number of servers written (add/import can bring in several at once). */
  added?: number
  /** Fresh status for the settings UI (unchanged when `ok` is false). */
  servers: McpServerStatus[]
}

/**
 * Renderer-facing API for the MCP subsystem. Servers come from two places: a
 * curated built-in catalog (opt-in — most off by default) and the user's own
 * `mcp.json` on disk (global `~/.sylor/mcp.json` + per-project
 * `<root>/.sylor/mcp.json`). Toggling persists locally and connects/disconnects
 * immediately; a disabled server never connects, so its tools never reach the
 * model.
 */
export interface McpApi {
  /** Current status of every server (catalog + custom). */
  listServers: () => Promise<McpServerStatus[]>
  /** All tools discovered across connected servers. */
  listTools: () => Promise<McpToolInfo[]>
  /** Reload `mcp.json` from disk and reconnect all servers; returns fresh status. */
  reconnect: () => Promise<McpServerStatus[]>
  /** Enable/disable a server by name (persisted, applied immediately); returns fresh status. */
  setEnabled: (name: string, enabled: boolean) => Promise<McpServerStatus[]>
  /**
   * Clear every enable/disable override so each server reverts to its default
   * (catalog defaults; custom disk servers back on). Never deletes `mcp.json`
   * entries — only the on/off overrides. Returns fresh status.
   */
  restoreDefaults: () => Promise<McpServerStatus[]>
  /**
   * Add/import one or more servers into `mcp.json` (the chosen scope), then
   * reconnect. Validates the pasted JSON main-side; returns a friendly error
   * rather than throwing when it's malformed or defines no valid server.
   */
  addServer: (input: McpAddServerInput) => Promise<McpMutationResult>
  /**
   * Remove a custom server's `mcp.json` entry (both scopes it may live in), then
   * reconnect. A catalog server configured on disk reverts to its built-in
   * default; a purely-custom one disappears. Returns fresh status.
   */
  removeServer: (name: string) => Promise<McpServerStatus[]>
  /** Absolute paths of the config files (for the "edit config" hint in the UI). */
  configPaths: () => Promise<{ global: string; project: string | null }>
}

// ---------------------------------------------------------------------------
// Skills (model-invoked capability folders) — extensibility
// ---------------------------------------------------------------------------

/**
 * Where a skill came from:
 *  - `builtin` → a curated built-in skill from Sylor's skills catalog.
 *  - `global`  → `~/.sylor/skills/<name>/SKILL.md` (user-authored).
 *  - `project` → `<root>/.sylor/skills/<name>/SKILL.md` (user-authored).
 * A disk skill (global/project) sharing a builtin name overrides the built-in.
 */
export type SkillSource = 'builtin' | 'global' | 'project'

/** Broad grouping for the skills UI (mirrors the recommended catalog categories). */
export type SkillCategory =
  | 'coding'
  | 'debugging'
  | 'planning'
  | 'project'
  | 'testing'
  | 'research'
  | 'web'
  | 'security'
  | 'documentation'
  | 'git'
  | 'devops'
  | 'performance'

/**
 * A capability folder discovered on disk as `<dir>/SKILL.md` (mirrors the Claude
 * CLI's skills). The model is shown each skill's name + description (+ when-to-use)
 * in the system prompt and can invoke one with a `use_skill` block; doing so
 * injects the skill's full instruction body into the conversation so the next
 * loop iteration follows it. The instructions are treated as prompt content, not
 * privileged — any side effects they trigger still flow through the gated tools.
 */
export interface SkillInfo {
  /** Unique key: the frontmatter `name`, falling back to the folder name. */
  name: string
  /** One-line description shown to the model in the skills listing (may be empty). */
  description: string
  /** Optional "when to use this" hint, surfaced to the model and the UI. */
  whenToUse: string
  /** Full instruction body (everything after the frontmatter) — injected on use. */
  instructions: string
  /** Which location the skill was read from (project shadows global by name). */
  source: SkillSource
  /** Absolute path of the SKILL.md file (for the UI's "edit" hint); '' for built-ins. */
  path: string
  /** Human-facing display name (catalog); the UI falls back to `name`. */
  title?: string
  /** Category grouping (catalog); the UI defaults custom skills to a generic bucket. */
  category?: SkillCategory
  /** True for a curated built-in from the catalog; absent/false for disk skills. */
  builtIn?: boolean
  /**
   * Default enabled state when the user hasn't set an override. Built-in skills
   * carry an explicit value (safe essentials default on); disk skills are on by
   * default (absent → treated as true).
   */
  defaultOn?: boolean
  /** Whether Sylor suggests enabling this (guides opt-in). */
  recommended?: boolean
  /**
   * MCP servers this skill leans on. If one is disabled the UI surfaces
   * "requires X" and offers to enable it — it is never silently enabled.
   */
  requiresMcp?: string[]
}

/**
 * A discovered skill plus whether it's currently enabled. Disabled skills are
 * hidden from the model (kept out of the prompt and refused for `use_skill`); the
 * override set is persisted locally. This is what the settings UI lists.
 */
export interface SkillStatus {
  name: string
  /** Human-facing display name (catalog), falling back to `name`. */
  title: string
  description: string
  whenToUse: string
  /** Category grouping for the skills list. */
  category: SkillCategory
  source: SkillSource
  /** False when the user turned this skill off (or a built-in default-off). */
  enabled: boolean
  /** True for a curated built-in; false for a user-authored disk skill. */
  builtIn: boolean
  /** Whether Sylor suggests enabling this (guides opt-in). */
  recommended: boolean
  /** MCP servers this skill leans on (names), for the dependency hint. */
  requiresMcp: string[]
}

/**
 * Input for authoring a new skill from the UI. Sylor renders these fields into a
 * `SKILL.md` frontmatter block (`name`/`description`/`when_to_use`) followed by
 * `instructions` as the body, then writes it to `<scope>/skills/<slug>/SKILL.md`.
 */
export interface SkillAddInput {
  name: string
  description?: string
  whenToUse?: string
  instructions: string
  scope: ConfigScope
}

/** Outcome of an add attempt: the fresh skill list, or a friendly error. */
export interface SkillMutationResult {
  ok: boolean
  /** Present when `ok` is false (blank name/body, no writable scope, write failed). */
  error?: string
  /** Fresh list for the settings UI (unchanged when `ok` is false). */
  skills: SkillStatus[]
}

/**
 * Renderer-facing API for skills. Skills come from a curated built-in catalog
 * (opt-in — safe essentials on by default) and from disk
 * (`~/.sylor/skills/<name>/SKILL.md` + per-project `<root>/.sylor/skills/...`).
 * The UI toggles each on/off (persisted locally), authors new ones, and can
 * re-scan disk.
 */
export interface SkillsApi {
  /** Every skill (catalog + disk; project shadows global) with its enabled flag. */
  list: () => Promise<SkillStatus[]>
  /** Re-scan disk for skills; returns the fresh list. */
  reload: () => Promise<SkillStatus[]>
  /** Enable/disable a skill by name (persisted); returns the updated list. */
  setEnabled: (name: string, enabled: boolean) => Promise<SkillStatus[]>
  /**
   * Clear every enable/disable override so each skill reverts to its default
   * (catalog defaults; disk skills back on). Returns the updated list.
   */
  restoreDefaults: () => Promise<SkillStatus[]>
  /**
   * Author a new skill: write a `SKILL.md` on disk (chosen scope), then re-scan.
   * Validates main-side; returns a friendly error rather than throwing on a blank
   * name/body or an unwritable scope.
   */
  add: (input: SkillAddInput) => Promise<SkillMutationResult>
  /**
   * Delete a disk skill's `SKILL.md` (and its now-empty folder), then re-scan. A
   * built-in catalog skill has nothing on disk to remove and is left untouched.
   * Returns the fresh list.
   */
  remove: (name: string) => Promise<SkillStatus[]>
  /** Absolute paths of the skills directories (for the "add a skill" hint). */
  configPaths: () => Promise<{ global: string; project: string | null }>
}

// ---------------------------------------------------------------------------
// Projects (chat-first redesign)
// ---------------------------------------------------------------------------

/**
 * A project groups related chats and carries per-project `instructions` that the
 * workflow engine prepends as a system turn, plus optional knowledge documents.
 */
export interface Project {
  id: string
  name: string
  /** Custom instructions injected ahead of every chat filed under this project. */
  instructions: string
  /**
   * Long-term memory for this project: a single growing note the engine injects
   * into every chat filed here and that Sylor appends to via the `remember`
   * tool. One project = one memory. Empty until something is remembered.
   */
  memory: string
  /** Epoch ms the project was created. */
  createdAt: number
  /** Epoch ms of the last edit (rename / instructions / knowledge change). */
  updatedAt: number
  /** Number of chats currently filed under this project (for the rail badge). */
  sessionCount: number
}

/** A knowledge document attached to a project (name + freeform content). */
export interface ProjectKnowledge {
  id: string
  projectId: string
  name: string
  content: string
  createdAt: number
}

/**
 * Renderer-facing API for projects. Query-style ops are promise-returning
 * (invoke/handle), mirroring {@link SessionsApi}. All ops are global (not
 * root-scoped): a project can hold chats regardless of their project root.
 */
export interface ProjectsApi {
  /** All projects, newest-updated first, with chat counts. */
  list: () => Promise<Project[]>
  /** Create a project with a name (empty instructions) and return it. */
  create: (name: string) => Promise<Project>
  /** Rename a project (bumps updatedAt). */
  rename: (id: string, name: string) => Promise<void>
  /** Replace a project's custom instructions (bumps updatedAt). */
  setInstructions: (id: string, instructions: string) => Promise<void>
  /** Replace a project's long-term memory note (user edit / clear; bumps updatedAt). */
  setMemory: (id: string, memory: string) => Promise<void>
  /** Delete a project; its chats are detached (project_id → NULL), not deleted. */
  remove: (id: string) => Promise<void>
  /** File a chat under a project (or unfile it when projectId is null). */
  assignSession: (sessionId: string, projectId: string | null) => Promise<void>
  /** List a project's knowledge documents, oldest first. */
  listKnowledge: (projectId: string) => Promise<ProjectKnowledge[]>
  /** Add a knowledge document to a project and return it. */
  addKnowledge: (projectId: string, name: string, content: string) => Promise<ProjectKnowledge>
  /** Remove a knowledge document by id. */
  removeKnowledge: (id: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Attachments (chat-first redesign)
// ---------------------------------------------------------------------------

/**
 * Payload for storing a new attachment. The renderer reads the browser `File`
 * into a base64 string (bytes don't cross the IPC bridge as a `File`), and the
 * main process writes them to disk under `userData/attachments/<sessionId>/`.
 */
export interface AttachmentAddInput {
  sessionId: string
  /** Original filename; sanitized main-side before it touches the filesystem. */
  name: string
  mime: string
  /** File bytes as base64 (no `data:` prefix). */
  data: string
}

/**
 * Renderer-facing API for attachments. `add` stores bytes + a pending row (no
 * message yet); `attachToMessage` binds pending rows to the user message once the
 * turn is sent; `read` returns a `data:` URL for rendering image thumbnails on
 * reload (kept off the persisted state to avoid bloating it).
 */
export interface AttachmentsApi {
  /** Store a file's bytes on disk + a pending attachment row; returns metadata. */
  add: (input: AttachmentAddInput) => Promise<Attachment>
  /** Bind pending attachments (by id) to the user message they were sent with. */
  attachToMessage: (ids: string[], messageId: string) => Promise<void>
  /** Read an attachment's bytes back as a `data:<mime>;base64,…` URL, or null. */
  read: (id: string) => Promise<string | null>
  /** Delete an attachment (its disk file + row). Used to cancel a pending chip. */
  remove: (id: string) => Promise<void>
}
