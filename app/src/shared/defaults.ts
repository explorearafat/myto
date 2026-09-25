import type { ProviderSettings } from './types'

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
    terminalConsent: false
  },
  // No connectors until the user adds one (Settings › Connectors). Each is an MCP
  // server whose tools Myto can call once connected.
  mcpServers: [],
  // No skills until the user adds one (Settings › Skills).
  skills: [],
  // No plugins until the user installs one (Settings › Plugins).
  plugins: [],
  // Balanced default; the composer's effort control changes it.
  reasoningEffort: 'medium',
  // Myto's normal writing voice; the output-style picker (#13) changes it.
  outputStyle: 'default',
  // Text-protocol tool calling by default (#15); native function-calling is an
  // opt-in for capable backends and never changes behaviour while off.
  nativeTools: false
}
