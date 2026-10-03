import type { CredentialInput, CredentialMeta } from '../shared/types'

/**
 * The credential vault's PURE core — no Electron, no filesystem, no secrets at rest.
 * It owns every decision that can be reasoned about and unit-tested in isolation: how a
 * site name becomes a slug, which programs a shell command will launch, whether a stored
 * credential's scopes match that command, how matching credentials' env is merged, how a
 * secret value is masked out of model-facing text, and how a credential is (de)serialized
 * for the encrypted-at-rest blob. The Electron half (credential-vault.ts) adds
 * safeStorage + fs on top; the ToolDefs (tools/credentials.ts) and the stream loop
 * (provider-ipc.ts) drive it.
 *
 * Security intent: a secret VALUE lives only inside a {@link StoredCredential}.env and the
 * encrypted blob. {@link CredentialMeta} — what ever reaches the model, the renderer, or a
 * log — carries variable NAMES and scopes but never a value. {@link redactSecrets} is the
 * backstop that scrubs any value that still slips into a tool's output.
 */

/** The mask a redacted secret collapses to in any model-facing text. */
export const REDACTION_MASK = '••••'

/** Shortest secret value worth masking — below this, redaction would eat ordinary words. */
const MIN_SECRET_LEN = 4

/**
 * A stored credential, VALUES INCLUDED. This is the main-process-only shape that lives in
 * the encrypted blob; it must never cross the IPC boundary to the renderer or be handed to
 * the model — use {@link toMeta} for that.
 */
export interface StoredCredential {
  /** Service slug the credential is filed under (e.g. "github", "vercel"). Unique key. */
  site: string
  /** Human label shown in the UI (defaults to the site). */
  label: string
  /** Environment variables injected into a matching command — the secret bearer. */
  env: Record<string, string>
  /** Command program names that trigger injection (e.g. ["git","gh"] or ["vercel"]). */
  scopes: string[]
  /** Free-text note on how/when this credential is used (model-visible via meta). */
  usageNote: string
  /** ISO timestamp the credential was saved. */
  createdAt: string
}

/**
 * Sensible default scopes for well-known services, so saving a "github" or "vercel"
 * credential auto-injects into the right programs without the user naming scopes by hand.
 * Only consulted when the input provides no scopes. Keys are site slugs.
 */
const DEFAULT_SCOPES_BY_SITE: Record<string, string[]> = {
  github: ['git', 'gh'],
  gh: ['git', 'gh'],
  gitlab: ['git', 'glab'],
  bitbucket: ['git'],
  vercel: ['vercel'],
  netlify: ['netlify', 'ntl'],
  heroku: ['heroku', 'git'],
  npm: ['npm', 'npx'],
  aws: ['aws'],
  docker: ['docker'],
  gcloud: ['gcloud'],
  fly: ['fly', 'flyctl'],
  supabase: ['supabase'],
  railway: ['railway'],
  render: ['render'],
  cloudflare: ['wrangler']
}

/** Keywords that prefix a command without BEING the program — skipped when finding it. */
const COMMAND_PREFIXES = new Set([
  'sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs', 'builtin', 'then', 'do'
])

/** Lowercase a free-form site/service name into a filesystem- and key-safe slug. */
export function slugifySite(name: string): string {
  return (typeof name === 'string' ? name : '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Reduce one path-or-name token to a bare lowercased program name (basename, no ext). */
function programName(token: string): string {
  let t = token.trim().replace(/^["']+|["']+$/g, '') // strip surrounding quotes
  t = t.replace(/^[(){}]+/, '') // strip a leading subshell/brace glued to the program
  if (!t) return ''
  const base = t.split(/[/\\]/).pop() ?? t // basename across both separators
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase()
}

/**
 * The program names a shell command would launch. The command is split on the shell
 * operators that start a new command — `&&`, `||`, `|`, `;`, `&`, and newlines — and each
 * segment's leading program is taken, skipping env-assignment prefixes (`GH_TOKEN=x git …`)
 * and wrapper keywords (`sudo`, `env`, `nohup`, …). Used only to decide credential scope
 * matching, so arguments are irrelevant and never parsed. Best-effort by design: a program
 * we miss simply means a credential isn't injected (fail-safe — never over-injects).
 */
export function commandPrograms(command: string): string[] {
  if (typeof command !== 'string' || !command.trim()) return []
  const segments = command.split(/\n|&&|\|\||[|;&]/)
  const found: string[] = []
  for (const seg of segments) {
    for (const token of seg.trim().split(/\s+/).filter(Boolean)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue // VAR=value assignment prefix
      const name = programName(token)
      if (!name) continue
      if (COMMAND_PREFIXES.has(name)) continue // a wrapper — the real program is next
      found.push(name)
      break // the first real program of this segment is enough
    }
  }
  return [...new Set(found)]
}

/** Normalise a scope token the same way {@link commandPrograms} normalises programs. */
function normScope(s: string): string {
  return typeof s === 'string' ? programName(s) : ''
}

/** Whether any of a command's `programs` is named in the credential's `scopes`. */
export function scopeMatches(programs: string[], scopes: string[]): boolean {
  if (!programs.length || !scopes.length) return false
  const want = new Set(scopes.map(normScope).filter(Boolean))
  return programs.some((p) => want.has(p))
}

/**
 * Merge the env of every credential whose scopes match a program in `command`. First
 * writer wins on a variable-name collision (deterministic; a later credential never
 * silently overrides an earlier one) and each real collision is reported in `collisions`
 * for the caller to surface. The returned `env` is exactly the secrets that may appear in
 * this command's child process — the set the redactor needs to scrub.
 */
export function envForCommand(
  creds: StoredCredential[],
  command: string
): { env: Record<string, string>; collisions: string[] } {
  const programs = commandPrograms(command)
  const env: Record<string, string> = {}
  const collisions: string[] = []
  for (const cred of creds) {
    if (!scopeMatches(programs, cred.scopes)) continue
    for (const [k, v] of Object.entries(cred.env)) {
      if (k in env) {
        if (env[k] !== v && !collisions.includes(k)) collisions.push(k)
        continue
      }
      env[k] = v
    }
  }
  return { env, collisions }
}

/**
 * Replace every injected secret value — and its percent-encoded form, since a token can
 * appear URL-encoded in a remote URL or error — with {@link REDACTION_MASK}. Masks
 * longest-first so a value that is a substring of another doesn't leave a tail exposed, and
 * skips values under {@link MIN_SECRET_LEN} so short, word-like values can't blank out
 * ordinary output. The one scrubber for all model-facing text.
 */
export function redactSecrets(text: string, values: Iterable<string>): string {
  if (typeof text !== 'string' || !text) return text
  const variants = new Set<string>()
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_SECRET_LEN) continue
    variants.add(v)
    try {
      const enc = encodeURIComponent(v)
      if (enc !== v && enc.length >= MIN_SECRET_LEN) variants.add(enc)
    } catch {
      // A malformed value that can't be URL-encoded — the raw form is still masked.
    }
  }
  if (!variants.size) return text
  let out = text
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTION_MASK)
  }
  return out
}

/** Strip a stored credential down to its model-/renderer-safe metadata (no values). */
export function toMeta(cred: StoredCredential): CredentialMeta {
  return {
    site: cred.site,
    label: cred.label,
    varNames: Object.keys(cred.env),
    scopes: cred.scopes,
    usageNote: cred.usageNote
  }
}

/** Current on-disk schema version for a serialized credential blob. */
const CREDENTIAL_SCHEMA_VERSION = 1

/** Serialize a credential to the version-tagged JSON stored inside the encrypted blob. */
export function serializeCredential(cred: StoredCredential): string {
  return JSON.stringify({ v: CREDENTIAL_SCHEMA_VERSION, cred })
}

/** Validate an env map: string→non-empty-string, keys are valid env var names. null if empty. */
function sanitizeEnv(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue // not a usable env var name
    if (typeof v !== 'string' || !v) continue // no empty / non-string values
    env[key] = v
  }
  return Object.keys(env).length ? env : null
}

/**
 * Parse a version-tagged credential blob back to a {@link StoredCredential}, or null if it's
 * unreadable or shaped wrong (a corrupt or foreign file degrades to "no credential" rather
 * than throwing). Validates every field so a tampered blob can't inject a non-string into
 * env or scopes.
 */
export function deserializeCredential(json: string): StoredCredential | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const outer = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  const raw =
    outer && typeof outer.cred === 'object' && outer.cred ? (outer.cred as Record<string, unknown>) : null
  if (!raw) return null
  const site = typeof raw.site === 'string' ? raw.site : ''
  if (!site) return null
  const env = sanitizeEnv(raw.env)
  if (!env) return null
  const scopes = Array.isArray(raw.scopes)
    ? [...new Set(raw.scopes.filter((s): s is string => typeof s === 'string').map(normScope).filter(Boolean))]
    : []
  return {
    site,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : site,
    env,
    scopes,
    usageNote: typeof raw.usageNote === 'string' ? raw.usageNote : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString()
  }
}

/**
 * Validate and normalise raw save input into a {@link StoredCredential}, or return an
 * `{ error }` the tool/UI shows the user. Slugs the site, keeps only valid env vars with
 * non-empty values, lowercases/dedupes scopes (falling back to the service's
 * {@link DEFAULT_SCOPES_BY_SITE} or the slug when none are given), and stamps `createdAt`.
 * `now` is injectable so the pure core stays deterministic under test.
 */
export function normalizeInput(
  input: CredentialInput,
  now: string = new Date().toISOString()
): StoredCredential | { error: string } {
  const site = slugifySite(input?.site ?? '')
  if (!site) return { error: 'A credential needs a site name, e.g. "github" or "vercel".' }
  const env = sanitizeEnv(input?.env)
  if (!env) {
    return {
      error:
        'A credential needs at least one environment variable with a non-empty value, e.g. {"GH_TOKEN": "…"}.'
    }
  }
  const rawScopes = Array.isArray(input?.scopes) ? input.scopes : []
  const scopes = [...new Set(rawScopes.map(normScope).filter(Boolean))]
  const finalScopes = scopes.length ? scopes : DEFAULT_SCOPES_BY_SITE[site] ?? [site]
  const label = typeof input?.label === 'string' && input.label.trim() ? input.label.trim() : site
  const usageNote = typeof input?.usageNote === 'string' ? input.usageNote.trim() : ''
  return { site, label, env, scopes: finalScopes, usageNote, createdAt: now }
}

/** Narrow a {@link normalizeInput} result to its error branch. */
export function isCredentialError(r: StoredCredential | { error: string }): r is { error: string } {
  return 'error' in r
}
