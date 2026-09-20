import { useState, type ReactNode } from 'react'
import type { Theme } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/** The Settings window's left-rail categories. */
type SettingsCategory = 'appearance' | 'model' | 'tools'

/** Title + one-line subtitle shown in each category pane's header. */
const CATEGORY_META: Record<SettingsCategory, { label: string; subtitle: string }> = {
  appearance: { label: 'Appearance', subtitle: 'Theme and visual style.' },
  model: { label: 'Model', subtitle: 'The model Sylor talks to, from your Sylor account.' },
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

/** A segmented control for a small enum (theme, on/off…). */
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
// Model pane (read-only mirror of the account's Firestore config)
// ─────────────────────────────────────────────────────────────────────────────

/** Mask an API key so the panel can show it's set without revealing it. */
function maskKey(key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (k.length <= 8) return '••••••••'
  return `${k.slice(0, 3)}••••••••${k.slice(-4)}`
}

/**
 * The model pane is now a read-only summary. The base URL / key / auth scheme and
 * the model list all come from the signed-in account's Firestore config (the same
 * one the website's Authentication page edits), mirrored into the local settings
 * by useAppStore.applyByokConfig. There's nothing to edit here — models are managed
 * on the website.
 */
function ModelPane() {
  const gateway = useAppStore((s) => s.settings.gateway)
  const models = useAppStore((s) => s.models)
  const modelId = useAppStore((s) => s.settings.modelId)
  const configured = gateway.baseUrl.trim().length > 0 && models.length > 0

  return (
    <div className="space-y-5">
      {!configured && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-[12px] leading-relaxed text-amber-500">
          No model is configured for your account yet. Add your endpoint and models on the Sylor
          website → Authentication page, then they'll appear here automatically.
        </div>
      )}

      <section className="space-y-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Connection</span>
        <dl className="divide-y divide-border rounded-lg border border-border bg-bg">
          <div className="flex items-center justify-between gap-6 px-3.5 py-2.5">
            <dt className="text-[12px] text-muted">Base URL</dt>
            <dd className="min-w-0 truncate text-[13px] text-text">
              {gateway.baseUrl.trim() || <span className="text-muted">Not set</span>}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-6 px-3.5 py-2.5">
            <dt className="text-[12px] text-muted">Auth</dt>
            <dd className="text-[13px] text-text">{gateway.authSchema}</dd>
          </div>
          <div className="flex items-center justify-between gap-6 px-3.5 py-2.5">
            <dt className="text-[12px] text-muted">API key</dt>
            <dd className="font-mono text-[13px] text-text">
              {maskKey(gateway.apiKey) || <span className="font-sans text-muted">None</span>}
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
          Models ({models.length})
        </span>
        {models.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-bg">
            {models.map((m) => {
              const active = m.id === modelId
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-[13px]"
                >
                  <span className={'min-w-0 truncate ' + (active ? 'text-primary' : 'text-text')}>
                    {m.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{m.id}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-[12px] text-muted">No models yet.</p>
        )}
      </section>

      <p className="text-[12px] leading-relaxed text-muted">
        Manage your models on the Sylor website → Authentication page. Changes sync here
        automatically the next time this account's config updates.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The Settings window
// ─────────────────────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  // The model selector deep-links here via openSettings('model'). The panel is
  // mounted fresh on each open, so seeding the initial category from the
  // requested tab is all it takes to land there.
  const settingsTab = useAppStore((s) => s.settingsTab)

  const [category, setCategory] = useState<SettingsCategory>(settingsTab ?? 'model')

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
              {category === 'model' && <ModelPane />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
