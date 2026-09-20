// The user's bring-your-own-key (BYOK) chat configuration: their own OpenAI-compatible endpoint,
// API key, and the models they want to use. This is the single source of truth for which model
// powers chat across ALL three clients — the website /chat, the desktop app, and the mobile app.
//
// Stored in Firestore at users/{uid}/config/byok (a fixed-id doc in a `config` subcollection,
// owner-only via firestore.rules). It lives OUTSIDE the profile document so the secret apiKey never
// rides along with the frequently-read UserProfile.
//
// This is a LOCAL COPY of the repo-root src/shared/byok.ts, kept in sync by hand. The desktop app's
// tsconfig (tsconfig.web.json) only includes src/renderer/src and src/shared, so the root module is
// outside rootDir and can't be imported directly — a small duplicated type module is the low-risk
// choice. The `ByokAuthSchema` values are identical to the desktop `AuthSchema` in ./types, and a
// ByokConfig maps 1:1 onto a GatewayConfig.

/** How the API key is attached to upstream requests. Mirrors the desktop AuthSchema vocabulary. */
export type ByokAuthSchema = 'bearer' | 'header' | 'none'

/** One model the user has added: the id sent to the API, and a display name for the picker. */
export interface ByokModel {
  /** The identifier sent to the provider, e.g. 'gpt-4o-mini', 'claude-3-5-sonnet'. */
  id: string
  /** The human-facing name shown in the model picker. */
  name: string
}

/** The full BYOK configuration for one account. */
export interface ByokConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1. Must be public HTTPS. */
  baseUrl: string
  /** The user's own secret API key. */
  apiKey: string
  /** How `apiKey` is attached: Authorization: Bearer, a custom header, or none. */
  authSchema: ByokAuthSchema
  /** Header name used only when authSchema === 'header' (e.g. 'x-api-key'). */
  authHeaderName: string
  /** The models the user has added; the picker lists these and only these. */
  models: ByokModel[]
  /** Epoch ms of the last save. */
  updatedAt: number
}

/** Firestore location of the config doc: users/{uid}/config/byok. */
export const BYOK_DOC = { col: 'config', id: 'byok' } as const

/** An empty config, used as a safe default. */
export function emptyByokConfig(): ByokConfig {
  return {
    baseUrl: '',
    apiKey: '',
    authSchema: 'bearer',
    authHeaderName: 'Authorization',
    models: [],
    updatedAt: 0
  }
}

/** True when the config can actually drive a chat: a base URL and at least one model. */
export function isByokConfigured(c?: ByokConfig | null): boolean {
  return !!c && !!c.baseUrl.trim() && c.models.length > 0
}

/**
 * Coerce an unknown value (a Firestore doc, a request body) into a well-formed ByokConfig, dropping
 * anything malformed. Never throws — callers get a usable object with sane fallbacks.
 */
export function normalizeByokConfig(raw: unknown): ByokConfig {
  const base = emptyByokConfig()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const schema = r.authSchema
  return {
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '',
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    authSchema: schema === 'header' || schema === 'none' ? schema : 'bearer',
    authHeaderName:
      typeof r.authHeaderName === 'string' && r.authHeaderName.trim()
        ? r.authHeaderName.trim()
        : 'Authorization',
    models: Array.isArray(r.models)
      ? r.models
          .filter(
            (m): m is ByokModel =>
              !!m && typeof (m as ByokModel).id === 'string' && typeof (m as ByokModel).name === 'string'
          )
          .map((m) => ({ id: m.id.trim(), name: m.name.trim() }))
          .filter((m) => m.id)
      : [],
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0
  }
}
