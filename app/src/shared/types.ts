/** Whether the active model provider runs locally (Ollama) or via a remote gateway. */
export type EnvStatus = 'local' | 'remote'

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
 * A pane in the Settings surface. Settings has no visible top-level entry point
 * anymore (the gear was removed from the UI); instead the model selector's
 * quick-access rows deep-link straight into one of these tabs. Now that Sylor is
 * a plain chatbot there are only two panes: the model/provider connection and
 * appearance.
 */
export type SettingsTab = 'appearance' | 'model'

/**
 * Reasoning effort the model should spend before answering. Threaded from the
 * composer into the workflow run and turned into a system-prompt directive:
 *  - `low`    → answer directly, minimal deliberation (fast).
 *  - `medium` → the default balance (no extra directive).
 *  - `high`   → reason step by step before answering.
 *  - `max`    → deliberate thoroughly, no skipped steps (slowest).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

/** UI preferences persisted alongside the provider config. */
export interface UiSettings {
  /** Active color theme; applied via `<html data-theme>`. */
  theme: Theme
}

/**
 * Tool-use preferences. When {@link enabled} is on, the model may call the
 * read-only web tools (fetch / search / wiki) via the text protocol the main
 * process parses out of the stream (see main/tools). {@link codeExecution} is a
 * separate, explicit opt-in for the `run_code` tool, which runs code on this
 * machine with the user's privileges — off by default and never advertised to
 * the model while off.
 */
export interface ToolSettings {
  /** Master switch for the read-only web tools (default on). */
  enabled: boolean
  /** Allow the `run_code` tool to execute code locally (default off). */
  codeExecution: boolean
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
  /** Tool-use preferences (web tools + code execution). */
  tools: ToolSettings
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
  /**
   * Optional image attachments for a vision-capable model. Absent for the
   * text-only common case; when present, the provider layer expands the message
   * into its native multimodal shape (OpenAI `image_url` parts for the gateway,
   * a base64 `images` array for Ollama). Transient — never persisted — so an
   * image is seen only within the run that read it. `content` still carries a
   * text caption, so a model that can't see images degrades cleanly.
   */
  images?: ChatImage[]
}

/** One image attached to a {@link ChatMessage} (raw base64, no data: prefix). */
export interface ChatImage {
  /** MIME type, e.g. 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'. */
  mediaType: string
  /** The image bytes, base64-encoded (no `data:...;base64,` prefix). */
  dataBase64: string
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
  /**
   * A live status caption the model emitted for the UI status line — a short
   * present-tense phrase like "Reading the question". Carried out-of-band on its
   * own chunk (with an empty `delta`) and never part of the reply: the main
   * process parses these out of the raw stream and strips the `<status>` tags
   * from `delta` before it crosses IPC (see main/status.ts). Absent on ordinary
   * text chunks.
   */
  status?: string
  /**
   * Raw chain-of-thought a reasoning model streams before its visible reply
   * (OpenRouter/OpenAI `delta.reasoning`). Carried out-of-band on its own chunk
   * (empty `delta`); the main process turns it into a live status caption and it
   * is NEVER part of the reply. Absent on ordinary text chunks and never forwarded
   * to the renderer (it is converted to `status` at the funnel — see status.ts).
   */
  reasoning?: string
}

/**
 * Optional sampling/thinking hints for a completion. Every field is best-effort:
 * a provider forwards what its wire format supports and silently drops the rest,
 * so passing these can only improve a capable backend and never breaks a plain
 * one. `reasoningEffort` maps to the OpenAI-compatible `reasoning_effort` (which
 * many gateways translate into a model's extended-thinking budget); `temperature`
 * is standard sampling. They are kept apart on the wire when a backend would
 * reject both together (e.g. Anthropic thinking requires the default temperature).
 */
export interface CompletionOptions {
  /** How hard the model should think before answering (gateway-mapped). */
  reasoningEffort?: ReasoningEffort
  /** Sampling temperature; lower is more precise/deterministic. */
  temperature?: number
  /**
   * Upper bound on output tokens. Left unset for normal turns (the backend uses
   * its own default); set only for the `max` "no compromise" tier so a large file
   * or whole scaffold isn't truncated by a gateway's conservative default cap.
   * Best-effort: forwarded as `max_tokens` (gateway) / `num_predict` (Ollama).
   */
  maxTokens?: number
}

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
  /**
   * Display label of the model that produced this turn (assistant rows only),
   * stamped by the main process from the active provider settings at append time.
   * Absent on user turns and on rows written before the stat columns existed —
   * the activity dashboard simply leaves those out of its model tally.
   */
  model?: string
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

/** A fully-loaded session: metadata + ordered messages + attachments. */
export interface PersistedSession {
  session: SessionSummary
  messages: PersistedMessage[]
  /** Attachments tied to sent messages, oldest first (chat-first redesign). */
  attachments: Attachment[]
}

/**
 * Renderer-facing API for session persistence. Query-style ops are
 * promise-returning (invoke/handle); high-frequency appends are fire-and-forget
 * (send/on) so the live chat never blocks on a DB round-trip.
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
   * Reset an assistant message for a Rewrite/regenerate (fire-and-forget): blanks
   * its content/feedback so a reload shows only the regenerated result. Local-only.
   */
  resetMessage: (sessionId: string, id: string) => void
}

/** Result of a browser-mediated sign-in: the relayed Google ID token, or why it failed. */
export type AuthHandoffResult =
  | { ok: true; idToken: string }
  | { ok: false; error: string }

/**
 * Browser-mediated Google sign-in. Google blocks its OAuth screen inside embedded
 * webviews, so the app opens the system browser to sylorcode.vercel.app/authentication,
 * receives the Google ID token back on a loopback listener, and the renderer completes
 * Firebase sign-in with signInWithCredential. No server secret is involved.
 */
export interface AuthApi {
  signInWithGoogle: () => Promise<AuthHandoffResult>
}

/** Result of saving a generated file via the native Save As dialog. */
export type FileSaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

/**
 * Saving a generated file card to disk. The renderer hands over a suggested
 * filename and the file's text; main shows a native Save As dialog and writes the
 * chosen path. Nothing is written without the user picking a location.
 */
export interface FilesApi {
  save: (name: string, content: string) => Promise<FileSaveResult>
}

/** The full `window.sylor` API surface exposed by the preload script. */
export interface SylorApi {
  window: WindowApi
  /** Host platform string (e.g. 'win32', 'darwin', 'linux'). */
  platform: Platform
  /**
   * The OS account display name (from `USERNAME`/`USER`), used only to greet the
   * user on the zero-state dashboard. Empty string when unavailable. Never sent
   * anywhere — read-only, renderer-facing convenience like {@link platform}.
   */
  userName: string
  /** Model provider configuration, listing, and completions. */
  providers: ProvidersApi
  /** Session persistence: history, reopen/rename/delete. */
  sessions: SessionsApi
  /** Projects: group chats with per-project instructions + knowledge. */
  projects: ProjectsApi
  /** Attachments: files dropped into the composer. */
  attachments: AttachmentsApi
  /** Browser-mediated Google sign-in (opens the system browser to the website). */
  auth: AuthApi
  /** Save a generated file card to disk (native Save As). */
  files: FilesApi
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
