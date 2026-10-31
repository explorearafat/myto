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
 *  - `research` → the Research surface: a folderless, fully-powered agentic mode. The
 *               user picks one of 300+ professional agents (see shared/agent-catalog)
 *               and it works with the full toolset — files anywhere under the user's
 *               home, a real browser, web, code, documents, sub-agents — with
 *               side-effects permission-gated. Strictly more capable than `chat`, and
 *               unlike `cowork` needs no folder selected. See {@link ProviderSettings.researchAgentId}.
 * Threaded per-turn from the composer into the streaming request; never persisted
 * on a message (the transcript is mode-agnostic).
 */
export type ChatMode = 'chat' | 'cowork' | 'research'

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
  /**
   * Which browser the Track-2 browser tools drive (see {@link BrowserTarget}). Optional
   * so an older settings file, or any partial one, merges to `off` — browser control is
   * opt-in, like {@link ToolSettings.codeExecution} and {@link terminalConsent}. When
   * `system-chrome`, click/type stay permission-gated because they act on the user's real
   * logged-in sessions.
   */
  browserTarget?: BrowserTarget
}

/** Pre/Post tool-use hook commands (#9). Empty string = that hook is disabled. */
export interface CoworkHooks {
  /** Command run before each tool; non-empty stdout blocks the call with that text. */
  preToolUse: string
  /** Command run after each tool completes; its output is surfaced as a status line. */
  postToolUse: string
}

/**
 * Background-autonomy preferences — the "treat the computer as Myto's own device"
 * mandate. Every field is OFF by default: with the whole block at its defaults Myto
 * behaves exactly as before (closing the last window quits the app), so this can
 * never change the app's lifecycle without the user's explicit, sticky opt-in.
 *
 * SAFETY / SCOPE. Only {@link keepAliveInTray} is wired today: it keeps the *already
 * running* process alive in the system tray after the window is closed, so scheduled
 * tasks and in-flight runs survive a window close. It does NOT relaunch Myto after a
 * full Quit or an OS restart — surviving an actual app exit needs an OS login-item /
 * daemon, which is deliberately DEFERRED (it runs code unattended at boot and must be
 * a separate, clearly-consented step). {@link inboxEvery10min} is the scaffold flag
 * for the periodic inbox/mail check; it stays inert until a mail connector is added,
 * and any replies it ever drafts MUST be saved as drafts for the user to review —
 * never auto-sent.
 */
export interface BackgroundSettings {
  /**
   * Keep Myto running in the system tray when the last window is closed, instead of
   * quitting (opt-in; default false). A tray icon with Show/Quit is shown only while
   * this is on. Quit from the tray (or the OS) still exits fully. Does not survive a
   * full Quit or a reboot — see the interface note.
   */
  keepAliveInTray: boolean
  /**
   * Scaffold flag for the ~10-minute inbox/mail check (default false). Inert until a
   * mail connector + explicit account consent exist; when active it may only DRAFT
   * replies for the user to review, never auto-send. Kept here so the setting shape
   * and the tray plumbing are ready without shipping any unattended network side-effect.
   */
  inboxEvery10min: boolean
}

/**
 * TURN relay credentials for voice-call WebRTC. Both peers (phone + desktop) need
 * the same relay to fall back on when a direct P2P path can't traverse the two
 * networks' NATs. These are shared *transport* credentials — not desktop secrets —
 * and are handed to the phone inside the desktop's presence document at call time.
 * Defaults point at the free public OpenRelay (metered.ca); users with their own
 * TURN server replace them in Settings.
 */
export interface TurnServerConfig {
  /** TURN/STUN URLs, e.g. `turn:host:3478` / `turn:host:443?transport=tcp`. */
  urls: string[]
  /** TURN username (shared; often short-lived in production setups). */
  username: string
  /** TURN password/credential (shared). */
  credential: string
}

/**
 * How a voice call's requests to act are permissioned on the desktop. The strict
 * tier (`ask`) requires an explicit yes/no (spoken or tapped on the phone) for
 * anything side-effecting; higher tiers auto-approve progressively more, but
 * destructive operations (deletion, admin elevation, credentials) ALWAYS ask.
 */
export type CallPermissionMode = 'ask' | 'autoReadOnly' | 'autoDev'

/**
 * Desktop-side speech recognition for calls: the phone's mic audio already
 * streams to the desktop over WebRTC; the desktop detects speech (VAD), and
 * transcribes it through the SAME gateway the chat uses (an audio-capable
 * model — e.g. a free Gemini via OpenRouter) using the user's existing key.
 * Zero setup. This rescues devices whose Android SpeechRecognizer can't run
 * during a WebRTC call.
 */
export interface CallSttConfig {
  /** Audio-capable model id used for transcription. Empty = desktop STT off. */
  model: string
}

/**
 * Voice-call preferences (Myto Remote). The call system is authenticated by the
 * user's own Firebase session (the desktop and the phone are signed into the same
 * account); these settings govern availability, ring behavior, relay config, and
 * how much the phone may do on the PC without asking.
 */
export interface CallSettings {
  /** Master switch: publish presence + accept calls from the paired phone. */
  enabled: boolean
  /** Answer incoming calls automatically after the ring period (Myto is an agent). */
  autoAnswer: boolean
  /**
   * Base ring time before auto-answering, in ms (default 5500). Small per-call
   * jitter (0–1500ms) is added so the ringing phase lands in the natural 5–7s
   * band. The WebRTC negotiation only starts at accept, so this is genuine
   * ringing — not an artificial delay after an already-open connection.
   */
  answerDelayMs: number
  /** TURN relay the phone falls back to when a direct P2P path fails. */
  turn: TurnServerConfig
  /** Command-execution permission tier for call-driven work (see CallPermissionMode). */
  permissionMode: CallPermissionMode
  /** Desktop-side fallback speech recognition (see {@link CallSttConfig}). */
  stt: CallSttConfig
  /**
   * The folder calls work in — the agent's sandbox for everything started from
   * a voice call, separate from the main Cowork workspace. Empty = auto: the
   * first call persists `Documents\Myto Call Work` here. When the user says
   * "ei folder" / "that folder" on a call, they mean this directory.
   */
  callWorkspaceDir: string
  /** Task-completion callback behavior (the "Myto calls you back" flow). */
  callbacks: CallCallbackSettings
}

/** Task-completion callback preferences. */
export interface CallCallbackSettings {
  /** Call the phone back when a task started from a call reaches a terminal state. */
  enabled: boolean
  /** Missed-call retry attempts before giving up (0 disables retries). */
  retryLimit: number
  /** Minutes between retry attempts. */
  retryAfterMin: number
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

/**
 * Which browser Cowork's Track-2 browser tools drive. `off` (default) hides them
 * entirely; `in-app` drives Myto's own sandboxed browser pane (blank profile — the
 * user logs into sites inside Myto), the safe/reversible choice; `system-chrome`
 * drives the user's real Chrome over the DevTools Protocol so their existing logins
 * (Gmail/WhatsApp/…) are reused — powerful but higher-stakes. User-selectable in
 * Settings › Cowork.
 */
export type BrowserTarget = 'off' | 'in-app' | 'system-chrome'

/** What a tool changes, used to decide whether it needs approval. Absent = read-only. */
export type ToolSideEffect = 'write' | 'exec'

/**
 * Something Myto wants to show in its own preview pane (Cowork). Raised by the
 * `preview` tool and carried on a {@link CompletionChunk} so it rides the same
 * stream as the reply; the renderer opens the side pane on it. A `file` target is
 * a working-folder artifact (an HTML page, a PDF, an image, a chart) already
 * resolved to a `file://` URL; a `url` target is a localhost/remote page (a running
 * dev server) — both load in the same isolated `partition="preview"` webview guest.
 * A `markdown` target carries in-memory markdown (a plan document) rendered directly
 * in the pane instead of a webview — it has no URL.
 */
export type PreviewTarget =
  | {
      /** Whether this points at a working-folder file or a web URL — drives the icon/label. */
      kind: 'file' | 'url'
      /** The URL the preview webview loads: a `file://…` URL for files, or the http(s) URL. */
      url: string
      /** A short human label for the pane header (the relative path, or the URL). */
      title: string
    }
  | {
      /** An in-memory markdown document (e.g. a plan) rendered in the pane, no webview. */
      kind: 'markdown'
      /** The markdown source to render. */
      markdown: string
      /** A short human label for the pane header. */
      title?: string
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
  /**
   * Optional second model to fall over to when the primary model's request fails
   * before emitting any output and its retries are exhausted (or the failure is
   * non-retryable, e.g. the model is gone). Same provider/endpoint — this is "try
   * my other model" on the gateway already configured, not a new connection. Empty
   * (the default) disables failover. Never used mid-stream, so no token is replayed.
   */
  fallbackModel?: string
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
   * Anthropic-shaped gateway). ON by default — structured calls are materially
   * faster and less truncation-prone on agentic runs. When on and unsupported by
   * the backend, the loop falls back to the text protocol automatically.
   */
  nativeTools: boolean
  /**
   * One-time marker for the nativeTools default flip (false → true): settings
   * saved before the flip carry the old default as an explicit `false`, which is
   * indistinguishable from a deliberate opt-out. On the first load after the
   * flip, settings.ts upgrades such a stored `false` to the new default and sets
   * this flag; from then on a stored `false` is respected as a real user choice.
   */
  nativeToolsMigrated?: boolean
  /**
   * The professional agent driving the Research surface (see shared/agent-catalog):
   * an id from that catalog (e.g. `research-assistant`, `frontend-engineer`,
   * `ip-lawyer`). Chosen from the composer's agent picker and persisted globally so a
   * fresh Research chat reopens with the same specialist. An unknown/empty id resolves
   * to the default generalist ({@link DEFAULT_RESEARCH_AGENT_ID}) at run time, so this
   * can never leave Research without a persona. Only consulted when `mode==='research'`.
   */
  researchAgentId: string
  /**
   * Background-autonomy preferences (tray keep-alive + the inbox-check scaffold). All
   * OFF by default, so an older settings file or a partial one merges to "behave exactly
   * as before". See {@link BackgroundSettings}.
   */
  background: BackgroundSettings
  /**
   * Voice-call (Myto Remote) preferences: availability, ring timing, TURN relay,
   * and the permission tier for call-driven command execution. See
   * {@link CallSettings}.
   */
  call: CallSettings
  /**
   * What the active model produces (Feature B). Absent/`undefined` means "auto-detect from
   * the model id" — the safe default, under which every current chat model stays a chat
   * model and nothing changes. Set it explicitly to `'image'` or `'video'` to force the
   * media-generation path for a BYOK endpoint whose model id doesn't advertise its kind.
   * See providers/model-kind and {@link ModelKind}.
   */
  modelKind?: ModelKind
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
 * What kind of thing the active model produces (Feature B). A plain `chat` model
 * streams text (every existing model); an `image`/`video` model turns the prompt into
 * a picture or clip instead. Persisted on {@link ProviderSettings.modelKind}; when unset
 * or `'auto'` the main process infers it from the model id (see providers/model-kind).
 * This is what lets one BYOK endpoint drive text OR media generation — Myto is
 * model-agnostic, so the turn's shape follows the model, not a hardcoded assumption.
 */
export type ModelKind = 'chat' | 'image' | 'video'

/**
 * A piece of media a generation model produced (Feature B) — the image/video answer to
 * a prompt, carried out-of-band to the renderer on {@link CompletionChunk.media} and shown
 * inline in the reply. Either `dataBase64` (bytes we fetched, the common `b64_json` case)
 * or `url` (a link the provider returned) is present; `dataBase64` is preferred because it
 * survives the provider expiring its temporary URLs.
 */
export interface GeneratedMedia {
  /** Whether this is a still image or a video clip. */
  kind: 'image' | 'video'
  /** MIME type, e.g. 'image/png' | 'video/mp4'. */
  mediaType: string
  /** The bytes, base64-encoded (no `data:...;base64,` prefix). Present for fetched media. */
  dataBase64?: string
  /** A URL the provider returned, when it gave a link instead of bytes. */
  url?: string
  /** The prompt that produced it, kept for the caption / alt text. */
  prompt?: string
  /**
   * Workspace-relative path of the on-disk file these bytes were read from,
   * when the media was produced locally (an FFmpeg edit result). Rides along
   * so the reply can offer an "Open folder" action; the main process
   * re-validates it against the working folder before revealing anything.
   */
  localPath?: string
}

// EDITOR_TYPES_MARKER

/**
 * The "watch Myto edit" feature (Build mode): a dedicated Editor pane that opens when Myto
 * edits a photo or video and animates HOW it edits — a Lightroom-style panel for photos, a
 * CapCut-style timeline for videos — then shows the REAL FFmpeg-baked result. The types
 * below are the wire + choreography model, all pure (no Electron, no renderer).
 */

/** A point on a tone curve, normalized 0..1 on both axes (x = input level, y = output). */
export interface CurvePoint {
  /** Input level, 0 (black) .. 1 (white). */
  x: number
  /** Output level the curve maps `x` to, 0..1. */
  y: number
}

/** The eight HSL colour bands Lightroom exposes (and the renderer draws as wheels). */
export type HslBand = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta'

/** A per-band HSL tweak; each field is -100..100 with 0 = unchanged. */
export interface HslAdjust {
  /** Hue rotation for this band. */
  hue: number
  /** Saturation change for this band. */
  sat: number
  /** Luminance change for this band. */
  lum: number
}

/** A crop rectangle in normalized 0..1 coordinates relative to the source frame. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A full Lightroom-style photo adjustment set. Every Basic field is -100..100 with 0 =
 * neutral; the renderer animates each from its neutral baseline to the target (so the user
 * watches the slider glide + the live preview respond), and `photo-core.ts` maps the whole
 * set to ONE FFmpeg filter chain for the authoritative bake.
 */
export interface PhotoAdjust {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  /** White balance: warm (+) / cool (−). */
  temp: number
  /** Tint: magenta (+) / green (−). */
  tint: number
  vibrance: number
  saturation: number
  clarity: number
  /** Output sharpening amount, 0..100. */
  sharpen: number
  /** Vignette: darken (−) / lighten (+) the corners. */
  vignette: number
  /** Optional explicit tone curve — RGB composite and/or per channel, points sorted by x. */
  curve?: { rgb?: CurvePoint[]; r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] }
  /** Optional per-band HSL mixer; omitted bands are neutral. */
  hsl?: Partial<Record<HslBand, HslAdjust>>
  /** Optional crop rectangle (normalized). */
  crop?: CropRect
  /** Optional rotation in degrees (clockwise). */
  rotate?: number
}
// EDITOR_TYPES_MARKER2

/** Which editor panel a step addresses — drives the active UI tab and where the cursor goes. */
export type EditorPanel = 'basic' | 'curve' | 'hsl' | 'crop' | 'timeline' | 'text' | 'audio' | 'effects'

/** A kept segment of the source video on the timeline's video track (times in seconds). */
export interface EditorClip {
  id: string
  track: 'video'
  /** Position on the output timeline. */
  startSec: number
  endSec: number
  /** Where this clip maps into the source media. */
  sourceStartSec: number
  sourceEndSec: number
  /** Playback speed multiplier (1 = normal). */
  speed?: number
  /** A named colour-grade/filter preset applied to the clip. */
  grade?: string
  label?: string
}

/** A styled caption/title block on the text track (times in seconds). */
export interface EditorTextClip {
  id: string
  track: 'text'
  startSec: number
  endSec: number
  text: string
  /** Normalized 0..1 position of the text anchor. */
  x?: number
  y?: number
  fontSize?: number
  color?: string
  /** Draw a background box behind the text. */
  box?: boolean
}

/** A block on the audio track (the source audio or added music). */
export interface EditorAudioClip {
  id: string
  track: 'audio'
  startSec: number
  endSec: number
  label?: string
  /** Volume percent, 0..200. */
  volume?: number
  muted?: boolean
}

/** One track in the CapCut-style timeline. */
export interface EditorTrack {
  kind: 'video' | 'text' | 'audio'
  clips: Array<EditorClip | EditorTextClip | EditorAudioClip>
}

/** The whole timeline the VideoEditor renders and the playhead sweeps across. */
export interface EditorTimeline {
  durationSec: number
  tracks: EditorTrack[]
}
// EDITOR_TYPES_MARKER3

/**
 * One choreography step — the atomic "thing Myto does" that the renderer animates so the
 * user watches the edit happen. Each references a control by a SEMANTIC id (e.g.
 * 'exposure', 'clip-0', 'text-1'); the renderer owns the pixel geometry (it looks up the
 * control's live DOM rect to glide the virtual cursor there). `atMs` is the step's start on
 * the animation clock; `durationMs` how long it animates. Discriminated on `type`.
 */
export type EditorStep =
  | { type: 'panel-switch'; panel: EditorPanel; atMs: number }
  | { type: 'cursor-move'; control: string; atMs: number; durationMs: number }
  | { type: 'set-slider'; control: string; from: number; to: number; atMs: number; durationMs: number }
  | { type: 'draw-curve'; channel: 'rgb' | 'r' | 'g' | 'b'; points: CurvePoint[]; atMs: number; durationMs: number }
  | { type: 'set-hsl'; band: HslBand; field: 'hue' | 'sat' | 'lum'; from: number; to: number; atMs: number; durationMs: number }
  | { type: 'playhead'; from: number; to: number; atMs: number; durationMs: number }
  | { type: 'add-clip'; clip: EditorClip; atMs: number }
  | { type: 'split'; track: string; atSec: number; atMs: number }
  | { type: 'add-text'; clip: EditorTextClip; atMs: number }
  | { type: 'transition'; name: string; atSec: number; atMs: number }
  | { type: 'render'; atMs: number }

/**
 * The full choreography an `edit_photo`/`edit_video` call produces — the ordered steps the
 * renderer plays to animate the edit, plus (video) the timeline it builds up. Pure, built by
 * `editor-script-core.ts`; `totalMs` is the wall-clock length of the whole animation.
 */
export interface EditorScript {
  kind: 'photo' | 'video'
  steps: EditorStep[]
  /** The CapCut timeline (video kind only). */
  timeline?: EditorTimeline
  totalMs: number
  /** The target photo adjustment (photo kind) so the renderer can show the final values. */
  target?: PhotoAdjust
}

/**
 * An out-of-band event from an `edit_photo`/`edit_video` run that drives the live Editor
 * pane (Build mode) — the "watch Myto edit" channel. Carried on {@link
 * CompletionChunk.editor}; never blocks the loop. `sourcePreview`/`resultPreview` are full
 * `data:image/...;base64,...` URLs ready for an `<img src>`. Discriminated on `phase`:
 *  - open: the pane opens on the source still (a downscaled photo, or a video poster frame).
 *  - script: the choreography to animate.
 *  - progress: FFmpeg bake progress, a 0..100 render bar.
 *  - baked: the REAL result still, plus for video the workspace path + a `file://` url the
 *    Preview pane can play.
 *  - error: the edit failed; the pane shows the message.
 */
export type EditorEvent =
  | {
      phase: 'open'
      kind: 'photo' | 'video'
      title: string
      sourcePreview: string
      width?: number
      height?: number
      durationSec?: number
    }
  | { phase: 'script'; script: EditorScript }
  | { phase: 'progress'; pct: number; label: string }
  | {
      phase: 'baked'
      kind: 'photo' | 'video'
      resultPreview: string
      outputPath?: string
      url?: string
    }
  | { phase: 'error'; message: string }

// ── Myto Studio: manual editing (user-driven) + agent self-correction ──────────
//
// The same Lightroom/CapCut surfaces the agent drives, but opened and operated BY THE
// USER. The renderer talks to the main process over `window.myto.editor` (EditorApi): it
// opens a source still, bakes the authoritative result with the SAME ffmpeg cores the
// agent uses, and (when a vision-capable model is configured) asks Myto to critique the
// baked result against a goal so it can self-correct. All wire-shaped (no Electron here).

/** A workspace media file the Studio picker lists. */
export interface StudioMediaItem {
  /** Workspace-relative path (POSIX separators). */
  path: string
  kind: 'photo' | 'video'
}

/** Result of opening a source file in the Studio: a downscaled preview + source metadata. */
export interface StudioOpenResult {
  /** `data:image/jpeg;base64,…` downscaled still (photo) or poster frame (video). */
  preview: string
  width?: number
  height?: number
  /** Video only: source duration in seconds (for the timeline scale). */
  durationSec?: number
}

/** The aspect ratios the Studio reframe control offers (mirrors ffmpeg-core's AspectRatio). */
export type StudioAspect = '9:16' | '16:9' | '1:1' | '4:5' | '4:3' | '3:4' | '2:1'

/**
 * One video operation the manual Studio timeline builds — a renderer-facing mirror of the
 * main-process `EditOp` (ffmpeg-core.ts). The renderer builds these from UI gestures; the
 * main process re-validates with `validateEditPlan` before baking, so this is a convenience
 * shape, not a trust boundary.
 */
export type StudioVideoOp =
  | { op: 'trim'; start: number; end: number }
  | { op: 'speed'; factor: number }
  | { op: 'resize'; aspect: StudioAspect; mode: 'crop' | 'pad' | 'stretch' }
  | { op: 'volume'; factor: number }
  | { op: 'mute' }
  | { op: 'filter'; name: string }
  | {
      op: 'colorGrade'
      brightness?: number
      contrast?: number
      saturation?: number
      gamma?: number
      temperature?: number
      tint?: number
    }
  | {
      op: 'text'
      text: string
      start?: number
      end?: number
      x?: number | string
      y?: number | string
      fontSize?: number
      color?: string
      box?: boolean
    }
  | { op: 'transition'; name: string; durationSec: number }

/** A video edit plan the renderer sends to `bakeVideo` (re-validated main-side). */
export interface StudioVideoPlan {
  input: string
  output?: string
  operations: StudioVideoOp[]
}

/** Progress tick for a Studio bake (main → renderer), keyed by the renderer-supplied jobId. */
export interface StudioBakeProgress {
  jobId: string
  pct: number
  label: string
}

/** The authoritative result of a Studio bake (or a failure message). */
export type StudioBakeResult =
  | { ok: true; outputPath: string; resultPreview: string; url?: string }
  | { ok: false; error: string }

/**
 * A vision critique request: given the baked result still + the user's goal and the edit
 * applied so far, ask the configured (vision-capable) model whether it matches and, if not,
 * for a corrected adjust/plan. The engine of "fix a mistake instantly".
 */
export interface StudioCritiqueRequest {
  goal: string
  kind: 'photo' | 'video'
  /** data: URL of the current baked result (photo still / video poster frame). */
  resultPreview: string
  /** The adjust (photo) or plan (video) applied so far, for the model's context. */
  current: PhotoAdjust | StudioVideoPlan
  /** 1-based pass number, so the critique can be stricter/looser as it iterates. */
  pass: number
}

/** The critique verdict. `ok:false` means no vision model was available (see `reason`). */
export interface StudioCritiqueResult {
  ok: boolean
  /** Myto's short, user-facing note on what it changed / still needs fixing (or ''). */
  note: string
  /** True when the result already satisfies the goal — stop iterating. */
  done: boolean
  /** A corrected adjust (photo kind) to re-bake, when `ok && !done`. */
  adjust?: PhotoAdjust
  /** A corrected plan (video kind) to re-bake, when `ok && !done`. */
  plan?: StudioVideoPlan
  /** Why vision was unavailable, when `ok:false`. */
  reason?: string
}

/**
 * The manual-Studio surface on `window.myto.editor`. Open a source, bake with the shared
 * ffmpeg cores, and optionally critique the result. `bakePhoto`/`bakeVideo` stream progress
 * on {@link onBakeProgress} keyed by the caller's `jobId`.
 */
export interface EditorApi {
  /** List workspace image + video files the Studio can open (capped, sorted). */
  listMedia: () => Promise<StudioMediaItem[]>
  /** Open a photo: downscaled still + dimensions, or null if it can't be read. */
  openPhoto: (path: string) => Promise<StudioOpenResult | null>
  /** Bake a photo with the authoritative ffmpeg chain; resolves the result or an error. */
  bakePhoto: (path: string, adjust: PhotoAdjust, jobId: string, output?: string) => Promise<StudioBakeResult>
  /** Open a video: poster frame + dimensions + duration, or null if it can't be read. */
  openVideo: (path: string) => Promise<StudioOpenResult | null>
  /** Grab a single poster frame of a video at `atSec` as a data: URL (for timeline scrubbing). */
  frameAt: (path: string, atSec: number) => Promise<string | null>
  /** Bake a video edit plan; resolves the result (with a file:// url to play) or an error. */
  bakeVideo: (plan: StudioVideoPlan, jobId: string) => Promise<StudioBakeResult>
  /** Ask a vision-capable model to critique a baked result against the goal (self-correction). */
  critique: (req: StudioCritiqueRequest) => Promise<StudioCritiqueResult>
  /** Subscribe to bake-progress ticks (filter by your jobId). Returns an unsubscribe fn. */
  onBakeProgress: (cb: (p: StudioBakeProgress) => void) => () => void
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
   * A file the agent just created/edited/deleted (Cowork), derived from the same
   * `ctx.onFileSnapshot` capture that powers rewind. Present only on the chunk that
   * reports it (empty `delta`); the renderer upserts it into the live Working-tree
   * pane. Non-blocking like {@link preview}. Absent otherwise.
   */
  fileChange?: FileChange
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
  /**
   * True on the terminal chunk ({@link done}) when the model stopped because it hit its
   * OUTPUT-token limit (OpenAI `finish_reason:"length"`, Anthropic `stop_reason:"max_tokens"`)
   * — a cut-off mid-answer, not a finished reply. The main-process agentic loop reads this to
   * auto-continue the truncated write (re-issue the cut-off call, instruct chunking) instead
   * of mistaking the partial output for a completed turn. Absent on every non-truncated stop.
   */
  truncated?: boolean
  /**
   * Media a generation model produced this turn (Feature B) — the image(s)/video that
   * answer the prompt when the active model is an `image`/`video` model, or the rasterized
   * document pages a vision tool rendered (A2b). Carried out-of-band on its own chunk (empty
   * `delta`); the renderer shows each item inline in the reply and (for generated answers)
   * the main process also persists them as attachments. Absent on ordinary text turns.
   */
  media?: GeneratedMedia[]
  /**
   * An event from a live photo/video edit (Build mode), raised by `edit_photo`/`edit_video`.
   * Present only on the chunk that reports it (empty `delta`); the renderer drives the Editor
   * pane with it (open → script → progress → baked). Non-blocking like {@link preview}.
   * Absent on every turn that isn't a watchable media edit.
   */
  editor?: EditorEvent
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
 * A single file mutation surfaced to the live Working-tree pane (Build mode). Unlike
 * {@link FileSnapshot} it carries no file bytes — only the workspace-relative path
 * (forward-slashed), the kind, and `+added −removed` line counts (whole-version
 * counts, matching the inline file cards). The pane fetches the actual before/after
 * text on demand via {@link SessionsApi.fileDiff} when a file is clicked.
 */
export interface FileChange {
  /** Workspace-relative path with forward slashes (e.g. `src/app.ts`). */
  path: string
  /** Whether the file was created/overwritten, edited in place, or deleted. */
  kind: FileSnapshotKind
  /** Lines in the new version (0 for a delete). */
  added: number
  /** Lines in the prior version (0 for a fresh create). */
  removed: number
}

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
  /**
   * The before/after text of the most recent change to a working-folder file, for the
   * Working-tree pane's click-to-diff (Build mode). `path` is workspace-relative (as a
   * {@link FileChange} carries it); main reconstructs the absolute path against the
   * current working folder and reads the latest `file_snapshots` row for it. Any saved
   * credential values are scrubbed from the result (defence-in-depth). `null` when no
   * snapshot exists for that path. A fresh create returns `{ before: '', … }`; a delete
   * returns `{ …, after: '' }`.
   */
  fileDiff: (sessionId: string, path: string) => Promise<{ before: string; after: string } | null>
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
  /** Reveal a working-folder file in the OS file manager (the "Open folder" action). */
  revealInFolder: (path: string) => void
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
  /**
   * Open the standalone "Setup Myto Browser" window — an interactive browser on the
   * same persistent profile (`persist:myto-inapp-browser`) the in-app browser tools
   * drive. The user logs into Gmail / WhatsApp / Facebook / Telegram / etc. by hand
   * once; those cookies persist, so Myto reuses the sessions when it later browses on
   * their behalf. Resolves once the window is shown (focuses it if already open).
   */
  openBrowserSetup: () => Promise<void>
}

/**
 * A saved credential as it is SAFE to show the renderer and the model: the service
 * slug, a human label, the NAMES of the environment variables it carries, the command
 * scopes that trigger injection, and a usage note — but never the secret values. The
 * values live only in the main process's encrypted store (credential-vault.ts); this is
 * the only credential shape that ever crosses the IPC boundary outward.
 */
export interface CredentialMeta {
  /** Service slug the credential is filed under (e.g. "github", "vercel"). */
  site: string
  /** Human label shown in the UI (defaults to the site). */
  label: string
  /** The names of the environment variables this credential sets (values withheld). */
  varNames: string[]
  /** Command program names that trigger injection (e.g. ["git","gh"]). */
  scopes: string[]
  /** Free-text note on how/when this credential is used. */
  usageNote: string
}

/**
 * The input the renderer (masked Settings form) or the `save_credential` tool hands to
 * the vault to store a credential. This is the ONE direction a secret value travels over
 * IPC — renderer → main → encrypted store — and it never comes back out: reads return
 * {@link CredentialMeta}. `scopes` may be omitted (the vault defaults them from the site).
 */
export interface CredentialInput {
  /** Service name; normalised to a slug by the vault. */
  site: string
  /** Optional human label (defaults to the slug). */
  label?: string
  /** The environment variables to inject, with their secret values. */
  env: Record<string, string>
  /** Optional command program names that trigger injection; defaulted from the site when absent. */
  scopes?: string[]
  /** Optional note on how/when this credential is used. */
  usageNote?: string
}

/**
 * The credential vault surface. Lets the Settings pane list, save, and delete per-site
 * credentials. {@link save} and {@link delete} resolve the resulting {@link CredentialMeta}
 * list so the UI replaces its state in one step. Values are write-only: they go in through
 * {@link save} and are never returned.
 */
export interface CredentialsApi {
  /** List saved credentials as metadata (names + scopes + usage, never values). */
  list: () => Promise<CredentialMeta[]>
  /** Save (or replace) one site's credential; resolves the updated meta list. */
  save: (input: CredentialInput) => Promise<CredentialMeta[]>
  /** Delete one site's credential; resolves the updated meta list. */
  delete: (site: string) => Promise<CredentialMeta[]>
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

// ---------------------------------------------------------------------------
// Voice calls (Myto Remote): wire types crossing the call IPC boundary. The
// main process orchestrates; the renderer hosts the Chromium WebRTC peer.
// ---------------------------------------------------------------------------

/** A WebRTC ICE server description (STUN or TURN). */
export interface CallIceServer {
  urls: string[]
  username?: string
  credential?: string
}

/** Main → renderer: drive the renderer-hosted WebRTC peer. */
export type CallPeerControl =
  | {
      action: 'init'
      callId: string
      role: 'offerer' | 'answerer'
      iceServers: CallIceServer[]
      /** When true, record the phone's mic track and stream it back for transcription. */
      sttEnabled: boolean
    }
  | { action: 'set-remote'; callId: string; description: { type: 'offer' | 'answer'; sdp: string } }
  | { action: 'add-ice'; callId: string; candidate: unknown }
  | { action: 'tts-play'; callId: string; sentenceId: number; mp3Base64: string; sentence: string }
  | { action: 'tts-stop'; callId: string }
  | { action: 'send-dc'; callId: string; json: string }
  | { action: 'ice-restart'; callId: string }
  | { action: 'close'; callId: string }

/** Renderer → main: peer events (signaling, data channel, playback, stats). */
export type CallPeerEvent =
  | { callId: string; kind: 'local-description'; description: { type: 'offer' | 'answer'; sdp: string } }
  | { callId: string; kind: 'ice'; candidate: unknown }
  | { callId: string; kind: 'dc-open' }
  | { callId: string; kind: 'dc-message'; json: string }
  | { callId: string; kind: 'dc-closed' }
  | { callId: string; kind: 'peer-state'; state: 'connected' | 'disconnected' | 'failed' | 'closed' }
  | { callId: string; kind: 'tts-playing' }
  | { callId: string; kind: 'tts-idle' }
  | { callId: string; kind: 'stats'; rttMs: number; quality: 'direct' | 'relay' | 'unknown' }
  | { callId: string; kind: 'error'; detail: string }
  | { callId: string; kind: 'stt-audio'; audioBase64: string; mime: string }

/** Main → renderer: call lifecycle status (the header indicator). */
export type CallStatusEvent =
  | { state: 'idle' }
  | { state: 'ringing'; callId: string; direction: 'm2d' | 'd2m' }
  | { state: 'connecting'; callId: string }
  | { state: 'active'; callId: string }
  | { state: 'ended'; callId: string; outcome?: string; detail?: string }

/** A task started from a call, as surfaced in the desktop UI. */
export interface CallTaskSummary {
  id: string
  status: string
  summary: string
  prompt: string
  createdAt: number
}

/** Snapshot for late-mounting call UI. */
export interface CallSnapshot {
  available: boolean
  activeCallId: string | null
  tasks: CallTaskSummary[]
  /**
   * The pairing deep link for this desktop (`myto://call?desktop=…&name=…`).
   * Rendered as a QR code in Settings › Calls: the phone's camera opens Myto
   * and instantly places the first call; after that the Call tab works alone.
   * Empty when not signed in.
   */
  pairLink: string
}

/** Renderer-facing API for the voice-call system. */
export interface CallApi {
  /** Forward the signed-in Firebase ID token (bootstraps main's Firestore access). */
  authSync: (idToken: string) => Promise<{ uid: string | null }>
  /** Snapshot of call availability + active call + recent tasks. */
  getState: () => Promise<CallSnapshot>
  /** Subscribe to call lifecycle changes. Returns an unsubscribe fn. */
  onStatus: (callback: (event: CallStatusEvent) => void) => () => void
  /** Main asks for a fresh token (401 recovery). */
  onAuthNeeded: (callback: () => void) => () => void
  /** WebRTC control commands from main. Returns an unsubscribe fn. */
  onPeerControl: (callback: (msg: CallPeerControl) => void) => () => void
  /** Send a peer event back to main. */
  peerEvent: (event: CallPeerEvent) => void
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
  /** Kill every in-flight agent stream and background dev server (new-task teardown). */
  cancelAll: () => Promise<void>
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
  /** Voice calls (Myto Remote): auth sync + the renderer-hosted WebRTC peer. */
  call: CallApi
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
  /** Credential vault: list/save/delete per-site secrets Myto injects into matching terminal commands. */
  credentials: CredentialsApi
  /** Myto Studio: open/bake/critique photos + videos the USER edits by hand (and self-correction). */
  editor: EditorApi
  /** Assistant: the policy-gated computer-use personal assistant (Windows first). Optional — absent in shims/tests. */
  assistant?: AssistantApi
}

// ---------------------------------------------------------------------------
// Assistant (computer-use personal assistant)
// ---------------------------------------------------------------------------

/** The policy + host state the Assistant pane renders. */
export interface AssistantStatusResult {
  accepted: boolean
  policyVersion: number
  platform: string
  hostReady: boolean
  policy: string
}

export interface AssistantTestResult {
  ok: boolean
  detail: string
  ms: number
}

export interface AssistantComposeResult {
  ok: boolean
  draft?: string
  detail: string
}

export interface AssistantSkillSummary {
  name: string
  goal: string
  steps: number
  createdAt: string
}

export interface AssistantApi {
  status: () => Promise<AssistantStatusResult>
  accept: () => Promise<AssistantStatusResult>
  disable: () => Promise<AssistantStatusResult>
  testAction: () => Promise<AssistantTestResult>
  compose: (req: { contact: string; intent: string; history?: Array<{ from: 'me' | 'them'; text: string }> }) => Promise<AssistantComposeResult>
  deliver: (req: { text: string; windowTitle?: string; pressEnter?: boolean }) => Promise<{ ok: boolean; detail: string }>
  learnStart: (req: { goal: string }) => Promise<{ ok: boolean; detail: string }>
  learnStop: (req: { name: string }) => Promise<{ ok: boolean; detail: string; steps?: unknown[] }>
  practice: (req: { name: string }) => Promise<{ skill: string; ok: boolean; steps: Array<{ index: number; action: string; ok: boolean; detail: string }>; detail: string }>
  skillsList: () => Promise<AssistantSkillSummary[]>
  skillRemove: (req: { name: string }) => Promise<boolean>
  mailGetConfig: () => Promise<{ host: string; port: number; secure: boolean; user: string; name?: string; from?: string } | null>
  mailSend: (req: {
    config: { host: string; port: number; secure: boolean; user: string; pass?: string; from?: string; name?: string }
    message: { to: string; subject: string; body: string; cc?: string }
    save?: boolean
  }) => Promise<{ ok: boolean; transcript: string; messageId?: string }>
  /** LAN bridge so the phone can reach this PC's assistant (token-guarded, off by default). */
  bridgeGet: () => Promise<{ enabled: boolean; running: boolean; port: number; token: string; urls: string[] }>
  bridgeSet: (req: { enabled: boolean; port?: number }) => Promise<{ enabled: boolean; running: boolean; port: number; token: string; urls: string[] }>
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
