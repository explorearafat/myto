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
 * A pane in the Settings surface. Settings has no visible top-level entry point
 * anymore (the gear was removed from the UI); instead the sidebar's quick-access
 * rows deep-link straight into one of these tabs, so the underlying settings
 * infrastructure stays fully intact while the generic "Settings" label is gone.
 */
export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'model'
  | 'connectors'
  | 'skills'
  | 'commands'
  | 'plugins'
  | 'browsing'

/**
 * A class of browser action that the permission system gates. The defaults
 * deliberately escalate with blast radius: reading a page is cheap and
 * reversible; sending a message, deleting data, or making a payment are not.
 *
 * These are the *risk classes*, not the tool's actions — a single `browse`
 * `click` maps onto `click`, `send`, `delete` or `payment` depending on what the
 * element looks like (see `classifyClick` in `main/browser/actions.ts`).
 */
export type BrowserAction =
  | 'read' // read/observe page content (DOM / a11y / vision)
  | 'navigate' // follow links, go to URLs, switch tabs
  | 'click' // click non-destructive elements
  | 'fill' // type into inputs / fill forms (not submit)
  | 'send' // submit a form / post / send a message
  | 'delete' // delete data
  | 'payment' // any purchase / payment / checkout

/**
 * How a {@link BrowserAction} is authorised when Sylor (not the user) initiates
 * it. `allow` runs it silently, `ask` surfaces an approval prompt first, `block`
 * refuses outright. Sensitive actions default to `ask`/`block` and payment can
 * never be silently allowed — see DEFAULT_BROWSER_PERMISSIONS.
 */
export type BrowserPermission = 'allow' | 'ask' | 'block'

/** The AI-control permission policy for browsing, one setting per action class. */
export type BrowserPermissions = Record<BrowserAction, BrowserPermission>

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

// ---------------------------------------------------------------------------
// Automation hooks (Phase 4) — user shell commands fired around the agent loop
// ---------------------------------------------------------------------------

/**
 * The four lifecycle points a hook can attach to (mirrors Claude Code):
 * - `PreToolUse`      — before a tool is dispatched; a non-zero exit BLOCKS it.
 * - `PostToolUse`     — after a tool ran (cannot block; react, e.g. run a formatter).
 * - `UserPromptSubmit`— once when a run starts, with the prompt in the env.
 * - `Stop`            — once when a run finishes (not on user-cancel).
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'UserPromptSubmit'

/**
 * One hook: a shell `command` optionally scoped by `matcher` to certain tools.
 * `matcher` is a regular expression tested against the tool name (`write_file`,
 * `edit_file`, `run_command`, `read_file`, `web_fetch`, …); an empty/absent
 * matcher — or `*` — matches every tool. It is ignored for `Stop` /
 * `UserPromptSubmit` (no tool is in play). The command runs in the workspace
 * root with `SYLOR_*` context env vars set, bounded by `timeoutMs` — a timeout
 * counts as a block for `PreToolUse` (fail-closed).
 */
export interface HookDefinition {
  /** Regex tested against the tool name; empty/absent or `*` matches all tools. */
  matcher?: string
  /** The shell command to run. */
  command: string
  /** Max run time in ms before the hook is killed (engine applies a default). */
  timeoutMs?: number
}

/** All configured hooks, grouped by the event they fire on. */
export type HooksConfig = Partial<Record<HookEvent, HookDefinition[]>>

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
  /**
   * Automation hooks: user shell commands fired around the agent loop
   * (Phase 4). Absent/empty by default. Edited only in the Settings modal — so
   * unlike skills/MCP overrides it safely rides inside ProviderSettings rather
   * than a separate file (no mid-run mutation to clobber).
   */
  hooks?: HooksConfig
  /**
   * Per-action policy for the `browse` tool (what Sylor may do to a real web
   * page on its own). Absent means {@link DEFAULT_BROWSER_PERMISSIONS}. Lives
   * here rather than in the renderer store because the engine runs in main and
   * has to enforce it; like `hooks` it is only edited in the Settings modal, so
   * there is no mid-run mutation to clobber.
   */
  browser?: BrowserPermissions
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

/**
 * The kinds of operations the engine can propose. The first three are
 * side-effecting and permission-gated; `read` only inspects the project (see
 * {@link ReadProposal}) and is always auto-approved.
 */
export type ToolKind =
  | 'write_file'
  | 'run_command'
  | 'mcp_call'
  | 'web_fetch'
  | 'web_search'
  | 'install_plugin'
  | 'read'
  | 'preview_inspect'
  | 'browse'
  | 'diagnostics'

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

/**
 * A proposed fetch of a web page — Sylor's opt-in exception to offline-first
 * (the analogue of Claude Code's WebFetch). Permission-gated like run_command:
 * it reaches the network, so it is never auto-approved outside the explicit
 * hands-free `autonomous` mode, and a scoped subagent needs the `web` capability.
 */
export interface WebFetchProposal {
  id: string
  kind: 'web_fetch'
  /** The http/https URL to fetch (validated; internal hosts refused). */
  url: string
}

/**
 * A proposed web search — the discovery sibling of {@link WebFetchProposal}
 * (Sylor's analogue of Claude Code's WebSearch). Turns a natural-language query
 * into a ranked list of results the agent can then fetch. Permission-gated
 * exactly like web_fetch (network egress): never auto-approved outside hands-free
 * `autonomous`, and a scoped subagent needs the `web` capability.
 */
export interface WebSearchProposal {
  id: string
  kind: 'web_search'
  /** The natural-language search query. */
  query: string
}

/**
 * A proposed plugin install from a git repo or local folder — the action behind
 * "Sylor, install this skill <url>". Permission-gated like web_fetch: a git
 * source reaches the network (clone) and every source writes skills/commands/
 * connectors into `~/.sylor` or the project, so it is never auto-approved outside
 * hands-free `autonomous`. It ENDS the model's message like any other action.
 */
export interface InstallPluginProposal {
  id: string
  kind: 'install_plugin'
  /** The raw source the user gave: `owner/repo`, a git URL, or a local folder. */
  source: string
  /** Where the discovered skills/commands/connectors are written. */
  scope: ConfigScope
}

/**
 * Which project inspection a {@link ReadProposal} performs. Four ops share one
 * proposal kind because they share a shape (a target + bounded text back), which
 * keeps every switch in the pipeline to a single `read` branch. `find_files`
 * lists files by name/path glob (the counterpart of `search_files`, which greps
 * their contents).
 */
export type ReadOp = 'read_file' | 'list_files' | 'search_files' | 'find_files'

/**
 * A request to LOOK at the project — open a file, list a directory, grep for a
 * string. Unlike the three above, this changes nothing, so it is auto-approved in
 * every permission mode (see `decideAuto`) and every role may issue it (see
 * `allowsTool`). It is still a real proposal rather than an inline side channel,
 * so the UI, the transcript, and the session DB all record what Sylor looked at
 * — the user can always see what it based a decision on.
 *
 * This is the tool that makes Sylor able to work on an EXISTING file: before it
 * had one, the model could only rewrite files whole, from guesswork.
 */
export interface ReadProposal {
  id: string
  kind: 'read'
  op: ReadOp
  /**
   * Project-relative POSIX target: the file for `read_file`, the directory for
   * `list_files`, and the directory to search under for `search_files` /
   * `find_files` ('.' for the whole project).
   */
  path: string
  /** The text/regex being searched for — `search_files` only. */
  query?: string
  /**
   * A glob pattern. For `search_files` it restricts which files are grepped
   * (e.g. `*.ts`); for `find_files` it IS the query — the name/path pattern whose
   * matching files are returned.
   */
  glob?: string
  /** 1-based first line to return — `read_file` only (default: the start). */
  offset?: number
  /** How many lines to return — `read_file` only (default: a bounded window). */
  limit?: number
  /** Lines of trailing context to print around each hit (grep -A) — `search_files`. */
  after?: number
  /** Lines of leading context to print around each hit (grep -B) — `search_files`. */
  before?: number
  /** Lines of context on BOTH sides (grep -C); sets before+after when they're unset. */
  context?: number
  /** Match a pattern that can SPAN lines (grep -U/rg multiline) — `search_files`. */
  multiline?: boolean
  /**
   * What a `search_files` returns: `content` (matching lines, the default),
   * `files` (just the paths that matched, like `rg -l`), or `count` (per-file
   * match tallies, like `rg -c`). Ignored by the other read ops.
   */
  mode?: 'content' | 'files' | 'count'
}

/**
 * Which browser-verification action a {@link PreviewInspectProposal} performs
 * against the LIVE preview (the `<webview>` in the preview pane). This is Sylor's
 * analogue of Claude Code's `preview_*` toolset: it lets the coding engine SEE
 * and DRIVE the running app it just changed instead of guessing whether an edit
 * worked. Read-like actions observe; `click`/`fill`/`resize` interact.
 *
 *  - `snapshot`      — an accessibility/DOM text snapshot (structure + text).
 *  - `screenshot`    — a rendered PNG of the current viewport (vision path).
 *  - `inspect`       — computed CSS for an element (best for verifying styles).
 *  - `console_logs`  — recent guest `console.*` output (optionally error/warn).
 *  - `network`       — recent resource requests (optionally only failed ones).
 *  - `click`         — click an element by CSS selector, then re-observe.
 *  - `fill`          — type a value into an input by CSS selector.
 *  - `resize`        — emulate a viewport (mobile/tablet/desktop or W×H) to test
 *                       responsive layout; reflows the real preview element.
 */
export type PreviewInspectAction =
  | 'snapshot'
  | 'screenshot'
  | 'inspect'
  | 'console_logs'
  | 'network'
  | 'click'
  | 'fill'
  | 'resize'

/**
 * A request to LOOK AT or DRIVE the live browser preview — the verification
 * affordance behind "check that the button is actually blue now". Like
 * {@link ReadProposal} it is auto-approved in every mode and allowed for every
 * role: it only observes/interacts with the user's own running preview, touches
 * no filesystem and makes no outbound network egress. The one hard safety rule
 * lives in the executor: `fill` refuses credential-looking fields.
 */
export interface PreviewInspectProposal {
  id: string
  kind: 'preview_inspect'
  action: PreviewInspectAction
  /** CSS selector for `inspect` / `click` / `fill` (the target element). */
  selector?: string
  /** Which computed-style properties to report — `inspect` (default: a useful set). */
  styles?: string[]
  /** The value to type — `fill` only. */
  value?: string
  /** Filter guest console output by level — `console_logs` (default: all). */
  level?: 'all' | 'error' | 'warn'
  /** Filter captured requests — `network` (default: all). */
  filter?: 'all' | 'failed'
  /** A device preset — `resize`; `desktop` clears any emulated width. */
  preset?: 'mobile' | 'tablet' | 'desktop'
  /** Explicit emulated width in px — `resize` (overrides `preset` when set). */
  width?: number
  /** Explicit emulated height in px — `resize`. */
  height?: number
}

/**
 * One thing the agent can do to a real web page. Deliberately smaller than
 * {@link PreviewInspectAction}: this drives the live web, not the user's own
 * localhost preview, so the surface is only what browsing actually needs.
 *
 *  - `read`     — perceive the page (DOM/accessibility text, or a screenshot).
 *  - `navigate` — go to a url (or a search, for anything that isn't one).
 *  - `click`    — click an element found by its perceived index or its text.
 *  - `type`     — type into a field, then optionally press Enter.
 *  - `scroll`   — move the viewport up or down.
 *  - `console`  — the page's own console messages and uncaught errors.
 *  - `network`  — the requests the page made (method, url, status, timing).
 *  - `inspect`  — one element's text, classes, box and computed styles.
 *
 * The last three are the debugging half: `read` says what the page *shows*,
 * they say what it is *doing*. All three are reads — auto-approved, no mutation.
 */
export type BrowseAction =
  | 'read'
  | 'navigate'
  | 'click'
  | 'type'
  | 'scroll'
  | 'console'
  | 'network'
  | 'inspect'

/**
 * A request to USE THE WEB in a real browser — the capability that used to live
 * in the separate browser destination, now an ordinary permission-gated tool in both Cowork
 * and Code.
 *
 * `read`, `navigate` and `scroll` are auto-approved (cheap and reversible, like
 * {@link ReadProposal}); `click` and `type` go through the per-action policy in
 * {@link ProviderSettings.browser}. Two rules live in the executor and cannot be
 * configured away: a click classified as a payment is refused outright, and a
 * `type` into a credential-looking field is refused — Sylor never types secrets.
 */
export interface BrowseProposal {
  id: string
  kind: 'browse'
  action: BrowseAction
  /** Where to go — `navigate`. A bare host is https'd; anything else is searched. */
  url?: string
  /**
   * Which element to act on — `click` / `type`. Either a perceived index
   * (`'12'`, as tagged by the last `read`) or a label to match on the page.
   */
  target?: string
  /** The text to type — `type` only. */
  text?: string
  /** Press Enter after typing — `type` only. */
  submit?: boolean
  /** Which way to move — `scroll` (default `down`). */
  direction?: 'up' | 'down'
  /** Ask for a screenshot instead of text — `read` only (rides the vision path). */
  visual?: boolean
  /** CSS selector of the element to report on — `inspect` only. */
  selector?: string
  /** Extra computed CSS properties to include — `inspect` only. */
  styles?: string[]
  /** Which console messages to report — `console` only (default `all`). */
  level?: 'all' | 'error' | 'warn'
  /** Which requests to report — `network` only (default `all`). */
  filter?: 'all' | 'failed'
  /**
   * How this action was classified for the permission gate — set by the engine,
   * not the model. `payment` is always refused; `send`/`delete` always ask.
   */
  risk?: BrowserAction
}

/**
 * Which checkers a {@link DiagnosticsProposal} asks for. `all` runs every one the
 * project actually has installed; the single values narrow it when only one
 * matters (e.g. after a lint-only fix).
 */
export type DiagnosticsScope = 'all' | 'typescript' | 'eslint'

/**
 * A request to RUN THE PROJECT'S OWN CHECKERS and read the problems back as
 * structured data — Sylor's stand-in for an editor's language server (Claude
 * Code reads diagnostics from the IDE; there is no IDE here, so the checkers are
 * invoked directly).
 *
 * Permission-gated exactly like {@link RunCommandProposal}, and for the same
 * reason: it spawns a process out of the project's own `node_modules`, and an
 * ESLint config/plugin is executable JavaScript. Nothing is written, so a scoped
 * subagent needs only the capabilities that already allow a command.
 */
export interface DiagnosticsProposal {
  id: string
  kind: 'diagnostics'
  /** Which checkers to run (default `all`). */
  scope: DiagnosticsScope
  /** Project-relative paths to narrow the report to; empty/absent = whole project. */
  files?: string[]
}

/** Discriminated union of everything the engine can ask to do. */
export type ToolProposal =
  | WriteFileProposal
  | RunCommandProposal
  | McpCallProposal
  | WebFetchProposal
  | WebSearchProposal
  | InstallPluginProposal
  | ReadProposal
  | PreviewInspectProposal
  | BrowseProposal
  | DiagnosticsProposal

/** The user's (or permission-mode's) verdict on a proposal. */
export type ToolDecision = 'approve' | 'reject'

/** Outcome of an applied `write_file` proposal. */
export interface WriteFileResult {
  id: string
  kind: 'write_file'
  ok: boolean
  /** Present when `ok` is false (e.g. sandbox violation, write error). */
  error?: string
  /**
   * Problems found by statically checking the bytes just written — malformed
   * JSON, an unbalanced/truncated source file, a missing asset or import target.
   * The write still succeeded (`ok` stays true); these are fed back to the agent
   * so it fixes them on the next iteration instead of leaving the user with a
   * blank page. Absent means nothing was detected, NOT that the file is correct.
   */
  issues?: string[]
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

/** Outcome of a `read` proposal (file text, directory listing, or search hits). */
export interface ReadResult {
  id: string
  kind: 'read'
  /** False when the target was missing, unreadable, or outside the sandbox. */
  ok: boolean
  /** The file text / listing / matching lines, bounded to stay context-safe. */
  output: string
  /** True when `output` was clipped at the cap. */
  truncated: boolean
  /** One-line human summary for the card ('240 lines', '8 matches in 3 files'). */
  summary: string
  /**
   * Set when `read_file` targeted an IMAGE (PNG/JPEG/GIF/WebP): the raw base64
   * bytes and their MIME type, handed to a vision-capable model as an attached
   * image (see the provider layer). `output` still carries a short text caption
   * so a non-vision model — and the transcript — always has something to read.
   */
  media?: { kind: 'image'; mediaType: string; dataBase64: string }
  /** Present when `ok` is false. */
  error?: string
}

/** Outcome of a `web_fetch` proposal (readable page text, or the failure). */
export interface WebFetchResult {
  id: string
  kind: 'web_fetch'
  /** Whether the fetch completed and returned usable content. */
  ok: boolean
  /** The page's readable text (bounded), prefixed with the URL/title header. */
  output: string
  /** True when `output` was clipped at the cap. */
  truncated: boolean
  /** Present when `ok` is false (bad URL, blocked host, network error, timeout). */
  error?: string
}

/** Outcome of a `web_search` proposal (a ranked result list, or the failure). */
export interface WebSearchResult {
  id: string
  kind: 'web_search'
  /** Whether the search completed (an empty-but-reachable search is still ok). */
  ok: boolean
  /** The ranked `title / url / snippet` list (bounded), or a "no results" note. */
  output: string
  /** True when the list was clipped at the cap. */
  truncated: boolean
  /** Present when `ok` is false (non-2xx, network error, timeout, empty query). */
  error?: string
}

/** Outcome of an `install_plugin` proposal (what got installed, or the failure). */
export interface InstallPluginResult {
  id: string
  kind: 'install_plugin'
  /** Whether the plugin installed successfully. */
  ok: boolean
  /** Human summary of what was added (skills/commands/connectors), shown + fed back. */
  output: string
  /** The installed plugin's name, when `ok` (so the UI can label the card). */
  plugin?: string
  /** Present when `ok` is false (bad source, missing Git, empty repo, write error). */
  error?: string
}

/**
 * Outcome of a `preview_inspect` proposal — the text the engine reads back
 * (snapshot/console/network/computed-style) and, for `screenshot`, the rendered
 * image on the shared vision {@link ReadResult.media} channel so a vision model
 * can literally see the preview. `output` always carries a text description too,
 * so a non-vision model — and the transcript — always has something to read.
 */
export interface PreviewInspectResult {
  id: string
  kind: 'preview_inspect'
  /** False when no preview is running, the selector missed, or the action errored. */
  ok: boolean
  /** Which action produced this result (echoed for the card + feedback). */
  action: PreviewInspectAction
  /** The textual result (snapshot text, log lines, computed styles, a note). */
  output: string
  /** True when `output` was clipped at the cap. */
  truncated: boolean
  /** One-line human summary for the card ('12 elements', 'clicked .save'). */
  summary: string
  /** Set for `screenshot`: the rendered PNG bytes, handed to the vision path. */
  media?: { kind: 'image'; mediaType: string; dataBase64: string }
  /** Present when `ok` is false (no preview, bad selector, blocked field, timeout). */
  error?: string
}

/**
 * Outcome of a `browse` proposal. Shaped like {@link PreviewInspectResult} on
 * purpose: `output` is the text the model reads back (the perceived page, or a
 * note about what the action did), and a `read` with `visual` puts the rendered
 * PNG on the shared vision {@link ReadResult.media} channel.
 */
export interface BrowseResult {
  id: string
  kind: 'browse'
  /** False when no browser is available, the element missed, or the action was refused. */
  ok: boolean
  /** Which action produced this result (echoed for the card + feedback). */
  action: BrowseAction
  /** The perceived page text, or a description of what happened. */
  output: string
  /** True when `output` was clipped at the cap. */
  truncated: boolean
  /** One-line human summary for the card ('read mail.google.com', 'clicked Compose'). */
  summary: string
  /** Where the browser ended up, so the transcript shows real navigation. */
  url?: string
  /** Set when `visual` was asked for: the rendered PNG, handed to the vision path. */
  media?: { kind: 'image'; mediaType: string; dataBase64: string }
  /** Present when `ok` is false (no browser, element not found, refused, timeout). */
  error?: string
}

/**
 * One problem reported by a checker, normalized so a TypeScript error and an
 * ESLint error read identically. `code` is the machine identifier the checker
 * used — `TS2345` for tsc, the rule id for eslint — and is absent only when the
 * checker didn't give one (a fatal parse error).
 */
export interface DiagnosticEntry {
  /** Which checker produced this. */
  source: 'typescript' | 'eslint'
  severity: 'error' | 'warning'
  /** Project-relative POSIX path, or '' for a project-level (config) problem. */
  file: string
  /** 1-based line, or 0 when the checker reported no position. */
  line: number
  /** 1-based column, or 0 when the checker reported no position. */
  column: number
  /** `TS2345`, `no-unused-vars`, … */
  code?: string
  message: string
}

/**
 * Outcome of a `diagnostics` proposal. `ok` means the checkers RAN — never that
 * the project is clean: a clean project is `ok: true` with zero counts, while a
 * project where nothing could be run is `ok: false` with an `error` saying so.
 * That distinction is the point of the tool; silence must never read as health.
 */
export interface DiagnosticsResult {
  id: string
  kind: 'diagnostics'
  /** False when no checker could be run at all (none installed, or one crashed). */
  ok: boolean
  /** Every problem found, capped for context safety (errors before warnings). */
  entries: DiagnosticEntry[]
  /** Total error count BEFORE the cap. */
  errors: number
  /** Total warning count BEFORE the cap. */
  warnings: number
  /** True when `entries` (and `output`) were clipped at the cap. */
  truncated: boolean
  /** Human labels of what actually ran ('typescript (tsconfig.node.json)', 'eslint'). */
  ran: string[]
  /** What was NOT run and why ('eslint (not installed in this project)'). */
  skipped: string[]
  /** The formatted report fed back to the model and shown in the card. */
  output: string
  /** One-line human summary for the card ('3 errors, 2 warnings' / 'clean'). */
  summary: string
  /** Present when `ok` is false. */
  error?: string
}

/** Discriminated union of tool outcomes reported back to the renderer. */
export type ToolResult =
  | WriteFileResult
  | RunCommandResult
  | McpCallResult
  | WebFetchResult
  | WebSearchResult
  | InstallPluginResult
  | ReadResult
  | PreviewInspectResult
  | BrowseResult
  | DiagnosticsResult

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

/**
 * §33 — the standing progress of a staged run, for the live status row.
 *
 * The engine sends this alongside the transient status message: the message says
 * what is happening *right now* and is replaced constantly, while this says where
 * the whole build stands and is therefore STICKY in the UI — the renderer keeps the
 * last one it received for the rest of the turn. It carries only what the renderer
 * cannot work out for itself (the task counter it derives from `plan` +
 * `task-update`), and every field is optional so a one-off edit — which has no
 * phase and no roadmap — simply sends nothing.
 */
export interface RunProgress {
  /** Which phase of how many, by name, when the run is a phase of a build. */
  phase?: { n: number; total: number; name: string }
  /** How the project's own checks stood the last time they ran this turn. */
  checks?: 'PASSING' | 'FAILING' | 'UNKNOWN'
  /** What the preview is actually showing (§23 — never presented as current when it isn't). */
  preview?: 'RUNNING' | 'STALE' | 'COMPILE_ERROR' | 'RUNTIME_ERROR' | 'UNAVAILABLE' | 'UNKNOWN'
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
      /** §33 — where the build stands. Sticky: sent when it changes, not every time. */
      progress?: RunProgress
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
   * `background` marks a non-blocking spawn (the lead keeps working, so its card
   * must not hijack the lead's status line); `isolation` marks an agent running
   * in a private git worktree. Both optional and additive — an older renderer, or
   * a plain foreground spawn, simply omits them.
   */
  | {
      type: 'agent-start'
      runId: string
      agentId: string
      role: AgentRole
      task: string
      background?: boolean
      isolation?: 'worktree'
    }
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
  /**
   * Folder this run is pinned to (the conversation's own `projectRoot`). When
   * provided, the engine wraps the whole run in `contextManager.runWithRoot`, so
   * reads/writes stay under this root even if the user opens a different folder
   * mid-run (background-run isolation). Omitted → uses the live global root.
   */
  root?: string
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
  /**
   * Display label of the model that produced this turn (assistant rows only),
   * stamped by the main process from the active provider settings at append time.
   * Absent on user turns and on rows written before the stat columns existed —
   * the activity dashboard simply leaves those out of its model tally.
   */
  model?: string
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
  /**
   * Aggregate activity figures for the zero-state dashboard, computed from the
   * real history in SQLite. Read-only and cheap (a handful of aggregate queries);
   * never throws — a DB fault resolves to an all-zero snapshot.
   */
  usageStats: () => Promise<UsageStats>
}

// ---------------------------------------------------------------------------
// Activity & usage analytics (zero-state dashboard)
// ---------------------------------------------------------------------------

/**
 * Raw, un-bucketed activity facts read straight out of SQLite. Deliberately
 * dumb: every derived figure (streaks, active days, peak hour, the contribution
 * grid) is computed from these by the pure `computeUsageStats` in
 * `shared/usage.ts`, so all the calendar logic is unit-testable without a DB.
 */
export interface UsageFacts {
  /** Conversations that contain at least one message (empty drafts excluded). */
  sessions: number
  /** Total chat messages stored, both roles. */
  messages: number
  /**
   * Estimated tokens (~4 characters each) across message bodies and tool
   * payloads. An estimate, not a provider-reported count — Sylor never asks the
   * gateway for usage figures — so the UI always prefixes it with `~`.
   */
  tokens: number
  /**
   * Epoch ms per message, one entry each, in no particular order. Messages
   * written before the timestamp column existed fall back to their session's
   * creation time so old history still lands on the calendar.
   */
  timestamps: number[]
  /** Assistant-turn counts per model label; models are absent, never blank. */
  models: Array<{ model: string; count: number }>
}

/** One cell of the contribution grid. */
export interface DayBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  /** Messages written that day. */
  count: number
  /** True for cells past today — they pad the current week and render blank. */
  future: boolean
}

/** Everything the zero-state activity dashboard renders. */
export interface UsageStats {
  sessions: number
  messages: number
  /** Estimated tokens; see {@link UsageFacts.tokens}. */
  tokens: number
  /** Distinct local calendar days with at least one message, all-time. */
  activeDays: number
  /** Consecutive active days ending today or yesterday; 0 once the run breaks. */
  currentStreak: number
  /** The longest run of consecutive active days ever recorded. */
  longestStreak: number
  /** Local hour (0–23) with the most messages, or null when there are none. */
  peakHour: number | null
  /** Most-used model label, or null when no turn recorded one. */
  favoriteModel: string | null
  /** Epoch ms of the most recent message, or null when history is empty. */
  lastActiveAt: number | null
  /**
   * The grid window: exactly `GRID_WEEKS * 7` days, oldest first, starting on a
   * Sunday and ending on the Saturday of the current week. Ordered so a
   * `grid-flow-col` layout with 7 rows draws one week per column.
   */
  days: DayBucket[]
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
 * One `preview_inspect` action dispatched main → renderer over
 * `IpcChannel.PreviewInspectRequest`. The renderer owns the live `<webview>`, so
 * the engine (main) cannot drive it directly — it posts a request keyed by
 * `requestId` and awaits the matching {@link PreviewInspectResponse}. Carries the
 * fields the renderer needs to run the action; the executor validated them first.
 */
export interface PreviewInspectRequest {
  /** Correlates the response back to the awaiting engine call. */
  requestId: string
  action: PreviewInspectAction
  selector?: string
  styles?: string[]
  value?: string
  level?: 'all' | 'error' | 'warn'
  filter?: 'all' | 'failed'
  preset?: 'mobile' | 'tablet' | 'desktop'
  width?: number
  height?: number
}

/**
 * The renderer's reply to a {@link PreviewInspectRequest}, sent back over
 * `IpcChannel.PreviewInspectResult`. Mirrors {@link PreviewInspectResult} minus
 * the proposal id/kind/action (which the engine re-attaches), plus the
 * `requestId` that unblocks the pending main-side promise.
 */
export interface PreviewInspectResponse {
  requestId: string
  ok: boolean
  output: string
  truncated: boolean
  summary: string
  media?: { kind: 'image'; mediaType: string; dataBase64: string }
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
  /**
   * Preview the project the way it actually renders: its dev server when it has
   * one (reusing an already-running server), a plain static serve otherwise. Use
   * this when you just want the app on screen — a bundler app (React/Vue/Svelte)
   * served statically is a blank page, and this is what avoids that.
   */
  startAuto: (entry?: string) => Promise<PreviewStartResult>
  /** Stop the dev server, close the static server, and drop the file watcher. */
  stop: () => void
  /** Subscribe to preview lifecycle events; returns a disposer. */
  onEvent: (callback: (event: PreviewEvent) => void) => () => void
  /**
   * Subscribe to `preview_inspect` requests the engine (main) posts when it wants
   * to verify the live preview. The renderer owns the `<webview>`, so it runs the
   * action and replies via {@link respondInspect} keyed by `request.requestId`.
   * Returns a disposer. (No-op outside the packaged app.)
   */
  onInspectRequest: (callback: (request: PreviewInspectRequest) => void) => () => void
  /** Reply to a {@link PreviewInspectRequest}, unblocking the awaiting engine call. */
  respondInspect: (response: PreviewInspectResponse) => void
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
  /**
   * Re-point the active root to an already-known folder WITHOUT a picker (used
   * when opening a past conversation, to restore its own `projectRoot`). Unlike
   * {@link select}, this does NOT persist the default workspace — the folder for
   * brand-new chats / next launch stays the user's last explicit pick. Returns
   * the resulting info; a missing/invalid dir leaves the current root unchanged.
   */
  setRoot: (dir: string) => Promise<WorkspaceInfo>
  /** Current workspace root + whether it was explicitly chosen. */
  get: () => Promise<WorkspaceInfo>
  /** Subscribe to workspace-root changes; returns a disposer. */
  onChanged: (callback: (info: WorkspaceInfo) => void) => () => void
}

/**
 * Global long-term memory: the cross-project profile of durable facts about the
 * person (name, working/style taste, the sites and groups they use). It is the
 * SAME store the Code/Cowork engine reads and writes via `remember_user`, now
 * also reachable from the renderer so the browser panel can read it (to
 * act faster and more personally) and add to it (so what it learns while browsing
 * carries into every future Sylor session). Never holds secrets.
 */
export interface MemoryApi {
  /** The memory as prompt-ready bullets, or '' when nothing has been learned yet. */
  get: () => Promise<string>
  /**
   * Append one durable fact. Resolves true when it was newly stored, false for a
   * blank or exact-duplicate note. Best-effort: a persistence hiccup resolves
   * false rather than throwing, so it can never abort the caller's task.
   */
  remember: (note: string) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Real browser — the user's own Chrome, driven over the DevTools protocol
// ---------------------------------------------------------------------------

/**
 * State of the one real-Chrome window Sylor drives.
 *
 * An embedded browser cannot sign in to Google — measured, and not fixable
 * by presenting a better browser identity. So for "everything that works in Chrome"
 * Sylor drives the user's actual Chrome/Edge instead: a real browser window, opened
 * with a Sylor-only profile and an unguessable loopback debugging port, killed when
 * Sylor quits. The user signs in there once; every logged-in web app then just works.
 */
export interface ChromeStatus {
  /** A drivable browser (Chrome/Edge/Chromium) exists on this computer. */
  available: boolean
  /** Display name of that browser, or '' when none was found. */
  browserName: string
  /** The window is up and Sylor is attached to it. */
  running: boolean
  /** Current page url (mirrored from the browser, so reads are free). */
  url: string
  /** Current page title. */
  title: string
  /** True while the page is still loading. */
  loading: boolean
  /**
   * True while a **clean** sign-in window is open on the same profile.
   *
   * Google refuses to sign in to a browser that has a debugging port open — the same
   * anti-automation check that blocks the embedded webview. So signing in happens in a
   * stock window with nothing attached (see `launchForSignIn`), and Sylor is *not*
   * driving anything while that is true.
   */
  signingIn: boolean
  /** Last lifecycle failure, for the UI to explain; null when healthy. */
  error: string | null
}

/**
 * Drive that browser from the renderer. Deliberately the same primitives the in-app
 * page view exposes (navigate / evaluate / screenshot / history), so the
 * permission gate, the perception pass and the agent loop work against either one.
 */
export interface ChromeApi {
  /** Current status. Cheap — starts nothing. */
  status: () => Promise<ChromeStatus>
  /** Launch (or reuse) the window, optionally at a url. Rejects when none is installed. */
  open: (url?: string) => Promise<ChromeStatus>
  /** Close the window and drop the debugging port. */
  close: () => Promise<ChromeStatus>
  /** Navigate the controlled tab, starting the browser first if needed. */
  navigate: (url: string) => Promise<ChromeStatus>
  /** Run JS in the page and resolve with its value; rejects on a page-side error. */
  evaluate: (expression: string) => Promise<unknown>
  /** PNG data URL of the visible page. */
  screenshot: () => Promise<string>
  reload: (ignoreCache?: boolean) => Promise<void>
  stop: () => Promise<void>
  /** Step history; resolves false when there is nowhere to go. */
  go: (delta: number) => Promise<boolean>
  /** Bring the browser window forward — sign-in is the user's to do, never Sylor's. */
  focus: () => Promise<void>
  /**
   * Open a **clean** window on the same profile so the user can sign in.
   *
   * The controlled window is closed first: Chrome allows one process per profile
   * directory, and more importantly Google rejects sign-in while a debugging port is
   * open. Nothing is attached to the window this opens — it is stock Chrome — and when
   * the user closes it Sylor reopens the controlled window, now with their session
   * on disk.
   */
  signIn: (url?: string) => Promise<ChromeStatus>
  /** Give up waiting for that window and go back to driving (closes it if still open). */
  finishSignIn: () => Promise<ChromeStatus>
  /** Subscribe to status pushes (url/title/loading and lifecycle). */
  onStatus: (callback: (status: ChromeStatus) => void) => () => void
}

// ---------------------------------------------------------------------------
// In-app browser — the page view main owns and the agent drives
// ---------------------------------------------------------------------------

/** Where in the window the in-app page view should sit, in CSS pixels. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Which browser the agent drives.
 *
 * `app` is the in-app page view (instant, in-window, but still an embedded browser
 * — Google refuses to sign in to one); `chrome` is the user's real Chrome, launched
 * by Sylor and driven over the DevTools protocol, where every logged-in web app
 * works. More than a UI preference: it changes what the agent should do about a
 * signed-out page. Sylor never types credentials in either.
 */
export type BrowserDriver = 'app' | 'chrome'

/** What the in-app page view is currently showing. */
export interface BrowserViewStatus {
  /** True once a page view exists (it is created lazily, on first use). */
  attached: boolean
  /** True while the view is drawn over the renderer. */
  visible: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Present when the last navigation failed. */
  error: string | null
}

/**
 * The in-app browser: a `WebContentsView` owned by the main process and drawn
 * over the renderer where the panel says to.
 *
 * Main owns it (rather than the renderer holding a `<webview>`) for one concrete
 * reason: the engine's `browse` tool then drives it directly, with no
 * main → renderer → main round-trip like `preview_inspect` needs. The renderer's
 * only job here is telling main *where* to put it and *whether* it is showing —
 * a native view floats above the DOM, so a panel that closes must hide it too.
 */
export interface BrowserApi {
  /** Current view status. Cheap — creates nothing. */
  status: () => Promise<BrowserViewStatus>
  /** Create the view if needed and load `url` (bare hosts are https'd, prose is searched). */
  open: (url?: string) => Promise<BrowserViewStatus>
  /** Position the view. The renderer reports its panel rect on every layout change. */
  setBounds: (bounds: BrowserBounds) => Promise<void>
  /** Show or hide the view without destroying the page. */
  setVisible: (visible: boolean) => Promise<void>
  /** Destroy the view and its page. */
  close: () => Promise<BrowserViewStatus>
  reload: (ignoreCache?: boolean) => Promise<void>
  stop: () => Promise<void>
  /** Step history; resolves false when there is nowhere to go. */
  go: (delta: number) => Promise<boolean>
  /**
   * Choose which browser the agent's next `browse` drives. The panel's segmented
   * control owns this, so what the user sees selected is what the engine uses.
   */
  setDriver: (driver: BrowserDriver) => Promise<void>
  /** Subscribe to status pushes (url/title/loading and lifecycle). */
  onStatus: (callback: (status: BrowserViewStatus) => void) => () => void
}

// ---------------------------------------------------------------------------
// Scheduled tasks (Phase 4) — a stored prompt fired into a run on a cadence
// ---------------------------------------------------------------------------

/**
 * A saved prompt that Sylor runs automatically on a cron cadence — the
 * automation half of Phase 4. When a task comes due the main-process scheduler
 * asks the renderer to open a fresh chat and send `prompt`, so a scheduled run
 * reuses the exact same engine + permission machinery as a typed message:
 * sensitive tools still prompt for approval, and nothing runs silently.
 */
export interface ScheduledTask {
  /** Stable id (`sched-<time>-<n>`, minted by the store). */
  id: string
  /** Human label shown in the list and used to title the fired chat. */
  name: string
  /** The prompt sent to the engine when the task fires. */
  prompt: string
  /** Standard 5-field cron expression (`min hour dom month dow`). */
  cron: string
  /** Whether the scheduler should fire it; paused tasks stay in the list. */
  enabled: boolean
  /**
   * When true the task is persisted to the DB and survives restarts; when false
   * it lives only for this app session (dropped on quit).
   */
  durable: boolean
  /**
   * Working mode the fired run should use — `code` to do real work, `cowork`
   * for a chat-only answer. Defaults to `code` when omitted.
   */
  mode?: WorkMode
  createdAt: number
  updatedAt: number
  /** Epoch ms the task last fired, or undefined if it never has. */
  lastRunAt?: number
  /** Epoch ms the task is next due (computed from `cron`); undefined if paused. */
  nextRunAt?: number
}

/** Editable fields accepted when creating/updating a task (the store fills the rest). */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  cron: string
  enabled?: boolean
  durable?: boolean
  mode?: WorkMode
}

/**
 * Renderer-facing API for scheduled tasks (Phase 4): CRUD over the task list
 * plus a subscription the app uses to actually run a task when it comes due.
 * `add`/`update` reject an invalid cron expression so the UI can show the error.
 */
export interface SchedulerApi {
  /** Every task (durable + session-only), soonest-due first. */
  list: () => Promise<ScheduledTask[]>
  /** Add a task; resolves the stored row (with its computed nextRunAt). */
  add: (input: ScheduledTaskInput) => Promise<ScheduledTask>
  /** Replace a task's editable fields; resolves the updated row, or null if gone. */
  update: (id: string, input: ScheduledTaskInput) => Promise<ScheduledTask | null>
  /** Pause/resume a task; resolves the updated row, or null if gone. */
  setEnabled: (id: string, enabled: boolean) => Promise<ScheduledTask | null>
  /** Delete a task. */
  remove: (id: string) => Promise<void>
  /**
   * Subscribe to "a task is due" events. The callback receives the task to run;
   * returns a disposer. The renderer opens a fresh chat and sends the prompt.
   */
  onTaskFired: (callback: (task: ScheduledTask) => void) => () => void
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
  /** Commands: disk-authored slash-command templates surfaced in the `/` menu. */
  commands: CommandsApi
  /** Plugins: git-installed bundles of skills / commands / connectors. */
  plugins: PluginsApi
  /** Working folder (Code mode): select/get the agent's sandbox root. */
  workspace: WorkspaceApi
  /** Long-term memory: the global cross-project user profile. */
  memory: MemoryApi
  /** The user's real Chrome, driven over DevTools — everything the webview can't do. */
  chrome: ChromeApi
  /** The in-app page view the `browse` tool drives (main owns it; see BrowserApi). */
  browser: BrowserApi
  /** Scheduled tasks: stored prompts the scheduler fires on a cron cadence. */
  scheduler: SchedulerApi
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) client — extensibility
// ---------------------------------------------------------------------------

/**
 * A local (stdio) MCP server: Sylor spawns `command` as a child process and
 * speaks MCP over its stdio. Reaches only the local machine.
 *
 * Every string field supports `${VAR}` / `${VAR:-fallback}` expansion from the
 * process environment, so a config can be committed without its secrets.
 */
export interface McpStdioServerConfig {
  /** Explicit transport. Optional — a `command` already implies stdio. */
  type?: 'stdio'
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
 *
 * `type` pins the wire protocol when a server only speaks one of them; left out,
 * Sylor tries modern Streamable HTTP first and falls back to legacy HTTP+SSE.
 * Every string field supports `${VAR}` / `${VAR:-fallback}` expansion.
 */
export interface McpHttpServerConfig {
  /** Explicit transport: `http`/`streamable-http` or legacy `sse`. */
  type?: 'http' | 'streamable-http' | 'sse'
  /** Remote MCP endpoint (Streamable HTTP, with SSE fallback). */
  url: string
  /** Optional headers sent with every request (e.g. auth). Stored locally. */
  headers?: Record<string, string>
  /**
   * Sign in with OAuth when the server demands it (401), instead of failing.
   * Opt-in: setting it is the user's standing permission for Sylor to open their
   * browser for the consent screen and keep the resulting token on disk.
   */
  oauth?: boolean
}

/** A configured MCP server: local stdio process OR remote HTTP endpoint. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** The on-disk `mcp.json` shape (mirrors the Claude CLI's `.mcp.json`). */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>
}

/** Transport a server uses, surfaced to the UI as a badge. */
export type McpTransport = 'stdio' | 'http' | 'sse'

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
// Slash commands (disk-authored prompt templates) — extensibility
// ---------------------------------------------------------------------------

/**
 * Where a command came from:
 *  - `global`  → `~/.sylor/commands/<name>.md` (applies everywhere).
 *  - `project` → `<root>/.sylor/commands/<name>.md` (overrides global by name).
 */
export type CommandSource = 'global' | 'project'

/**
 * A slash command: a Markdown prompt template invoked from the composer with
 * `/<name>`, mirroring the Claude CLI's custom commands. The file's body is the
 * template; `$ARGUMENTS` (and `$1`, `$2`, …) are substituted with whatever the
 * user typed after the command name, and the result is sent as the prompt.
 */
export interface CommandInfo {
  /** Unique key: the frontmatter `name`, falling back to the file's basename. */
  name: string
  /** One-line description shown in the slash menu (may be empty). */
  description: string
  /** Optional hint about expected arguments, shown after the name (may be empty). */
  argumentHint: string
  /** The prompt template body (everything after the frontmatter). */
  body: string
  /** Which location the command was read from (project shadows global by name). */
  source: CommandSource
  /** Absolute path of the command's `.md` file (for the UI's "edit" hint). */
  path: string
}

/**
 * Input for authoring a new command from the UI. Sylor renders these fields into
 * a `<name>.md` with a frontmatter block (`description`/`argument_hint`) followed
 * by `body`, then writes it to `<scope>/commands/<slug>.md`.
 */
export interface CommandAddInput {
  name: string
  description?: string
  argumentHint?: string
  body: string
  scope: ConfigScope
}

/** Outcome of an add attempt: the fresh command list, or a friendly error. */
export interface CommandMutationResult {
  ok: boolean
  /** Present when `ok` is false (blank name/body, no writable scope, write failed). */
  error?: string
  /** Fresh list for the settings UI + slash menu (unchanged when `ok` is false). */
  commands: CommandInfo[]
}

/**
 * Renderer-facing API for slash commands. Commands are disk-authored Markdown
 * templates in `~/.sylor/commands/*.md` (global) + `<root>/.sylor/commands/*.md`
 * (project). The composer lists them in the `/` menu, and the engine expands a
 * leading `/<name> args` into the template body before the turn runs.
 */
export interface CommandsApi {
  /** Every command (global + project; project shadows global). */
  list: () => Promise<CommandInfo[]>
  /** Re-scan disk for commands; returns the fresh list. */
  reload: () => Promise<CommandInfo[]>
  /**
   * Author a new command: write a `<name>.md` on disk (chosen scope), then
   * re-scan. Validates main-side; returns a friendly error rather than throwing
   * on a blank name/body or an unwritable scope.
   */
  add: (input: CommandAddInput) => Promise<CommandMutationResult>
  /** Delete a command's `.md` file, then re-scan. Returns the fresh list. */
  remove: (name: string) => Promise<CommandInfo[]>
  /** Absolute paths of the commands directories (for the "add a command" hint). */
  configPaths: () => Promise<{ global: string; project: string | null }>
}

// ---------------------------------------------------------------------------
// Plugins (git-installed bundles of skills / commands / connectors)
// ---------------------------------------------------------------------------

/**
 * What a plugin installed, by name, so a later removal can withdraw exactly
 * those additions and nothing the user added by hand.
 */
export interface PluginContents {
  /** Skill names authored into `<scope>/skills/`. */
  skills: string[]
  /** Command names authored into `<scope>/commands/`. */
  commands: string[]
  /** MCP server (connector) names written into `<scope>/mcp.json`. */
  connectors: string[]
}

/**
 * A plugin installed from a git repo (or a local folder), recorded in
 * `~/.sylor/plugins.json` so the UI can list and cleanly remove it. A plugin is
 * just a bundle: on install its skills/commands/connectors are unpacked into the
 * ordinary `.sylor` locations, so they behave identically to hand-authored ones.
 */
export interface InstalledPlugin {
  /** Unique key: derived from the repo/folder name (slugified). */
  name: string
  /** The source it was installed from (a git URL or a local path), for display + reinstall. */
  source: string
  /** Which scope its contents were written to. */
  scope: ConfigScope
  /** Epoch ms the plugin was installed. */
  installedAt: number
  /** Exactly what was added, for a clean uninstall. */
  contents: PluginContents
}

/** Where to install a plugin from + into which scope. */
export interface PluginInstallInput {
  /** A GitHub `owner/repo`, a full git URL, or a local folder path. */
  source: string
  scope: ConfigScope
}

/** Outcome of an install attempt: the recorded plugin, or a friendly error. */
export interface PluginInstallResult {
  ok: boolean
  /** Present when `ok` is false (bad source, git missing, nothing found, write failed). */
  error?: string
  /** The installed plugin record (absent when `ok` is false). */
  plugin?: InstalledPlugin
  /** Fresh list of installed plugins for the UI. */
  plugins: InstalledPlugin[]
}

/**
 * Renderer-facing API for plugins. A plugin is a git repo (or local folder) that
 * bundles any of: `skills/<name>/SKILL.md`, `commands/*.md`, and an `mcp.json` of
 * connectors. Installing clones it, unpacks its contents into `~/.sylor` (or the
 * project), and records the set so it can be removed cleanly later.
 */
export interface PluginsApi {
  /** Every installed plugin, most-recent first. */
  list: () => Promise<InstalledPlugin[]>
  /** Clone + unpack a plugin's contents into the chosen scope; returns the record. */
  install: (input: PluginInstallInput) => Promise<PluginInstallResult>
  /** Withdraw a plugin's installed skills/commands/connectors + its record. */
  remove: (name: string) => Promise<InstalledPlugin[]>
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
