import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AuthSchema,
  GatewayConfig,
  OllamaConfig,
  ProviderKind,
  ProviderSettings,
  TestConnectionResult,
  Theme
} from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

const AUTH_SCHEMA_LABELS: Record<AuthSchema, string> = {
  none: 'None',
  bearer: 'Bearer token',
  header: 'Custom header'
}

/** The Settings window's left-rail categories. */
type SettingsCategory = 'appearance' | 'model' | 'tools'

/** Title + one-line subtitle shown in each category pane's header. */
const CATEGORY_META: Record<SettingsCategory, { label: string; subtitle: string }> = {
  appearance: { label: 'Appearance', subtitle: 'Theme and visual style.' },
  model: { label: 'Model', subtitle: 'Provider connection and the model Sylor talks to.' },
  tools: { label: 'Tools', subtitle: 'What Sylor can do beyond chatting — search the web, run code.' }
}

/** Small monochrome glyph for each category, tinted by the nav's active state. */
function CategoryIcon({ id }: { id: SettingsCategory }): ReactNode {
  switch (id) {
    case 'appearance':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" />
        </svg>
      )
    case 'model':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'tools':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M10.8 2.6a2.8 2.8 0 0 0-3.6 3.6l-4.4 4.4a1.1 1.1 0 1 0 1.6 1.6l4.4-4.4a2.8 2.8 0 0 0 3.6-3.6l-1.7 1.7-1.5-.4-.4-1.5 1.7-1.7z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      )
  }
}

const CATEGORY_ORDER: SettingsCategory[] = ['model', 'tools', 'appearance']

// ─────────────────────────────────────────────────────────────────────────────
// Reusable controls
// ─────────────────────────────────────────────────────────────────────────────

/** A settings row: title (+ optional description) on the left, a control on the right. */
function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text">{title}</div>
        {description && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** A segmented control for a small enum (theme…). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-lg border border-border bg-bg p-0.5">
      {options.map((opt) => {
        const active = opt.id === value
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={
              'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ' +
              (active ? 'bg-primary text-bg shadow-sm' : 'text-muted hover:text-text')
            }
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/** A labelled text field matching the workspace's form styling. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password'
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-muted/60 focus:border-primary/70"
      />
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  )
}

/** Segmented two-option toggle used for the provider tabs. */
function ProviderTabs({
  value,
  onChange
}: {
  value: ProviderKind
  onChange: (kind: ProviderKind) => void
}) {
  const tabs: Array<{ id: ProviderKind; label: string; sub: string }> = [
    { id: 'ollama', label: 'Ollama', sub: 'Local · offline' },
    { id: 'gateway', label: 'Gateway', sub: 'Remote · REST API' }
  ]
  return (
    <div className="grid grid-cols-2 gap-2">
      {tabs.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={
              'flex flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors ' +
              (active
                ? 'border-primary/70 bg-primary/10'
                : 'border-border bg-surface hover:border-primary/40')
            }
          >
            <span className={'text-[13px] font-semibold ' + (active ? 'text-primary' : 'text-text')}>
              {tab.label}
            </span>
            <span className="text-[11px] text-muted">{tab.sub}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Appearance pane (store-backed; applies immediately)
// ─────────────────────────────────────────────────────────────────────────────

const THEME_OPTIONS: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

/** Appearance pane: color theme. */
function AppearancePane() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <div className="divide-y divide-border">
      <SettingRow
        title="Theme"
        description="Light is a warm paper palette; dark is a low-glare palette. Applies instantly across the app."
      >
        <Segmented
          ariaLabel="Theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={(v) => void setTheme(v)}
        />
      </SettingRow>
    </div>
  )
}

const ON_OFF = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' }
] as const

/** Tools pane: the master tool-use switch and the gated code-execution opt-in. */
function ToolsPane() {
  const tools = useAppStore((s) => s.settings.tools)
  const setTools = useAppStore((s) => s.setTools)
  return (
    <div className="divide-y divide-border">
      <SettingRow
        title="Tool use"
        description="Let Sylor search the web, fetch pages, and look things up on Wikipedia while it answers. Results appear as cards in the chat."
      >
        <Segmented
          ariaLabel="Tool use"
          value={tools.enabled ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setTools({ enabled: v === 'on' })}
        />
      </SettingRow>
      <SettingRow
        title="Run code on this machine"
        description="Allow Sylor to execute python, JavaScript, or bash snippets locally and read the output. This runs code with your account's privileges — only enable it if you trust what you ask for. Off by default; requires Tool use to be on."
      >
        <Segmented
          ariaLabel="Run code on this machine"
          value={tools.codeExecution ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setTools({ codeExecution: v === 'on' })}
        />
      </SettingRow>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The Settings window
// ─────────────────────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const storedSettings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const previewModels = useAppStore((s) => s.previewModels)
  const models = useAppStore((s) => s.models)
  const modelsLoading = useAppStore((s) => s.modelsLoading)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  // The model selector deep-links here via openSettings('model'). The panel is
  // mounted fresh on each open, so seeding the initial category from the
  // requested tab is all it takes to land there.
  const settingsTab = useAppStore((s) => s.settingsTab)

  const [category, setCategory] = useState<SettingsCategory>(settingsTab ?? 'model')

  // Local draft copy so provider/model edits aren't persisted until "Save".
  const [draft, setDraft] = useState<ProviderSettings>(storedSettings)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [saved, setSaved] = useState(false)

  // Re-sync the draft if the persisted settings change under us (e.g. first load).
  useEffect(() => {
    setDraft(storedSettings)
  }, [storedSettings])

  // Auto-discover models the moment there's enough config to try — no "Refresh
  // list" click needed (a base URL + API key is enough). Debounced so it doesn't
  // fire on every keystroke, and it fills in a model automatically when none is
  // chosen yet, so chat works right after Save.
  useEffect(() => {
    const kind = draft.activeProvider
    const config = kind === 'ollama' ? draft.ollama : draft.gateway
    if (!config.baseUrl.trim()) return
    let cancelled = false
    const timer = setTimeout(() => {
      void previewModels(kind, config).then((found) => {
        if (cancelled || found.length === 0) return
        setDraft((d) => {
          // Keep an existing choice (incl. a manually-typed id); only fill a blank.
          if (d.modelId) return d
          return { ...d, modelId: found[0].id, modelName: found[0].name }
        })
      })
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    draft.activeProvider,
    draft.ollama.baseUrl,
    draft.gateway.baseUrl,
    draft.gateway.apiKey,
    draft.gateway.authSchema,
    draft.gateway.authHeaderName,
    previewModels
  ])

  const activeConfig: OllamaConfig | GatewayConfig =
    draft.activeProvider === 'ollama' ? draft.ollama : draft.gateway

  const patchOllama = (patch: Partial<OllamaConfig>): void =>
    setDraft((d) => ({ ...d, ollama: { ...d.ollama, ...patch } }))
  const patchGateway = (patch: Partial<GatewayConfig>): void =>
    setDraft((d) => ({ ...d, gateway: { ...d.gateway, ...patch } }))

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.sylor.providers.testConnection(
        draft.activeProvider,
        activeConfig,
        draft.modelId
      )
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleListModels = async (): Promise<void> => {
    // Discover against the current (unsaved) draft config and auto-fill a model
    // if none is chosen. Save persists the choice — this is just a manual re-scan.
    const kind = draft.activeProvider
    const config = kind === 'ollama' ? draft.ollama : draft.gateway
    const found = await previewModels(kind, config)
    if (found.length > 0) {
      setDraft((d) => (d.modelId ? d : { ...d, modelId: found[0].id, modelName: found[0].name }))
    }
  }

  const handleSave = async (): Promise<void> => {
    await saveSettings(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  const modelOptions = useMemo(() => models.map((m) => ({ id: m.id, name: m.name })), [models])
  const meta = CATEGORY_META[category]

  return (
    <div className="absolute inset-0 z-40 flex bg-bg">
      <div className="flex h-full w-full overflow-hidden bg-surface">
        {/* Category rail */}
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-bg p-2">
          <div className="px-2.5 pb-2 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Settings
          </div>
          {CATEGORY_ORDER.map((id) => {
            const active = id === category
            return (
              <button
                key={id}
                type="button"
                onClick={() => setCategory(id)}
                className={
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ' +
                  (active
                    ? 'bg-surface-2 font-medium text-text'
                    : 'text-muted hover:bg-surface-2/60 hover:text-text')
                }
              >
                <span className={active ? 'text-primary' : 'text-muted'}>
                  <CategoryIcon id={id} />
                </span>
                {CATEGORY_META[id].label}
              </button>
            )
          })}
        </nav>

        {/* Content column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-border px-6 py-4">
            <div>
              <h2 className="text-[15px] font-semibold text-text">{meta.label}</h2>
              <p className="mt-0.5 text-[12px] text-muted">{meta.subtitle}</p>
            </div>
            <button
              type="button"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
              className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Scrollable pane. Cap the content to a comfortable reading width and
              center it so forms don't stretch edge-to-edge on wide windows. */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-3xl">
              {category === 'appearance' && <AppearancePane />}

              {category === 'tools' && <ToolsPane />}

              {category === 'model' && (
                <div className="space-y-5">
                  <section className="space-y-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      Active provider
                    </span>
                    <ProviderTabs
                      value={draft.activeProvider}
                      onChange={(activeProvider) => {
                        setDraft((d) => ({ ...d, activeProvider }))
                        setTestResult(null)
                      }}
                    />
                  </section>

                  {draft.activeProvider === 'ollama' ? (
                    <section className="space-y-3">
                      <Field
                        label="Base URL"
                        value={draft.ollama.baseUrl}
                        onChange={(baseUrl) => patchOllama({ baseUrl })}
                        placeholder="http://localhost:11434"
                        hint="Ollama runs locally and works fully offline once a model is pulled."
                      />
                    </section>
                  ) : (
                    <section className="space-y-3">
                      <Field
                        label="Base URL"
                        value={draft.gateway.baseUrl}
                        onChange={(baseUrl) => patchGateway({ baseUrl })}
                        placeholder="https://api.openai.com/v1"
                        hint="OpenAI-compatible endpoint (OpenAI, OpenRouter, Together, local proxy…)."
                      />
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                          Auth schema
                        </span>
                        <div className="grid grid-cols-3 gap-2">
                          {(Object.keys(AUTH_SCHEMA_LABELS) as AuthSchema[]).map((schema) => {
                            const active = draft.gateway.authSchema === schema
                            return (
                              <button
                                key={schema}
                                type="button"
                                onClick={() => patchGateway({ authSchema: schema })}
                                className={
                                  'rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors ' +
                                  (active
                                    ? 'border-primary/70 bg-primary/10 text-primary'
                                    : 'border-border bg-bg text-muted hover:border-primary/40 hover:text-text')
                                }
                              >
                                {AUTH_SCHEMA_LABELS[schema]}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      {draft.gateway.authSchema === 'header' && (
                        <Field
                          label="Header name"
                          value={draft.gateway.authHeaderName}
                          onChange={(authHeaderName) => patchGateway({ authHeaderName })}
                          placeholder="x-api-key"
                        />
                      )}
                      {draft.gateway.authSchema !== 'none' && (
                        <Field
                          label="API key"
                          type="password"
                          value={draft.gateway.apiKey}
                          onChange={(apiKey) => patchGateway({ apiKey })}
                          placeholder="sk-…"
                          hint="Stored locally on this machine; never logged or sent anywhere else."
                        />
                      )}
                    </section>
                  )}

                  {/* Model selection */}
                  <section className="space-y-3 border-t border-border pt-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                        Model selection
                      </span>
                      <button
                        type="button"
                        onClick={handleListModels}
                        disabled={modelsLoading}
                        className="text-[12px] font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
                      >
                        {modelsLoading ? 'Loading…' : 'Refresh list'}
                      </button>
                    </div>

                    {modelOptions.length > 0 && (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                          Available models
                        </span>
                        <select
                          value={modelOptions.some((m) => m.id === draft.modelId) ? draft.modelId : ''}
                          onChange={(e) => {
                            const picked = modelOptions.find((m) => m.id === e.target.value)
                            if (picked)
                              setDraft((d) => ({ ...d, modelId: picked.id, modelName: picked.name }))
                          }}
                          className="rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-primary/70"
                        >
                          <option value="" disabled>
                            Select a model…
                          </option>
                          {modelOptions.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <Field
                        label="Model name"
                        value={draft.modelName}
                        onChange={(modelName) => setDraft((d) => ({ ...d, modelName }))}
                        placeholder="Llama 3.1 8B"
                        hint="Display name shown in the UI."
                      />
                      <Field
                        label="Model ID"
                        value={draft.modelId}
                        onChange={(modelId) => setDraft((d) => ({ ...d, modelId }))}
                        placeholder="llama3.1:8b"
                        hint="Identifier sent to the API."
                      />
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>

          {/* Model pane has its own Test/Save footer (a draft that persists on Save);
              Appearance applies immediately, so it needs no footer. */}
          {category === 'model' && (
            <div className="border-t border-border px-6 py-3.5">
              <div className="mx-auto max-w-3xl space-y-3">
                {testResult && (
                  <div
                    className={
                      'flex items-start gap-2 rounded-md border px-3 py-2.5 text-[12px] ' +
                      (testResult.ok
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-red-500/30 bg-red-500/10 text-red-300')
                    }
                  >
                    <span
                      className={
                        'mt-0.5 h-2 w-2 shrink-0 rounded-full ' +
                        (testResult.ok ? 'bg-emerald-400' : 'bg-red-400')
                      }
                    />
                    <span className="flex-1">
                      {testResult.message}
                      {testResult.latencyMs != null && (
                        <span className="text-muted"> · {testResult.latencyMs}ms</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg px-3.5 py-1.5 text-[13px] font-medium text-text transition-colors hover:border-primary/60 disabled:opacity-50"
                  >
                    {testing ? 'Testing…' : 'Test connection'}
                  </button>
                  <div className="flex items-center gap-2">
                    {saved && <span className="text-[12px] text-emerald-400">Saved</span>}
                    <button
                      type="button"
                      onClick={handleSave}
                      className="rounded-md bg-primary px-4 py-1.5 text-[13px] font-semibold text-bg transition-colors hover:bg-primary/90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
