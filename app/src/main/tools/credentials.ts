/**
 * The credential-vault TOOLS — the model-facing half of "give Myto a secret once, and it
 * uses it for your terminal tasks." The actual encryption + filesystem live in the Electron
 * runtime (../credential-vault.ts) behind the ctx callbacks wired in provider-ipc.ts; these
 * tools only shape the model's fields and format a SAFE confirmation. The cardinal rule: a
 * secret VALUE never appears in anything these tools return — `save_credential` echoes only
 * the variable NAMES and scopes it stored, and `list_credentials` returns metadata only. The
 * values flow one way (into the encrypted store) and come back only as process env for a
 * matching command, never as text. Gated by {@link fsAvailable}: a credential is scoped to the
 * working folder it is saved in, so the tools are neither advertised nor runnable without one.
 * When the vault callbacks are absent (unit tests, non-Electron), each degrades to a plain note.
 */
import { toErrorMessage } from '../providers/http'
import type { ToolDef } from './registry'
import type { CredentialInput, CredentialMeta, ToolSideEffect } from '../../shared/types'
import { fsAvailable } from './fs'
import { slugifySite } from '../credential-vault-core'

/** Mutating tools flag 'write' so Cowork's permission prompt covers them. */
const WRITE: ToolSideEffect = 'write'

/** The call's input as a plain record (never an array/null), so field reads are safe. */
function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}
/** A trimmed non-empty string, or null. */
function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
/** Coerce the model's `env` field to a string→string map (drop non-string values). */
function readEnv(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val
    }
  }
  return out
}
/** Coerce the model's `scopes` field to a string[] (or undefined so the vault defaults it). */
function readScopes(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const s = v.filter((x): x is string => typeof x === 'string')
  return s.length ? s : undefined
}

/** The note a tool returns when the vault runtime is absent (e.g. unit tests, non-Electron). */
function needsVault(tool: string): string {
  return `${tool} needs Myto's credential vault, which isn't available in this context.`
}

/** One safe line describing a stored credential: label, var NAMES, scopes, usage — never a value. */
function describeMeta(m: CredentialMeta): string {
  const vars = m.varNames.join(', ') || '(none)'
  const scopes = m.scopes.join(', ') || '(none)'
  const note = m.usageNote ? ` — ${m.usageNote}` : ''
  return `• ${m.label} [${m.site}]: sets ${vars}; injected for ${scopes}${note}`
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export const saveCredentialTool: ToolDef = {
  name: 'save_credential',
  description:
    'Securely store a per-site credential (API token, etc.) so Myto can inject it into matching terminal commands later. The value is encrypted at rest and NEVER shown again — not to you, not to the user. Prefer pointing the user to Settings › Credentials for pasting secrets; only use this when they ask you to save one.',
  usage: '{"site": "github", "env": {"GH_TOKEN": "<token>"}, "scopes": ["git", "gh"], "usageNote": "push + gh CLI"}',
  sideEffect: WRITE,
  schema: {
    type: 'object',
    properties: {
      site: { type: 'string' },
      label: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      scopes: { type: 'array', items: { type: 'string' } },
      usageNote: { type: 'string' }
    },
    required: ['site', 'env']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const site = readStr(o.site)
    if (!site) return 'save_credential needs a "site" name, e.g. "github" or "vercel".'
    const env = readEnv(o.env)
    if (!Object.keys(env).length) {
      return 'save_credential needs an "env" object of VARIABLE:value pairs, e.g. {"GH_TOKEN": "…"}.'
    }
    if (!ctx.saveCredential) return needsVault('save_credential')
    const credInput: CredentialInput = {
      site,
      label: readStr(o.label) ?? undefined,
      env,
      scopes: readScopes(o.scopes),
      usageNote: readStr(o.usageNote) ?? undefined
    }
    try {
      const metas = ctx.saveCredential(credInput)
      // Report what was stored by NAME only — locate the just-saved site in the returned list.
      const slug = slugifySite(site)
      const saved = metas.find((m) => m.site === slug)
      const varNames = saved ? saved.varNames.join(', ') : Object.keys(env).join(', ')
      const scopes = saved ? saved.scopes.join(', ') : '(default)'
      return (
        `Saved the "${slug}" credential. Myto will inject ${varNames} into commands run with: ${scopes}. ` +
        `The value is encrypted and never shown again — just run the normal command (e.g. \`git push\`) and Myto supplies it. ` +
        `(${metas.length} credential${metas.length === 1 ? '' : 's'} saved for this folder.)`
      )
    } catch (err) {
      return `save_credential failed: ${toErrorMessage(err)}`
    }
  }
}

export const listCredentialsTool: ToolDef = {
  name: 'list_credentials',
  description:
    'List the credentials saved for this working folder — the sites, variable NAMES, scopes, and usage notes. Never returns the secret values (there is no way to read them back).',
  usage: '{}',
  available: fsAvailable,
  async run(_input, ctx) {
    if (!ctx.listCredentialMeta) return needsVault('list_credentials')
    try {
      const metas = ctx.listCredentialMeta()
      if (!metas.length) {
        return 'No credentials are saved for this folder yet. Save one with save_credential, or in Settings › Credentials.'
      }
      return [`${metas.length} saved credential${metas.length === 1 ? '' : 's'}:`, ...metas.map(describeMeta)].join('\n')
    } catch (err) {
      return `list_credentials failed: ${toErrorMessage(err)}`
    }
  }
}

export const deleteCredentialTool: ToolDef = {
  name: 'delete_credential',
  description: "Delete a saved credential by its site slug (e.g. \"github\"). Removes the encrypted blob for that site.",
  usage: '{"site": "github"}',
  sideEffect: WRITE,
  schema: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] },
  available: fsAvailable,
  async run(input, ctx) {
    const site = readStr(obj(input).site)
    if (!site) return 'delete_credential needs the "site" slug of the credential to remove.'
    if (!ctx.deleteCredential) return needsVault('delete_credential')
    try {
      const slug = slugifySite(site)
      const metas = ctx.deleteCredential(site)
      const stillThere = metas.some((m) => m.site === slug)
      return stillThere
        ? `delete_credential: "${slug}" could not be removed.`
        : `Deleted the "${slug}" credential. ${metas.length} credential${metas.length === 1 ? '' : 's'} remain.`
    } catch (err) {
      return `delete_credential failed: ${toErrorMessage(err)}`
    }
  }
}

/** The three credential-vault tools, registered together in the registry. */
export const credentialTools: readonly ToolDef[] = [saveCredentialTool, listCredentialsTool, deleteCredentialTool]

