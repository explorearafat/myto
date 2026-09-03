import type { BrowserPermissions, ProviderSettings } from './types'

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
    // Balanced reasoning by default; the composer effort selector overrides it.
    effort: 'medium',
    // Plan-first is opt-in so ordinary chats aren't slowed by a plan.md step.
    planFirst: false,
    // Cowork (chat-only) is the default so casual questions never jump to the
    // terminal; the user switches to Code to work on a folder.
    mode: 'cowork'
  },
  // No automation hooks until the user adds some (Phase 4).
  hooks: {}
}

/**
 * Default AI-control permissions for browsing (requirement: never let the AI
 * silently perform highly sensitive actions). Observing and low-risk navigation
 * are allowed so Sylor is useful out of the box; anything that mutates state,
 * sends a message, or spends money starts gated. Payment is `block` by default —
 * the strongest posture — and the UI never lets it drop below `ask`.
 */
export const DEFAULT_BROWSER_PERMISSIONS: BrowserPermissions = {
  read: 'allow',
  navigate: 'allow',
  click: 'ask',
  fill: 'ask',
  send: 'ask',
  delete: 'ask',
  payment: 'block'
}
