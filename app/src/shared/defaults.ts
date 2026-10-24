import type { ProviderSettings } from './types'
import { DEFAULT_RESEARCH_AGENT_ID } from './agent-catalog'

/** Ollama's default local endpoint. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

/**
 * Baseline provider settings used on first launch and as the merge target when
 * reading a partial/old settings file. Kept in `shared` so the main-process
 * settings store and the renderer store agree on the same starting shape.
 */
export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  activeProvider: 'ollama',
  ollama: {
    baseUrl: DEFAULT_OLLAMA_BASE_URL
  },
  gateway: {
    baseUrl: '',
    apiKey: '',
    authSchema: 'bearer',
    authHeaderName: 'Authorization'
  },
  // No model is chosen on first launch — the user picks one from the provider's
  // list (or types an id in settings). Empty here so nothing is shown until then.
  modelName: '',
  modelId: '',
  // No failover target until the user names one; empty disables it.
  fallbackModel: '',
  ui: {
    // Warm light is the default; the dark toggle overrides it.
    theme: 'light',
    // Plain chat is the starting mode; a new chat then remembers whichever mode
    // the user last switched to (Task 7).
    lastMode: 'chat'
  },
  tools: {
    // Read-only web tools (fetch/search/wiki) are on out of the box; running code
    // on the user's machine is a separate, explicit opt-in (Settings › Tools).
    enabled: true,
    codeExecution: false
  },
  cowork: {
    // No working folder until the user picks one; Cowork's filesystem tools stay
    // dormant while this is empty (see main/tools/fs.ts).
    workspaceDir: '',
    // Ask before every side-effecting tool by default — the safe tier. The user
    // can raise it to auto-approve edits or bypass permissions from the composer.
    permissionMode: 'ask',
    // No verify command by default — the verify gate (#16) is opt-in; set e.g.
    // `npm test` to make Cowork prove its work before declaring a task done.
    verifyCommand: '',
    // Plan mode (#8) off by default — a run acts immediately rather than stopping
    // for plan approval before the first write.
    planMode: false,
    // No lifecycle hooks by default (#9) — both are an arbitrary-exec surface.
    hooks: { preToolUse: '', postToolUse: '' },
    // Interactive terminal (#2) locked by default — the real PTY shell runs commands
    // with no per-call approval, so the Shell tab shows a consent panel until the
    // user opts in once here.
    terminalConsent: false,
    // Browser control (Track 2) off by default — opt-in like code execution. The user
    // picks `in-app` (Myto's sandboxed browser) or `system-chrome` (their real Chrome,
    // real logins) in Settings › Cowork; until then the browser tools stay hidden.
    browserTarget: 'off'
  },
  // No connectors until the user adds one (Settings › Connectors). Each is an MCP
  // server whose tools Myto can call once connected.
  mcpServers: [],
  // No skills until the user adds one (Settings › Skills).
  skills: [],
  // No plugins until the user installs one (Settings › Plugins).
  plugins: [],
  // Speed-first default: on reasoning models every step of effort is hidden
  // thinking that delays the first visible word. Low keeps answers snappy; the
  // composer's effort control raises it when a task genuinely needs depth.
  reasoningEffort: 'low',
  // Myto's normal writing voice; the output-style picker (#13) changes it.
  outputStyle: 'default',
  // Native function-calling by default (#15): structured tool calls spare the model
  // re-emitting verbose ```myto:tool fences every turn — a real latency and
  // truncation win on agentic runs — and both adapter shapes support them, with
  // automatic fallback to the text protocol when a backend can't. settings.ts
  // upgrades settings saved before this flip exactly once (nativeToolsMigrated).
  nativeTools: true,
  // The Research surface opens on the default generalist; the composer's agent
  // picker swaps in any of the 300+ professional specialists (shared/agent-catalog).
  researchAgentId: DEFAULT_RESEARCH_AGENT_ID,
  // Background autonomy fully OFF by default — closing the last window quits the app
  // exactly as before. The tray keep-alive and the inbox-check scaffold are sticky
  // opt-ins; the inbox flag stays inert until a mail connector + consent exist, and
  // may only ever draft (never auto-send) replies.
  background: {
    keepAliveInTray: false,
    inboxEvery10min: false
  }
}
