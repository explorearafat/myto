import { useCallback, useEffect, useState } from 'react'
import type { CredentialMeta } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/*
 * The Credentials settings pane — the masked, write-only face of the credential vault.
 *
 * A credential is a per-site bundle of environment variables (e.g. GH_TOKEN for GitHub)
 * the user saves ONCE. Myto then injects it into terminal commands whose leading program
 * matches the credential's scopes (git/gh get GH_TOKEN; `npm install` never does), so it
 * can push, deploy, and check builds on the user's behalf without the secret ever reaching
 * the model, the chat, or the logs.
 *
 * This pane only ever SENDS values inward: the value boxes are masked (type=password) and
 * write-only, and every read back from the vault is {@link CredentialMeta} — site, label,
 * variable NAMES, scopes, and a usage note, but never a value. The secret is encrypted at
 * rest (safeStorage) under the working folder's git-ignored `.data/<site>/`; everything
 * here talks to window.myto.credentials, which is scoped to that Cowork folder in main.
 */

/** One-click starters for common services: fill the site, label, scopes, and typical var name. */
type Preset = { site: string; label: string; varName: string; scopes: string }
const PRESETS: readonly Preset[] = [
  { site: 'github', label: 'GitHub', varName: 'GH_TOKEN', scopes: 'git, gh' },
  { site: 'vercel', label: 'Vercel', varName: 'VERCEL_TOKEN', scopes: 'vercel' },
  { site: 'gitlab', label: 'GitLab', varName: 'GITLAB_TOKEN', scopes: 'git, glab' },
  { site: 'npm', label: 'npm', varName: 'NPM_TOKEN', scopes: 'npm, npx' },
  { site: 'netlify', label: 'Netlify', varName: 'NETLIFY_AUTH_TOKEN', scopes: 'netlify, ntl' }
]

/** A single VAR → value pair in the add/replace form. The value is masked and write-only. */
type EnvRow = { name: string; value: string }

const FIELD =
  'w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-muted focus:border-primary focus:outline-none'
const LABEL = 'mb-1 block text-[12px] font-medium text-text'

/** Split a comma/space-separated scopes string into a clean list. */
function parseScopes(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The add / replace form for one site's credential. Values are masked and write-only. */
function CredentialForm({
  initial,
  onCancel,
  onSaved
}: {
  initial: CredentialMeta | null
  onCancel: () => void
  onSaved: (metas: CredentialMeta[]) => void
}) {
  const [site, setSite] = useState(initial?.site ?? '')
  const [label, setLabel] = useState(initial && initial.label !== initial.site ? initial.label : '')
  const [scopes, setScopes] = useState(initial?.scopes.join(', ') ?? '')
  const [usageNote, setUsageNote] = useState(initial?.usageNote ?? '')
  const [rows, setRows] = useState<EnvRow[]>(
    initial && initial.varNames.length
      ? initial.varNames.map((name) => ({ name, value: '' }))
      : [{ name: '', value: '' }]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filledRows = rows.filter((r) => r.name.trim() && r.value.trim())
  const canSubmit = site.trim().length > 0 && filledRows.length > 0

  const applyPreset = (p: Preset): void => {
    setSite(p.site)
    setLabel(p.label)
    setScopes(p.scopes)
    setRows([{ name: p.varName, value: '' }])
  }

  const setRow = (i: number, patch: Partial<EnvRow>): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const env: Record<string, string> = {}
      for (const r of filledRows) env[r.name.trim()] = r.value
      const parsed = parseScopes(scopes)
      const metas = await window.myto.credentials.save({
        site: site.trim(),
        label: label.trim() || undefined,
        env,
        scopes: parsed.length ? parsed : undefined,
        usageNote: usageNote.trim() || undefined
      })
      onSaved(metas)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the credential.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg p-4">
      {!initial && (
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.site}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-primary hover:text-text"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Service</label>
          <input
            className={FIELD}
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="github"
            disabled={!!initial}
          />
        </div>
        <div>
          <label className={LABEL}>Label (optional)</label>
          <input
            className={FIELD}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Defaults to the service name"
          />
        </div>
      </div>

      <div>
        <span className={LABEL}>Secrets (environment variables)</span>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={FIELD + ' flex-1 font-mono'}
                value={r.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder="GH_TOKEN"
              />
              <input
                className={FIELD + ' flex-1'}
                type="password"
                autoComplete="off"
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder={initial ? 're-enter the secret value' : 'paste the secret value'}
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:text-rose-500"
                  aria-label="Remove variable"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, { name: '', value: '' }])}
          className="mt-2 text-[11px] font-medium text-muted transition-colors hover:text-text"
        >
          + Add variable
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Scopes (optional)</label>
          <input
            className={FIELD + ' font-mono'}
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            placeholder="git, gh"
          />
        </div>
        <div>
          <label className={LABEL}>Usage note (optional)</label>
          <input
            className={FIELD}
            value={usageNote}
            onChange={(e) => setUsageNote(e.target.value)}
            placeholder="Push + create repos"
          />
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        Scopes are the command programs that trigger injection — leave blank to use sensible
        defaults for the service. The value is encrypted on this machine and never shown again or
        sent to the model; Myto injects it only into matching commands.
      </p>

      {error && (
        <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-500">{error}</div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-text"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!canSubmit || saving}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90 disabled:opacity-40"
        >
          {saving ? 'Saving…' : initial ? 'Replace credential' : 'Save credential'}
        </button>
      </div>
    </div>
  )
}

/** One saved-credential row: masked metadata only (names, scopes, note — never values). */
function CredentialRow({
  cred,
  onReplace,
  onRemove
}: {
  cred: CredentialMeta
  onReplace: () => void
  onRemove: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await onRemove()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border border-border bg-bg p-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-text">{cred.label}</span>
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted">
              {cred.site}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {cred.varNames.map((name) => (
              <span
                key={name}
                className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-text"
              >
                {name}=••••
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
            <span>
              Used for: <span className="font-mono">{cred.scopes.join(', ') || '—'}</span>
            </span>
            {cred.usageNote && <span>{cred.usageNote}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onReplace}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Settings › Credentials pane. Lists saved per-site credentials as masked metadata,
 * hosts the add / replace form, and surfaces a clear hint when no Cowork working folder
 * is chosen (the vault is scoped to that folder's git-ignored `.data/<site>/`).
 */
export function CredentialsPane() {
  const workspaceDir = useAppStore((s) => s.settings.cowork.workspaceDir)
  const [creds, setCreds] = useState<CredentialMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [replacing, setReplacing] = useState<CredentialMeta | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setCreds(await window.myto.credentials.list())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, workspaceDir])

  const onSaved = (metas: CredentialMeta[]): void => {
    setCreds(metas)
    setAdding(false)
    setReplacing(null)
  }

  const onRemove = async (site: string): Promise<void> => {
    setCreds(await window.myto.credentials.delete(site))
  }

  const hasFolder = workspaceDir.trim().length > 0
  const showForm = adding || replacing !== null

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[14px] font-semibold text-text">Credentials</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Save a service token once and Myto reuses it for matching terminal tasks — pushing to
          GitHub, deploying to Vercel, and more. Values are encrypted on this machine, never shown
          again, and never sent to the model.
        </p>
      </div>

      {!hasFolder ? (
        <div className="rounded-xl border border-dashed border-border bg-bg p-4 text-[12px] leading-relaxed text-muted">
          Choose a Cowork working folder first (Settings › Cowork). Credentials are stored inside
          that folder&rsquo;s git-ignored{' '}
          <span className="font-mono text-[11px]">.data/</span> directory, so Myto only reaches them
          while you&rsquo;re working there.
        </div>
      ) : (
        <>
          {showForm ? (
            <CredentialForm
              initial={replacing}
              onCancel={() => {
                setAdding(false)
                setReplacing(null)
              }}
              onSaved={onSaved}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="w-full rounded-xl border border-dashed border-border bg-bg px-3 py-3 text-[12px] font-medium text-muted transition-colors hover:border-primary hover:text-text"
            >
              + Add credential
            </button>
          )}

          {!showForm && (
            <div className="space-y-2">
              {loading ? (
                <p className="px-1 text-[12px] text-muted">Loading…</p>
              ) : creds.length === 0 ? (
                <p className="px-1 text-[12px] text-muted">
                  No credentials saved yet. Add one above, or just ask Myto in chat to save a token.
                </p>
              ) : (
                creds.map((cred) => (
                  <CredentialRow
                    key={cred.site}
                    cred={cred}
                    onReplace={() => setReplacing(cred)}
                    onRemove={() => onRemove(cred.site)}
                  />
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
