// The bring-your-own-key editor, shown on the /authentication page for a signed-in user (beside the
// device dashboard). It reads and writes the account's chat config at users/{uid}/config/byok:
// the OpenAI-compatible base URL, the API key, how the key is attached, and the list of models the
// user wants to use. These models — and only these — power chat in the website /chat, the desktop
// app, and the mobile app. Owner-only, per firestore.rules.

import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { CheckCircle2, LoaderCircle, Plus, Trash2 } from 'lucide-react';
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

const INPUT =
  'w-full rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-[14px] text-[#141413] outline-none transition-colors duration-150 placeholder:text-[#a8a397] focus:border-[#141413]';
const LABEL = 'mb-1.5 block text-[13px] font-medium text-[#544f46]';
const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-[#141413] px-4 py-2.5 text-[14px] font-medium text-white transition-colors duration-150 hover:bg-[#2b2a27] disabled:cursor-not-allowed disabled:opacity-60';
const GHOST_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-[13px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7]';
const ERROR_BOX =
  'rounded-lg border border-[#e4b8a8] bg-[#f9ede8] px-3 py-2 text-[13px] leading-relaxed text-[#8a3b22]';

const SCHEMAS: { value: ByokAuthSchema; label: string }[] = [
  { value: 'bearer', label: 'Bearer token (Authorization)' },
  { value: 'header', label: 'Custom header' },
  { value: 'none', label: 'No auth header' },
];

export function ByokPanel({ uid }: { uid: string }) {
  const [config, setConfig] = useState<ByokConfig>(emptyByokConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

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

  const save = useCallback(async () => {
    setError(null);
    setSaving(true);
    // Normalise + drop empty model rows before writing.
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
        <div className="mb-2 flex items-center justify-between">
          <span className={LABEL + ' mb-0'}>Models</span>
          <button type="button" onClick={addModel} className={GHOST_BTN}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add model
          </button>
        </div>

        {config.models.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#e4e1d8] bg-[#fbfaf7] px-3 py-4 text-center text-[13px] text-[#9c988e]">
            No models yet. Add at least one to start chatting.
          </p>
        ) : (
          <div className="space-y-2">
            {config.models.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={INPUT}
                  placeholder="Model id (e.g. gpt-4o-mini)"
                  value={m.id}
                  onChange={(e) => setModel(i, 'id', e.target.value)}
                />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={INPUT}
                  placeholder="Display name"
                  value={m.name}
                  onChange={(e) => setModel(i, 'name', e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => removeModel(i)}
                  aria-label="Remove model"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#e4e1d8] bg-white text-[#8a3b22] transition-colors duration-150 hover:border-[#e4b8a8] hover:bg-[#f9ede8]"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
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

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving} className={PRIMARY_BTN}>
          {saving ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save models'
          )}
        </button>
        {saved ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-[#3f7a4f]">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Saved
          </span>
        ) : null}
      </div>
    </div>
  );
}
