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
 * quick-access rows deep-link straight into one of these tabs. Now that Myto is
 * a plain chatbot there are only two panes: the model/provider connection and
 * appearance.
 */
export type SettingsTab = 'appearance' | 'model' | 'tools' | 'connectors' | 'skills' | 'plugins'

/**
 * Reasoning effort the model should spend before answering. Threaded from the
 * composer into the workflow run and turned into a system-prompt directive:
 *  - `low`    → answer directly, minimal deliberation (fast).
 *  - `medium` → the default balance (no extra directive).
 *  - `high`   → reason step by step before answering.
 *  - `max`    → deliberate thoroughly, no skipped steps (slowest).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

/**
 * The voice/verbosity the assistant writes in (#13 output styles), mirroring Claude
 * Code's output styles. Turned into a system-prompt directive (see main/status.ts):
 *  - `default`     → Myto's normal balance (no extra directive).
 *  - `concise`     → short, direct answers; minimal preamble.
 *  - `explanatory` → adds brief "insight" asides explaining the why behind choices.
 *  - `learning`    → collaborative, teaching tone that invites the user to try steps.
 * Persisted globally like {@link ReasoningEffort}; chosen from Settings / the composer.
 */
export type OutputStyle = 'default' | 'concise' | 'explanatory' | 'learning'

/**
 * Which way a chat turn runs:
 *  - `chat`   → the ordinary assistant: answers, may call the read-only web tools.
 *  - `cowork` → the agentic mode (Claude-Cowork style). The model works toward a
 *               goal across a chosen working folder, with filesystem tools on top
 *               of the web/code tools and a larger tool-use budget so it can plan,
 *               read, and write over several steps. See {@link CoworkSettings}.
 * Threaded per-turn from the composer into the streaming request; never persisted
 * on a message (the transcript is mode-agnostic).
 */
export type ChatMode = 'chat' | 'cowork'

/** UI preferences persisted alongside the provider config. */
export interface UiSettings {
  /** Active color theme; applied via `<html data-theme>`. */
  theme: Theme
  /**
   * The Chat/Cowork mode last used, so a brand-new chat opens in the same mode the
   * user was last working in (rather than always resetting to Chat). Seeded into
   * {@link ChatState.coworkMode} when a fresh draft is created. A per-session `mode`
   * (see {@link SessionSummary.mode}) still pins each saved chat to its own mode.
   */
  lastMode: ChatMode
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

/**
 * Cowork (agentic mode) preferences. The one setting that matters is the working
 * folder: every filesystem tool the model can call in Cowork is sandboxed under
 * this directory, and the tools are only advertised at all once it is set. Empty
 * string means "no folder chosen yet" — Cowork then falls back to the same
 * read-only tools Chat has, and the composer nudges the user to pick a folder.
 */
export interface CoworkSettings {
  /** Absolute path of the folder Cowork works in. Empty until the user picks one. */
  workspaceDir: string
  /** How side-effecting tools (writes / code) are permissioned in Cowork. */
  permissionMode: CoworkPermissionMode
  /**
   * A shell command Cowork runs to VERIFY its work before it declares a task done
   * (#16 verify gate) — e.g. `npm test`, `npm run typecheck`, `pytest`. When set,
   * the agentic loop runs it at the natural end of a run: exit 0 → done; a non-zero
   * exit feeds the output back as a turn so the model fixes what it broke, bounded
   * by a small retry cap. Empty string (the default) disables the gate entirely.
   */
  verifyCommand: string
  /**
   * Plan mode (#8): when on, a Cowork run must first produce a plan (via
   * `update_plan`) and STOP for the user's approval before it runs any
   * side-effecting (write/exec) tool. Orthogonal to {@link permissionMode} — a
   * distinct "think before you touch anything" gate, off by default.
   */
  planMode: boolean
  /**
   * User-configured lifecycle hooks (#9): shell commands run around every tool
   * call in Cowork. `preToolUse` runs before a tool (a non-empty stdout blocks the
   * call, feeding that text back to the model); `postToolUse` runs after. Both are
   * an arbitrary-exec surface, so they only run in Cowork and respect the same
   * cancel signal + timeout as `run_command`. Empty/absent = no hook.
   */
  hooks: CoworkHooks
  /**
   * Interactive-terminal consent (#2): the real PTY shell (node-pty + xterm.js) runs
   * commands with NO per-call approval — it bypasses the {@link permissionMode} gate
   * entirely and is scoped only to the working folder's cwd. So the Shell tab stays
   * locked behind this explicit, sticky opt-in: false (the default) shows a consent
   * panel instead of a shell; the user flips it once to accept an unrestricted shell.
   */
  terminalConsent: boolean
}

/** Pre/Post tool-use hook commands (#9). Empty string = that hook is disabled. */
export interface CoworkHooks {
  /** Command run before each tool; non-empty stdout blocks the call with that text. */
  preToolUse: string
  /** Command run after each tool completes; its output is surfaced as a status line. */
  postToolUse: string
}

/**
 * How a connector (MCP server) is reached:
 *  - `stdio` → a local process Myto spawns (command + args), talking over stdin/stdout.
 *              The classic MCP model: `npx @modelcontextprotocol/server-filesystem …`.
 *  - `http`  → a remote server speaking Streamable HTTP at a URL (the modern web transport).
 *  - `sse`   → a remote server speaking the older HTTP+SSE transport at a URL.
 */
export type McpTransport = 'stdio' | 'http' | 'sse'

/**
 * One configured connector — an MCP server that exposes tools Myto can call.
 * Persisted in settings. A `stdio` server spawns `command`/`args` locally with the
 * given `env`; an `http`/`sse` server connects to `url` (optionally with `headers`,
 * e.g. an Authorization bearer). Disabled servers are kept but never connected.
 * Modeled on the `mcpServers` shape Claude Desktop and other MCP hosts use, so a
 * user can paste a known config.
 */
export interface McpServerConfig {
  /** Stable id (generated); used as the key for status + tool namespacing. */
  id: string
  /** Human label shown in the UI and used to namespace this server's tools. */
  name: string
  /** Whether Myto should connect to it. Off = kept in the list, not connected. */
  enabled: boolean
  /** The plugin that installed this server, if any. Absent = the user added it directly. */
  source?: string
  transport: McpTransport
  /** stdio: the executable to run (e.g. 'npx', 'uvx', an absolute path). */
  command?: string
  /** stdio: arguments passed to {@link command}. */
  args?: string[]
  /** stdio: extra environment variables for the spawned process. */
  env?: Record<string, string>
  /** http/sse: the server endpoint URL. */
  url?: string
  /** http/sse: extra request headers (e.g. `{ Authorization: 'Bearer …' }`). */
  headers?: Record<string, string>
}

/** Lifecycle of a connector's connection, surfaced in the Connectors UI. */
export type McpConnectionState = 'connected' | 'connecting' | 'error' | 'disabled'

/** Live status of one connector — what the renderer shows next to each server. */
export interface McpServerStatus {
  id: string
  state: McpConnectionState
  /** Number of tools the server exposed (when connected). */
  toolCount: number
  /** Namespaced names of the tools this server contributes (for display). */
  toolNames: string[]
  /** A short human message when {@link state} is 'error'. */
  error?: string
}

/**
 * A skill — a named, reusable instruction pack the model can pull in on demand.
 * Modeled on Claude's Skills / SKILL.md: the {@link description} is always visible to
 * the model (so it knows the skill exists and when it applies), and the full
 * {@link instructions} are loaded only when it invokes the skill's tool
 * (`skill__<slug>`). That progressive disclosure keeps the base context small while
 * still giving the model deep, task-specific know-how when it's relevant.
 */
export interface SkillConfig {
  /** Stable id (generated); keys the skill in settings. */
  id: string
  /** Short name shown to the model and in the UI (e.g. "PDF forms"). */
  name: string
  /** One line telling the model what this skill is for and when to use it. */
  description: string
  /** The full playbook loaded when the skill is invoked. Markdown/plain text. */
  instructions: string
  /** Whether the skill is offered to the model. Disabled = kept but not advertised. */
  enabled: boolean
  /** The plugin that installed this skill, if any. Absent = the user added it directly. */
  source?: string
}

/**
 * A plugin — a shareable bundle that installs a set of skills and/or connectors in
 * one step (like a Claude Code plugin, minus the marketplace). Installing a plugin
 * expands its {@link PluginManifest} into ordinary skills + connectors tagged with the
 * plugin's id (their `source`), so they show up and work exactly like hand-added ones
 * and can be removed together when the plugin is uninstalled.
 */
export interface PluginConfig {
  /** Stable id (generated); tags every skill/connector this plugin installed. */
  id: string
  /** Display name from the manifest. */
  name: string
  /** One-line summary from the manifest. */
  description: string
  /** Whether the plugin (and all its items) are active. */
  enabled: boolean
}

/**
 * The importable shape a user pastes to install a plugin. Skills and servers here
 * omit ids/enabled/source — those are assigned at install time. Kept intentionally
 * close to the `mcpServers` config shape so a known bundle can be pasted as-is.
 */
export interface PluginManifest {
  name: string
  description?: string
  skills?: Array<Pick<SkillConfig, 'name' | 'description' | 'instructions'>>
  mcpServers?: Array<Omit<McpServerConfig, 'id' | 'enabled' | 'source'>>
}

/** Result of probing one connector config (the "Test" button) without saving it. */
export interface McpTestResult {
  ok: boolean
  /** On success, how many tools the server exposed. */
  toolCount?: number
  /** On success, the (un-namespaced) tool names, for a quick preview. */
  toolNames?: string[]
  /** On failure, a short human reason. */
  error?: string
}

/**
 * How Cowork asks before a tool that changes something runs, mirroring Claude
 * Code's permission modes:
 *  - `ask`         → confirm every side-effecting tool before it runs (default).
 *  - `autoApprove` → file writes/edits run without asking; running code still asks
 *                    (the "accept edits" tier — auto for edits, gated for commands).
 *  - `bypass`      → nothing asks; every tool runs (the "bypass permissions" tier).
 * Read-only tools (list_dir, read_file, the web tools) never ask, in any mode.
 */
export type CoworkPermissionMode = 'ask' | 'autoApprove' | 'bypass'

/** What a tool changes, used to decide whether it needs approval. Absent = read-only. */
export type ToolSideEffect = 'write' | 'exec'

/**
 * Something Myto wants to show in its own preview pane (Cowork). Raised by the
 * `preview` tool and carried on a {@link CompletionChunk} so it rides the same
 * stream as the reply; the renderer opens the side pane on it. A `file` target is
 * a working-folder artifact (an HTML page, a PDF, an image, a chart) already
 * resolved to a `file://` URL; a `url` target is a localhost/remote page (a plan,
 * a running dev server) — both load in the same isolated `partition="preview"`
 * webview guest.
 */
export interface PreviewTarget {
  /** Whether this points at a working-folder file or a web URL — drives the icon/label. */
  kind: 'file' | 'url'
  /** The URL the preview webview loads: a `file://…` URL for files, or the http(s) URL. */
  url: string
  /** A short human label for the pane header (the relative path, or the URL). */
  title: string
}

/** Where a plan step stands. Drives the checklist icon in the plan panel. */
export type TodoStatus = 'pending' | 'in_progress' | 'done'

/**
 * One item in the agent's working plan (Cowork). The model maintains an ordered
 * checklist with the `update_plan` tool as it works a multi-step task; the renderer
 * pins it above the reply so the user can watch the task advance. Transient — a live
 * view of the run, never persisted.
 */
export interface TodoItem {
  /** Short imperative step, e.g. "Scaffold the project" or "Write SignUp.jsx". */
  title: string
  /** pending → in_progress → done. Exactly one item is usually in_progress. */
  status: TodoStatus
}

/** The user's answer to an approval prompt. */
export type ApprovalDecision = 'allow' | 'allow_always' | 'deny'

/**
 * A request, surfaced mid-stream, for the user to approve a side-effecting tool
 * before it runs. Carried on a {@link CompletionChunk} so it rides the same stream
 * as the reply; the renderer shows a prompt and answers with
 * {@link ProvidersApi.decideApproval}. `allow_always` grants that side-effect kind
 * for the rest of the run.
 */
export interface ApprovalRequest {
  /** Correlates the prompt with the decision sent back. */
  approvalId: string
  /** The tool awaiting approval (e.g. 'write_file'). */
  toolName: string
  /** What it will do — drives the prompt's wording. */
  sideEffect: ToolSideEffect
  /** A short human detail, e.g. the target path or 'python code'. May be empty. */
  detail: string
  /**
   * Plan-mode gate (#8): when true this prompt approves the agent's DRAFTED PLAN
   * before any write/exec runs, not a single tool. The renderer shows plan-approval
   * wording (Approve & proceed / Keep planning) and `sideEffect`/`toolName` are only
   * placeholders. Absent for ordinary per-tool approvals.
   */
  plan?: boolean
}

/**
 * One question Myto asks the user mid-turn via the `ask_user` tool. The model writes
 * these itself when it needs a decision it can't resolve on its own; the renderer shows
 * a card and the answers flow back so the loop continues. `options` (when present) render
 * as quick-pick buttons; the user can always type a free-text answer instead.
 */
export interface AskQuestion {
  /** The question text. */
  question: string
  /** A short chip/label for the question group (optional, e.g. "Framework"). */
  header?: string
  /** Suggested answers rendered as buttons; free text is always allowed too. */
  options?: string[]
}

/**
 * A batch of questions surfaced mid-stream (the `ask_user` tool). Carried on a
 * {@link CompletionChunk}; the renderer shows a card, the main-process loop blocks until
 * the user answers via {@link ProvidersApi.answerQuestions}. Myto can ask several at once.
 */
export interface QuestionRequest {
  /** Correlates the prompt with the answers sent back. */
  questionId: string
  /** The questions to ask (one or more). */
  questions: AskQuestion[]
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
  /** Cowork (agentic mode) preferences — chiefly the working folder. */
  cowork: CoworkSettings
  /** Configured connectors (MCP servers) whose tools Myto can call. */
  mcpServers: McpServerConfig[]
  /** Skills — reusable instruction packs the model can pull in on demand. */
  skills: SkillConfig[]
  /** Installed plugins — bundles that expand into the skills/connectors above. */
  plugins: PluginConfig[]
  /**
   * How hard the model should think before answering — sent to the provider as
   * `reasoning_effort` (a capable gateway maps it to the model's extended-thinking
   * budget; others ignore it). Chosen from the composer's effort control.
   */
  reasoningEffort: ReasoningEffort
  /**
   * The assistant's writing voice (#13). Applied as a system-prompt directive on
   * every turn (chat + cowork). Persisted globally; `default` adds no directive.
   */
  outputStyle: OutputStyle
  /**
   * Use native provider function-calling (#15) instead of the ```myto:tool text
   * protocol, when the active provider/model supports it (an OpenAI- or
   * Anthropic-shaped gateway). Opt-in and OFF by default: with it off, Myto uses
   * the text protocol exactly as before, so existing chats and persistence are
   * untouched. When on and unsupported by the backend, the loop falls back to the
   * text protocol automatically.
   */
  nativeTools: boolean
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

/**
 * A completed NATIVE (provider) tool call assembled from a streaming response (#15).
 * The gateway's per-stream parser accumulates the provider's tool-call fragments —
 * OpenAI `delta.tool_calls[].function.arguments`, Anthropic `input_json_delta` —
 * into one of these and forwards it on a {@link CompletionChunk.toolCall}. The reply
 * loop turns it into the SAME canonical ```myto:tool block a text-protocol call
 * produces, so the assistant turn, its card, and DB persistence are identical
 * whichever path ran. Internal to the main process — never crosses IPC.
 */
export interface NativeToolCall {
  /** Provider id for the call (OpenAI `tool_calls[].id`, Anthropic tool_use block id). Best-effort; may be ''. */
  id: string
  /** The tool name the model chose (matches a {@link NativeToolSchema.name}). */
  name: string
  /** Raw JSON string of the call's arguments; the loop parses it into the call's `input`. */
  argsJson: string
}

/**
 * One tool advertised to a native-function-calling backend (#15). Built from the
 * tool registry (`toolSchemas`); the wire adapter injects it into the request body
 * in the provider's own shape (OpenAI `tools[].function`, Anthropic
 * `tools[].input_schema`). Sent only when native tools are on AND the backend
 * supports them; otherwise the ```myto:tool text protocol carries the catalogue.
 */
export interface NativeToolSchema {
  /** Unique tool name (matches {@link ToolDef.name}). */
  name: string
  /** One-line description shown to the model (the text prompt's line, incl. the usage hint). */
  description: string
  /** JSON-Schema object describing the tool's `input`. */
  parameters: Record<string, unknown>
}

/** Input to a (non-streaming or streaming) completion call. */
export interface CompletionRequest {
  /** Provider to use; defaults to the active provider when omitted. */
  provider?: ProviderKind
  /** Model id; defaults to the configured `modelId` when omitted. */
  modelId?: string
  messages: ChatMessage[]
  /**
   * How this turn runs — `chat` (default) or `cowork`. In `cowork` the main
   * process advertises the filesystem tools, prepends the agentic system prompt,
   * and raises the tool-use budget. Omitted is treated as `chat` so every existing
   * caller keeps its exact behaviour.
   */
  mode?: ChatMode
  /**
   * The session this turn belongs to, and the id of the user message it answers.
   * Optional and Cowork-only in practice: they key the file_snapshots the mutation
   * tools capture (#1 checkpoints/rewind) so a later "restore to here" can replay
   * them. Omitted by every non-Cowork caller, in which case no snapshots are keyed.
   */
  sessionId?: string
  afterMsgId?: string
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
  /**
   * A pending approval request for a side-effecting Cowork tool. Present only on
   * the chunk that raises the prompt (empty `delta`); the renderer shows a card and
   * replies via {@link ProvidersApi.decideApproval}, while the main-process loop is
   * blocked awaiting that decision. Absent on ordinary chunks.
   */
  approval?: ApprovalRequest
  /**
   * A batch of clarifying questions Myto asked (the `ask_user` tool). Present only on
   * the chunk that raises them (empty `delta`); the renderer shows a card and replies via
   * {@link ProvidersApi.answerQuestions}, while the main-process loop blocks awaiting the
   * answers. Absent on ordinary chunks.
   */
  question?: QuestionRequest
  /**
   * Something Myto wants to show in its preview pane (Cowork), raised by the
   * `preview` tool. Present only on the chunk that opens it (empty `delta`); the
   * renderer opens/points the side pane at it. Unlike {@link approval} this never
   * blocks the loop — Myto keeps working while the pane updates. Absent otherwise.
   */
  preview?: PreviewTarget
  /**
   * The agent's current working plan (Cowork), raised by the `update_plan` tool.
   * Present only on the chunk that updates it (empty `delta`); the renderer pins a
   * checklist above the reply. Non-blocking like {@link preview}. Absent otherwise.
   */
  todos?: TodoItem[]
  /**
   * A shell command Myto just ran and its output (Cowork), raised by the
   * `run_command` tool. Present only on the chunk that reports it (empty `delta`);
   * the renderer appends it to the Terminal pane. Non-blocking like {@link preview}.
   * Absent otherwise.
   */
  command?: CommandRun
  /**
   * Raw chain-of-thought accumulated so far for the CURRENT thinking phase (Cowork
   * and chat with a reasoning model). Unlike {@link reasoning} — the per-delta scrap
   * that only becomes a status caption — this is the full snapshot the renderer shows
   * in a live, collapsible "Thinking" block (blinking while active, with a token
   * count). Carried out-of-band on its own chunk (empty `delta`); each snapshot
   * REPLACES the phase's text. Absent on ordinary text chunks and on non-reasoning
   * models (which never think out loud — we never fabricate it).
   */
  thinking?: string
  /**
   * Closes the current thinking phase (its block stops blinking and is considered
   * final). Emitted when visible reply text begins, at the natural end of a turn,
   * and on early return / abort so a tool-only turn still ends its phase. A fresh
   * {@link thinking} snapshot after a reset opens a NEW phase — which is how one run
   * shows several interleaved thinking blocks. Absent otherwise.
   */
  thinkingReset?: boolean
  /**
   * A completed NATIVE (provider) tool call assembled from the stream (#15). Present
   * only on the chunk that completes it (empty `delta`), and only when the turn opted
   * into native function-calling. The main-process reply loop turns it into the same
   * canonical ```myto:tool block a text call produces and never forwards it onward —
   * so, unlike the fields above, it stays inside main. Absent on every text-protocol
   * turn (native tools off or unsupported by the backend).
   */
  toolCall?: NativeToolCall
}

/**
 * One shell command Cowork ran, plus the output it produced — streamed to the
 * renderer's Terminal pane so the user can watch builds/tests/installs run. The
 * `output` is already size-capped upstream (see main/tools/runCode.ts OUTPUT_CAP).
 */
export interface CommandRun {
  /**
   * A stable id for this run, so the Terminal pane can UPSERT it: a long-lived
   * process (a dev server) streams several updates under one id and they replace the
   * same row in place rather than piling up. Absent for legacy/one-shot appends,
   * which are always appended.
   */
  id?: string
  /** The command line as the model issued it (e.g. "npm test"). */
  command: string
  /** Combined stdout/stderr the command produced (or the spawn error, if it failed to start). */
  output: string
  /** Process exit code when the runner reported one; null on a spawn failure / timeout. */
  exitCode?: number | null
  /** The working folder the command ran in, shown in the Terminal pane header. */
  cwd?: string
}

/** What kind of mutation a {@link FileSnapshot} captured. */
export type FileSnapshotKind = 'write' | 'edit' | 'delete'

/**
 * A before/after capture of one file a Cowork mutation tool touched (#1 checkpoints
 * / rewind). Emitted by the write/edit/delete tools via `ctx.onFileSnapshot` and
 * persisted to the `file_snapshots` table, keyed by session + the user message the
 * run answers + the run id. Rewind replays these in reverse to restore an earlier
 * state; the diff viewer (#5) reads `before`/`after` to render a real diff.
 */
export interface FileSnapshot {
  /** Absolute path of the file that was written/edited/deleted. */
  path: string
  /** The file's bytes BEFORE the change; null when the file did not exist. */
  before: string | null
  /** The file's bytes AFTER the change; null for a delete. */
  after: string | null
  /** Which mutation produced this snapshot. */
  kind: FileSnapshotKind
  /** Whether the file existed before the change (drives rewind's "delete vs restore"). */
  existed: boolean
}

/** A persisted {@link FileSnapshot} row (adds the persistence keys + id). */
export interface PersistedFileSnapshot extends FileSnapshot {
  id: number
  sessionId: string
  /** The user message the run answered (null for snapshots written before a first message). */
  afterMsgId: string | null
  runId: string
  createdAt: number
}

/**
 * Outcome of a rewind (#1 checkpoints / "restore to here"): a summary of what the
 * reverse replay changed, or — with `ok: false` — why it was a no-op (e.g. the
 * target message id was unknown). Purely informational; the renderer surfaces it
 * as a short toast after the confirm.
 */
export interface RewindResult {
  ok: boolean
  /** Files whose pre-change bytes were written back. */
  filesRestored: number
  /** Files removed because they did not exist at the restore point. */
  filesDeleted: number
  /** Chat turns discarded (everything after the target message). */
  messagesRemoved: number
  /** Present only when `ok` is false — why nothing was done. */
  reason?: string
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
  /**
   * Native function-calling tool schemas to advertise this turn (#15). Set only on
   * the Cowork reply loop's request when native tools are on AND the backend
   * supports them; the wire adapter injects them in the provider's own shape
   * (OpenAI `tools[].function`, Anthropic `tools[].input_schema`). Unset on every
   * other call, so the text-protocol path is completely unaffected.
   */
  tools?: NativeToolSchema[]
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
  /**
   * Answer an {@link ApprovalRequest} raised mid-stream (Cowork side-effect tools).
   * Fire-and-forget: the main-process loop is blocked awaiting this and resumes
   * (runs or refuses the tool) as soon as the decision arrives.
   */
  decideApproval: (approvalId: string, decision: ApprovalDecision) => void
  /**
   * Answer a {@link QuestionRequest} Myto raised mid-stream (the `ask_user` tool).
   * `answers` align with the request's `questions` by index. Fire-and-forget: the
   * blocked loop resumes with the answers as soon as they arrive.
   */
  answerQuestions: (questionId: string, answers: string[]) => void
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
  /**
   * The chat mode this session is fixed to (Chat vs Cowork). Set once when the row
   * is created (from the composer's toggle) and never changed — a session never
   * mixes Chat and Cowork turns. Opening a session restores this mode; the sidebar
   * tags each row with it. Defaults to `'chat'` for rows created before this column.
   */
  mode: ChatMode
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
  /**
   * Create a fresh session (optionally filed under a project) and return it. The
   * `mode` fixes the new chat to Chat or Cowork (defaults to `'chat'`); it's taken
   * from the composer's toggle on the lazy first-send.
   */
  create: (projectId?: string | null, mode?: ChatMode) => Promise<SessionSummary>
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
  /**
   * Rewind (#1 checkpoints) the session to just after `afterMsgId`: replay the
   * Cowork file snapshots recorded on or after that turn in reverse (restoring each
   * file's pre-change bytes, or deleting files that didn't exist), then discard the
   * chat turns that followed. Returns a summary of what changed. Destructive — the
   * renderer confirms first.
   */
  rewind: (sessionId: string, afterMsgId: string) => Promise<RewindResult>
  /**
   * The pre-change bytes for a file card's overwrite diff (#5): given the exact
   * *after* content a Cowork write card is showing, return the previous content of
   * the same write from `file_snapshots` (content-addressed, so a card's relative
   * path needn't match the snapshot's absolute one). `null` when it was a fresh
   * create or no snapshot exists — the card then shows an all-additions view.
   */
  snapshotBefore: (sessionId: string, after: string) => Promise<string | null>
}

/** Result of a browser-mediated sign-in: the relayed Google ID token, or why it failed. */
export type AuthHandoffResult =
  | { ok: true; idToken: string }
  | { ok: false; error: string }

/**
 * Browser-mediated Google sign-in. Google blocks its OAuth screen inside embedded
 * webviews, so the app opens the system browser to mytocode.vercel.app/authentication,
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

/**
 * Cowork (agentic mode) surface. Today it is just the working-folder picker: the
 * renderer asks the main process to open a native "choose folder" dialog and gets
 * back the absolute path the user picked (or null when they cancel). The path is
 * then persisted into {@link CoworkSettings.workspaceDir} through the ordinary
 * settings save, which is what actually scopes the filesystem tools.
 */
export interface CoworkApi {
  /** Open a native folder picker; resolves the chosen absolute path, or null if cancelled. */
  pickWorkspace: () => Promise<string | null>
  /**
   * List workspace-relative paths matching an `@file` mention query (case-insensitive
   * substring, basename hits ranked first). Resolves an empty array when no working
   * folder is set, so the composer popover simply shows nothing off-sandbox.
   */
  listFiles: (query: string) => Promise<string[]>
}

/**
 * Myto's preview pane (Cowork). The pane itself is renderer-only — an isolated
 * `<webview>` the {@link PreviewTarget} stream drives — so this surface is just the
 * one thing the renderer can't do in-process: hand a URL to the OS to open in the
 * user's real browser (the pane's "open externally" control).
 */
export interface PreviewApi {
  /** Open a preview URL (file:// or http(s)) in the user's default external browser. */
  openExternal: (url: string) => void
}

/**
 * Connectors (MCP servers). The server list itself lives in ordinary settings
 * (`mcpServers`), edited through the normal settings save; this surface is the live
 * side — connecting, probing, and watching status. The renderer saves a config, then
 * calls {@link sync} to (re)connect; {@link test} probes a config before saving it.
 */
export interface McpApi {
  /** Current live status of every configured connector. */
  status: () => Promise<McpServerStatus[]>
  /** (Re)connect to all enabled connectors from the saved settings; resolves the new statuses. */
  sync: () => Promise<McpServerStatus[]>
  /** Probe one connector config without saving it — resolves ok + tool count, or an error. */
  test: (config: McpServerConfig) => Promise<McpTestResult>
  /** Subscribe to status changes (a connect/disconnect settled). Returns an unsubscribe fn. */
  onStatusChanged: (callback: (statuses: McpServerStatus[]) => void) => () => void
}

/** Base64 audio handed to the main process for speech-to-text transcription. */
export interface VoiceTranscribeInput {
  /** The recorded clip's bytes, base64-encoded (no data: prefix). */
  data: string
  /** The clip's MIME type (e.g. 'audio/webm'), used to name the upload part. */
  mime: string
}

/** Result of a Whisper transcription attempt against the configured gateway. */
export interface VoiceTranscribeResult {
  ok: boolean
  /** The recognised text, on success. */
  text?: string
  /**
   * On failure, a short reason. The sentinel 'no-gateway' means no OpenAI-compatible
   * gateway is configured, so the renderer should fall back to the Web Speech API.
   */
  error?: string
}

/**
 * Speech-to-text via the configured gateway's Whisper (`/audio/transcriptions`)
 * endpoint. The renderer records a clip, sends it here, and — on any failure,
 * including no gateway being configured — falls back to the browser's Web Speech API.
 */
export interface VoiceApi {
  transcribe: (input: VoiceTranscribeInput) => Promise<VoiceTranscribeResult>
}

/** A captured screenshot, ready to be turned into a File and staged as an attachment. */
export interface ScreenshotResult {
  /** Base64-encoded PNG bytes (no data-URL prefix). */
  data: string
  /** Always `image/png`. */
  mime: string
  /** A suggested filename (e.g. `screenshot-2026-09-24-1712.png`). */
  name: string
}

/**
 * Screenshot capture (#11). Grabs the primary display's full-resolution image so the
 * user can attach what's on screen without leaving the app. Main-process only (uses
 * Electron's `desktopCapturer`); resolves `null` when capture is unavailable or denied
 * (e.g. macOS screen-recording permission not granted). This reads the whole screen —
 * an explicit, user-initiated action behind a button, never automatic.
 */
export interface ScreenshotApi {
  capture: () => Promise<ScreenshotResult | null>
}

// ---------------------------------------------------------------------------
// Scheduled tasks (#12)
// ---------------------------------------------------------------------------

/**
 * A durable scheduled task: a stored prompt the scheduler enqueues on a cron
 * cadence, opening a fresh chat each time it fires (bound to no session). Persisted
 * in the `scheduled_tasks` table (v7). `cron` is a standard 5-field expression
 * (`min hour dom month dow`) evaluated in local time; `nextRunAt` is recomputed
 * from it whenever the task is created, edited, or fires.
 */
export interface ScheduledTask {
  id: string
  /** Human label shown in the task list (defaults to a slice of the prompt). */
  name: string
  /** The prompt submitted to a fresh run when the task fires. */
  prompt: string
  /** Standard 5-field cron (`min hour dom month dow`), local time. */
  cron: string
  /** Whether the scheduler considers this task for firing. */
  enabled: boolean
  /** Chat vs Cowork the fired run opens in. */
  mode: ChatMode
  /** Epoch ms the task was created. */
  createdAt: number
  /** Epoch ms the task was last edited. */
  updatedAt: number
  /** Epoch ms the task last fired, or null if it never has. */
  lastRunAt: number | null
  /** Epoch ms the task is next due, or null when disabled / uncomputable. */
  nextRunAt: number | null
}

/** The editable fields when creating or updating a {@link ScheduledTask}. */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  cron: string
  enabled: boolean
  mode: ChatMode
}

/**
 * A task-fire event pushed main → renderer when a scheduled task comes due (or the
 * user hits "Run now"). The renderer opens a fresh session in `mode` and submits
 * `prompt`. Carries only what the run needs — never the whole task row.
 */
export interface ScheduledTaskFire {
  taskId: string
  name: string
  prompt: string
  mode: ChatMode
}

/**
 * Scheduled tasks (#12): CRUD over the durable task list plus a fire subscription.
 * The renderer edits tasks through {@link create}/{@link update}/{@link remove};
 * the main-process scheduler computes each task's `nextRunAt` and, when due, pushes
 * a {@link ScheduledTaskFire} the renderer turns into a fresh run. {@link runNow}
 * fires a task immediately without waiting for its schedule.
 */
export interface ScheduledTasksApi {
  /** List every persisted task, most-recently-updated first. */
  list: () => Promise<ScheduledTask[]>
  /** Create a task; its `nextRunAt` is computed from the cron. */
  create: (input: ScheduledTaskInput) => Promise<ScheduledTask>
  /** Patch a task's editable fields; recomputes `nextRunAt`. Resolves null if unknown. */
  update: (id: string, input: Partial<ScheduledTaskInput>) => Promise<ScheduledTask | null>
  /** Delete a task by id. */
  remove: (id: string) => Promise<void>
  /** Fire a task now (the "Run now" control); resolves once the fire is dispatched. */
  runNow: (id: string) => Promise<void>
  /** Subscribe to task fires (main → renderer). Returns an unsubscribe fn. */
  onFire: (callback: (fire: ScheduledTaskFire) => void) => () => void
}

/** The outcome of spawning (or re-attaching to) a session's interactive PTY (#2). */
export interface TerminalSpawnResult {
  /** True when a live PTY is available (spawned now or already running). */
  ok: boolean
  /**
   * The rolling output buffer to replay into a freshly-mounted xterm so scrollback
   * survives a frontend remount. Empty for a brand-new PTY; the accumulated bytes
   * when re-attaching to one that was already running.
   */
  buffer: string
  /** Why the spawn failed (e.g. node-pty unavailable), when `ok` is false. */
  error?: string
}

/** One chunk of PTY output pushed from main to the renderer (#2). */
export interface TerminalDataEvent {
  /** The session whose PTY produced this output. */
  sessionId: string
  /** The raw bytes (already decoded to a string) to feed into xterm. */
  data: string
}

/** A session's PTY exiting, pushed from main to the renderer (#2). */
export interface TerminalExitEvent {
  /** The session whose PTY exited. */
  sessionId: string
  /** The process exit code (0 = clean). */
  exitCode: number
}

/**
 * Interactive terminal (#2): a real PTY per session (node-pty), driven by an
 * xterm.js frontend. The PTY lives in the main process keyed by sessionId and
 * survives frontend remounts — {@link spawn} either starts one or re-attaches to a
 * running one, returning the rolling buffer to replay. Keystrokes go through
 * {@link write}; {@link resize} keeps the PTY's dimensions in step with the visible
 * grid; {@link kill} ends it (explicit restart / cleanup). Output and exit arrive
 * over the {@link onData}/{@link onExit} subscriptions.
 *
 * Unlike the per-call tool approval model, this shell runs commands unrestricted
 * (cwd-scoped only), so the frontend gates it behind {@link CoworkSettings.terminalConsent}.
 */
export interface TerminalApi {
  /** Spawn or re-attach the session's PTY at `cwd`, sized `cols`×`rows`; resolves the replay buffer. */
  spawn: (sessionId: string, cwd: string, cols: number, rows: number) => Promise<TerminalSpawnResult>
  /** Write keystrokes / pasted text to the session's PTY. */
  write: (sessionId: string, data: string) => void
  /** Resize the session's PTY to `cols`×`rows` (follows the xterm fit addon). */
  resize: (sessionId: string, cols: number, rows: number) => void
  /** Kill the session's PTY (explicit user action — restart / cleanup). */
  kill: (sessionId: string) => void
  /** Subscribe to PTY output (main → renderer). Returns an unsubscribe fn. */
  onData: (callback: (event: TerminalDataEvent) => void) => () => void
  /** Subscribe to PTY exits (main → renderer). Returns an unsubscribe fn. */
  onExit: (callback: (event: TerminalExitEvent) => void) => () => void
}

/** The full `window.myto` API surface exposed by the preload script. */
export interface MytoApi {
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
  /** Cowork (agentic mode): the working-folder picker. */
  cowork: CoworkApi
  /** Myto's preview pane: open a preview target in the user's external browser. */
  preview: PreviewApi
  /** Connectors (MCP servers): live status, (re)connect, and probe. */
  mcp: McpApi
  /** Voice: speech-to-text via the gateway's Whisper endpoint (Web Speech fallback in the renderer). */
  voice: VoiceApi
  /** Screenshot capture (#11): grab the primary display to attach to a message. */
  screenshot: ScreenshotApi
  /** Scheduled tasks (#12): CRUD over durable tasks + the fire subscription. */
  scheduledTasks: ScheduledTasksApi
  /** Interactive terminal (#2): a real PTY per session (spawn/write/resize/kill + data/exit). */
  terminal: TerminalApi
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
   * into every chat filed here and that Myto appends to via the `remember`
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
