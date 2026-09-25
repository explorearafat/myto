// The bring-your-own-key editor, shown on the /authentication page for a signed-in user (beside the
// device dashboard). It reads and writes the account's chat config at users/{uid}/config/byok:
// the OpenAI-compatible base URL, the API key, how the key is attached, and the list of models the
// user wants to use. These models — and only these — power chat in the website /chat, the desktop
// app, and the mobile app. Owner-only, per firestore.rules.
//
// Models can be added two ways: "Sync models" asks the provider for its catalogue through the
// same-origin /api/models proxy (which reuses the gateway's SSRF guard and never logs the key) and
// lets the user multi-select; or a row can be added by hand. "Test connection" runs that same
// round-trip purely to confirm the endpoint + key are reachable and authorized.

import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { CheckCircle2, LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { db } from '../lib/firebase';
import {
  BYOK_DOC,
  emptyByokConfig,
  normalizeByokConfig,
  type ByokAuthSchema,
  type ByokConfig,
} from '../shared/byok';

/** Reject a hung Firestore call instead of spinning forever (mirrors src/lib/auth.tsx). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The four fields the /api/models proxy needs — a subset of the full config. */
type ModelsProbe = Pick<ByokConfig, 'baseUrl' | 'apiKey' | 'authSchema' | 'authHeaderName'>;

type ModelsResult = { ok: true; ids: string[] } | { ok: false; reason: string };

/**
 * Ask the same-origin gateway proxy for the provider's model list. A success (200 with ids) doubles
 * as a connection test: it proves the endpoint is reachable and the key authorized. Never throws.
 */
async function fetchModels(probe: ModelsProbe): Promise<ModelsResult> {
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(probe),
    });
    const data = (await res.json().catch(() => null)) as
      | { models?: { id?: unknown }[]; error?: string; status?: number }
      | null;
    if (!res.ok) {
      const status = data?.status;
      const reason =
        data?.error === 'bad_base_url'
          ? 'Check the base URL — it must be a public HTTPS endpoint.'
          : status === 401 || status === 403
            ? 'The provider rejected the API key.'
            : 'Couldn’t reach the provider. Check the URL and try again.';
      return { ok: false, reason };
    }
    const raw = data && Array.isArray(data.models) ? data.models : [];
    const ids: string[] = [];
    for (const m of raw) {
      const id = m?.id;
      if (typeof id === 'string' && id) ids.push(id);
    }
    return { ok: true, ids };
  } catch {
    return { ok: false, reason: 'Network error — couldn’t reach the provider.' };
  }
}

const INPUT =
  'w-full rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-[14px] text-[#141413] outline-none transition-colors duration-150 placeholder:text-[#a8a397] focus:border-[#141413]';
const LABEL = 'mb-1.5 block text-[13px] font-medium text-[#544f46]';
const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-[#141413] px-4 py-2.5 text-[14px] font-medium text-white transition-colors duration-150 hover:bg-[#2b2a27] disabled:cursor-not-allowed disabled:opacity-60';
const GHOST_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-[13px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7] disabled:cursor-not-allowed disabled:opacity-60';
const ERROR_BOX =
  'rounded-lg border border-[#e4b8a8] bg-[#f9ede8] px-3 py-2 text-[13px] leading-relaxed text-[#8a3b22]';

const SCHEMAS: { value: ByokAuthSchema; label: string }[] = [
  { value: 'bearer', label: 'Bearer token (Authorization)' },
  { value: 'header', label: 'Custom header' },
  { value: 'none', label: 'No auth header' },
];

/** Usage metering isn't built yet, so per-model stats are honest placeholders. */
const PLACEHOLDER = 'Not tracked yet';

export function ByokPanel({ uid }: { uid: string }) {
  const [config, setConfig] = useState<ByokConfig>(emptyByokConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  // "Test connection" state — a one-line pass/fail under the buttons.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // "Sync models" modal state.
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [fetchedIds, setFetchedIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});

  // Load the account's saved config once.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const snap = await withTimeout(
          getDoc(doc(db, 'users', uid, BYOK_DOC.col, BYOK_DOC.id)),
          12000,
          'Config read',
        );
        if (live && snap.exists()) setConfig(normalizeByokConfig(snap.data()));
      } catch (e) {
        console.warn('[myto] BYOK config read failed:', e);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [uid]);

  const set = useCallback(<K extends keyof ByokConfig>(key: K, value: ByokConfig[K]) => {
    setSaved(false);
    setTestResult(null);
    setConfig((c) => ({ ...c, [key]: value }));
  }, []);

  const setModel = useCallback((i: number, field: 'id' | 'name', value: string) => {
    setSaved(false);
    setConfig((c) => ({
      ...c,
      models: c.models.map((m, j) => (j === i ? { ...m, [field]: value } : m)),
    }));
  }, []);

  const addModel = useCallback(() => {
    setSaved(false);
    setConfig((c) => ({ ...c, models: [...c.models, { id: '', name: '' }] }));
  }, []);

  const removeModel = useCallback((i: number) => {
    setSaved(false);
    setConfig((c) => ({ ...c, models: c.models.filter((_, j) => j !== i) }));
  }, []);

  const probe = useCallback(
    (): ModelsProbe => ({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      authSchema: config.authSchema,
      authHeaderName: config.authHeaderName,
    }),
    [config.baseUrl, config.apiKey, config.authSchema, config.authHeaderName],
  );

  const testConnection = useCallback(async () => {
    if (!config.baseUrl.trim()) {
      setTestResult({ ok: false, text: 'Enter a base URL first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const r = await fetchModels(probe());
    setTestResult(
      r.ok
        ? {
            ok: true,
            text: `Connected — ${r.ids.length} model${r.ids.length === 1 ? '' : 's'} available.`,
          }
        : { ok: false, text: 'reason' in r ? r.reason : 'Couldn’t reach the provider.' },
    );
    setTesting(false);
  }, [config.baseUrl, probe]);

  const openSync = useCallback(async () => {
    if (!config.baseUrl.trim()) {
      setTestResult({ ok: false, text: 'Enter a base URL first.' });
      return;
    }
    setSyncOpen(true);
    setSyncing(true);
    setSyncError(null);
    setFetchedIds([]);
    setSelected({});
    setNames({});
    const r = await fetchModels(probe());
    if (r.ok) setFetchedIds(r.ids);
    else if ('reason' in r) setSyncError(r.reason);
    setSyncing(false);
  }, [config.baseUrl, probe]);

  const closeSync = useCallback(() => setSyncOpen(false), []);

  // Add every checked id that isn't already in the list, with its display name (defaulting to the id).
  const addSelected = useCallback(() => {
    setSaved(false);
    setConfig((c) => {
      const have = new Set(c.models.map((m) => m.id));
      const additions = fetchedIds
        .filter((id) => selected[id] && !have.has(id))
        .map((id) => ({ id, name: (names[id] || '').trim() || id }));
      return additions.length ? { ...c, models: [...c.models, ...additions] } : c;
    });
    setSyncOpen(false);
  }, [fetchedIds, selected, names]);

  // Close the modal on Escape.
  useEffect(() => {
    if (!syncOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSyncOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [syncOpen]);

  const save = useCallback(async () => {
    setError(null);
    setSaving(true);
    const next = normalizeByokConfig({ ...config, updatedAt: Date.now() });
    try {
      await withTimeout(
        setDoc(doc(db, 'users', uid, BYOK_DOC.col, BYOK_DOC.id), next, { merge: true }),
        15000,
        'Config save',
      );
      setConfig(next);
      setSaved(true);
    } catch (e) {
      console.warn('[myto] BYOK config save failed:', e);
      setError('Couldn’t save. If this keeps happening, the security rules may not be published yet.');
    } finally {
      setSaving(false);
    }
  }, [config, uid]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[14px] text-[#6b675e]">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your models…
      </div>
    );
  }

  const newCount = fetchedIds.filter((id) => selected[id]).length;
  const busy = saving || testing;

  return (
    <div className="space-y-5">
      <div>
        <label className={LABEL} htmlFor="byok-base">
          Base URL
        </label>
        <input
          id="byok-base"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
          placeholder="https://api.openai.com/v1"
          value={config.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
        <p className="mt-1.5 text-[12px] leading-relaxed text-[#9c988e]">
          An OpenAI-compatible endpoint. Must be public HTTPS — local or private addresses are
          rejected.
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor="byok-key">
          API key
        </label>
        <div className="flex items-center gap-2">
          <input
            id="byok-key"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            className={INPUT}
            placeholder="sk-…"
            value={config.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className={GHOST_BTN + ' shrink-0'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="byok-schema">
            Auth method
          </label>
          <select
            id="byok-schema"
            className={INPUT}
            value={config.authSchema}
            onChange={(e) => set('authSchema', e.target.value as ByokAuthSchema)}
          >
            {SCHEMAS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {config.authSchema === 'header' ? (
          <div>
            <label className={LABEL} htmlFor="byok-header">
              Header name
            </label>
            <input
              id="byok-header"
              type="text"
              autoComplete="off"
              spellCheck={false}
              className={INPUT}
              placeholder="x-api-key"
              value={config.authHeaderName}
              onChange={(e) => set('authHeaderName', e.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className={LABEL + ' mb-0'}>Models</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={openSync} className={GHOST_BTN}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Sync models
            </button>
            <button type="button" onClick={addModel} className={GHOST_BTN}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add manually
            </button>
          </div>
        </div>

        {config.models.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#e4e1d8] bg-[#fbfaf7] px-3 py-6 text-center text-[13px] text-[#9c988e]">
            No models yet. Sync from your provider, or add one by hand, to start chatting.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {config.models.map((m, i) => (
              <div key={i} className="relative rounded-xl border border-[#e4e1d8] bg-white p-3">
                <button
                  type="button"
                  onClick={() => removeModel(i)}
                  aria-label="Remove model"
                  className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-[#b3afa4] transition-colors duration-150 hover:bg-[#f9ede8] hover:text-[#8a3b22]"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Model name"
                  className="w-full truncate bg-transparent pr-6 text-[14px] font-medium text-[#141413] outline-none placeholder:text-[#a8a397]"
                  placeholder={m.id || 'Display name'}
                  value={m.name}
                  onChange={(e) => setModel(i, 'name', e.target.value)}
                />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Model id"
                  className="mt-0.5 w-full truncate bg-transparent font-mono text-[11px] text-[#6b675e] outline-none placeholder:text-[#bdb9ae]"
                  placeholder="model-id"
                  value={m.id}
                  onChange={(e) => setModel(i, 'id', e.target.value)}
                />
                <div className="mt-2 space-y-1 border-t border-[#eceae2] pt-2">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-[#b3afa4]">
                      Last used
                    </div>
                    <div className="text-[11px] text-[#9c988e]">{PLACEHOLDER}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-[#b3afa4]">
                      Total tokens
                    </div>
                    <div className="text-[11px] text-[#9c988e]">{PLACEHOLDER}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-[12px] leading-relaxed text-[#9c988e]">
          The model id is sent to your provider; the display name is what you see in the picker. A
          row with an empty id is dropped on save.
        </p>
      </div>

      {error ? <p className={ERROR_BOX}>{error}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className={PRIMARY_BTN}>
          {saving ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save models'
          )}
        </button>
        <button type="button" onClick={testConnection} disabled={busy} className={GHOST_BTN}>
          {testing ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Testing…
            </>
          ) : (
            'Test connection'
          )}
        </button>
        {saved ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-[#3f7a4f]">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Saved
          </span>
        ) : null}
        {testResult ? (
          <span
            className={
              'inline-flex items-center gap-1.5 text-[13px] ' +
              (testResult.ok ? 'text-[#3f7a4f]' : 'text-[#8a3b22]')
            }
          >
            {testResult.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : null}
            {testResult.text}
          </span>
        ) : null}
      </div>

      {syncOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[#141413]/40 p-4"
          onClick={closeSync}
        >
          <div
            className="chat-in w-full max-w-md rounded-2xl border border-[#e4e1d8] bg-[#faf9f5] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-[18px] font-normal leading-tight text-[#141413]">
                  Sync models
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-[#6b675e]">
                  Models your provider reports. Select the ones to add.
                </p>
              </div>
              <button
                type="button"
                onClick={closeSync}
                aria-label="Close"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#6b675e] transition-colors duration-150 hover:bg-[#f0eee6]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 max-h-[45vh] overflow-y-auto">
              {syncing ? (
                <div className="flex items-center justify-center gap-2 py-10 text-[14px] text-[#6b675e]">
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Asking your provider…
                </div>
              ) : syncError ? (
                <p className={ERROR_BOX}>{syncError}</p>
              ) : fetchedIds.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[#e4e1d8] bg-[#fbfaf7] px-3 py-6 text-center text-[13px] text-[#9c988e]">
                  Your provider returned no models.
                </p>
              ) : (
                <ul className="space-y-2">
                  {fetchedIds.map((id) => {
                    const already = config.models.some((m) => m.id === id);
                    return (
                      <li key={id} className="rounded-lg border border-[#e9e6dd] bg-white p-2.5">
                        <label className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={already || !!selected[id]}
                            disabled={already}
                            onChange={(e) => setSelected((s) => ({ ...s, [id]: e.target.checked }))}
                            className="h-4 w-4 shrink-0 accent-[#141413]"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#141413]">
                            {id}
                          </span>
                          {already ? (
                            <span className="shrink-0 rounded-full bg-[#f0eee6] px-2 py-0.5 text-[11px] text-[#6b675e]">
                              Added
                            </span>
                          ) : null}
                        </label>
                        {!already && selected[id] ? (
                          <input
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            className={INPUT + ' mt-2'}
                            placeholder={`Display name (defaults to ${id})`}
                            value={names[id] || ''}
                            onChange={(e) => setNames((n) => ({ ...n, [id]: e.target.value }))}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="mt-5 flex items-center justify-end gap-3">
              <button type="button" onClick={closeSync} className={GHOST_BTN}>
                Cancel
              </button>
              <button
                type="button"
                onClick={addSelected}
                disabled={newCount === 0}
                className={PRIMARY_BTN}
              >
                Add {newCount > 0 ? newCount : ''} {newCount === 1 ? 'model' : 'models'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
