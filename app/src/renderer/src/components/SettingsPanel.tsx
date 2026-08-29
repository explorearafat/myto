import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AuthSchema,
  CommandInfo,
  ConfigScope,
  GatewayConfig,
  InstalledPlugin,
  McpCategory,
  McpConnectionState,
  McpRisk,
  McpServerStatus,
  OllamaConfig,
  PermissionMode,
  ProviderKind,
  ProviderSettings,
  ReasoningEffort,
  SkillCategory,
  SkillStatus,
  TestConnectionResult,
  Theme,
  WorkMode
} from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

const AUTH_SCHEMA_LABELS: Record<AuthSchema, string> = {
  none: 'None',
  bearer: 'Bearer token',
  header: 'Custom header'
}

/** The Settings window's left-rail categories (Claude-Desktop style). */
type SettingsCategory =
  | 'general'
  | 'appearance'
  | 'model'
  | 'connectors'
  | 'skills'
  | 'commands'
  | 'plugins'

/** Title + one-line subtitle shown in each category pane's header. */
const CATEGORY_META: Record<SettingsCategory, { label: string; subtitle: string }> = {
  general: { label: 'General', subtitle: 'How Sylor works and how much it deliberates.' },
  appearance: { label: 'Appearance', subtitle: 'Theme and visual style.' },
  model: { label: 'Model', subtitle: 'Provider connection and the model Sylor talks to.' },
  connectors: { label: 'Connectors', subtitle: 'MCP servers that add tools, configured on disk.' },
  skills: { label: 'Skills', subtitle: 'Capability folders the model can invoke on demand.' },
  commands: { label: 'Commands', subtitle: 'Reusable slash-command prompts, surfaced with “/”.' },
  plugins: { label: 'Plugins', subtitle: 'Install a repo of skills, commands, and connectors at once.' }
}

/** Small monochrome glyph for each category, tinted by the nav's active state. */
function CategoryIcon({ id }: { id: SettingsCategory }): ReactNode {
  switch (id) {
    case 'general':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="4.5" r="1.6" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="10.5" cy="8" r="1.6" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="5" cy="11.5" r="1.6" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )
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
    case 'connectors':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6 9l-2.5 2.5a2.1 2.1 0 0 0 3 3L9 12M10 7l2.5-2.5a2.1 2.1 0 0 0-3-3L7 4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path d="M6.5 9.5l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'skills':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5l1.7 3.6 3.8.5-2.8 2.6.7 3.8L8 10.8 4.6 12.6l.7-3.8L2.5 6.2l3.8-.5L8 1.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'commands':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'plugins':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6 2.5v2.2M10 2.5v2.2M4.5 4.7h7v3.1a3.5 3.5 0 0 1-7 0V4.7ZM8 11.3v2.2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
  }
}

const CATEGORY_ORDER: SettingsCategory[] = [
  'general',
  'appearance',
  'model',
  'connectors',
  'skills',
  'commands',
  'plugins'
]

// ─────────────────────────────────────────────────────────────────────────────
// Reusable controls (Claude-settings row vocabulary)
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

/** A pill on/off switch (shared shape with the MCP/Skills toggles). */
function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={
        'relative h-5 w-9 shrink-0 rounded-full transition-colors ' +
        (checked ? 'bg-primary' : 'bg-surface-2')
      }
    >
      <span
        className={
          'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ' +
          (checked ? 'left-[18px]' : 'left-0.5')
        }
      />
    </button>
  )
}

/** A segmented control for a small enum (theme, mode, effort…). */
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

/** A labelled text field matching the workspace's dark form styling. */
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
// General & Appearance panes (store-backed; every control applies immediately)
// ─────────────────────────────────────────────────────────────────────────────

const WORK_MODE_OPTIONS: ReadonlyArray<{ id: WorkMode; label: string }> = [
  { id: 'cowork', label: 'Cowork' },
  { id: 'code', label: 'Code' }
]
const EFFORT_OPTIONS: ReadonlyArray<{ id: ReasoningEffort; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' }
]
const PERMISSION_OPTIONS: ReadonlyArray<{ id: PermissionMode; label: string }> = [
  { id: 'ask', label: 'Ask' },
  { id: 'auto-edit', label: 'Auto-edit' }
]
const THEME_OPTIONS: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

/** General pane: working mode, reasoning effort, permission posture, plan-first. */
function GeneralPane() {
  const workMode = useAppStore((s) => s.workMode)
  const setWorkMode = useAppStore((s) => s.setWorkMode)
  const effort = useAppStore((s) => s.effort)
  const setEffort = useAppStore((s) => s.setEffort)
  const permissionMode = useAppStore((s) => s.permissionMode)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const planFirst = useAppStore((s) => s.planFirst)
  const setPlanFirst = useAppStore((s) => s.setPlanFirst)

  return (
    <div className="divide-y divide-border">
      <SettingRow
        title="Working mode"
        description="Cowork is a pure chat assistant with no folder access. Code reads your project and proposes edits or commands under the permission gate."
      >
        <Segmented
          ariaLabel="Working mode"
          value={workMode}
          options={WORK_MODE_OPTIONS}
          onChange={(v) => void setWorkMode(v)}
        />
      </SettingRow>
      <SettingRow
        title="Reasoning effort"
        description="How much the model deliberates before answering. Higher is slower but more thorough."
      >
        <Segmented
          ariaLabel="Reasoning effort"
          value={effort}
          options={EFFORT_OPTIONS}
          onChange={(v) => void setEffort(v)}
        />
      </SettingRow>
      <SettingRow
        title="Permission mode"
        description="Ask reviews every file edit and command. Auto-edit applies edits automatically — commands still ask."
      >
        <Segmented
          ariaLabel="Permission mode"
          value={permissionMode}
          options={PERMISSION_OPTIONS}
          onChange={setPermissionMode}
        />
      </SettingRow>
      <SettingRow
        title="Plan first"
        description="For substantial edit turns, write a plan.md capturing the full plan and pause before making other changes."
      >
        <Switch checked={planFirst} onChange={(v) => void setPlanFirst(v)} label="Plan first" />
      </SettingRow>
    </div>
  )
}

/** Appearance pane: color theme. */
function AppearancePane() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <div className="divide-y divide-border">
      <SettingRow
        title="Theme"
        description="Light is Claude's warm palette; dark is a low-glare palette. Applies instantly across the app."
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

// ─────────────────────────────────────────────────────────────────────────────
// Connectors (MCP) & Skills panes (disk-authored; status + per-item toggle)
// ─────────────────────────────────────────────────────────────────────────────

/** Small pill used for the badges on connector/skill cards. */
type ChipTone = 'muted' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'
const CHIP_TONE: Record<ChipTone, string> = {
  muted: 'bg-surface-2 text-muted',
  ok: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  danger: 'bg-red-500/15 text-red-300',
  info: 'bg-sky-500/15 text-sky-300',
  accent: 'bg-primary/15 text-primary'
}
function Chip({
  children,
  tone = 'muted',
  title
}: {
  children: ReactNode
  tone?: ChipTone
  title?: string
}) {
  return (
    <span title={title} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  )
}

/** The on/off pill toggle shared by connector + skill rows (always on the right). */
function Toggle({
  on,
  disabled,
  onClick,
  label
}: {
  on: boolean
  disabled?: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={
        'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ' +
        (on ? 'bg-primary' : 'bg-surface-2')
      }
    >
      <span
        className={
          'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ' +
          (on ? 'left-[18px]' : 'left-0.5')
        }
      />
    </button>
  )
}

/** A search box matching the workspace's dark form styling. */
function SearchInput({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full rounded-md border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none placeholder:text-muted/60 focus:border-primary/70"
    />
  )
}

/** Groups items by a category key, preserving a fixed display order. */
function groupByCategory<T, C extends string>(
  items: T[],
  order: readonly C[],
  keyOf: (item: T) => C
): Array<[C, T[]]> {
  const buckets = new Map<C, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const list = buckets.get(key)
    if (list) list.push(item)
    else buckets.set(key, [item])
  }
  const ordered: Array<[C, T[]]> = []
  for (const cat of order) {
    const list = buckets.get(cat)
    if (list && list.length) ordered.push([cat, list])
  }
  // Any category not in the explicit order (defensive) falls to the end.
  for (const [cat, list] of buckets) {
    if (!order.includes(cat)) ordered.push([cat, list])
  }
  return ordered
}

/** Human labels + badge tone for a server's connection state. */
const MCP_STATE_STYLE: Record<McpConnectionState, { label: string; tone: ChipTone }> = {
  connecting: { label: 'Connecting…', tone: 'warn' },
  connected: { label: 'Connected', tone: 'ok' },
  error: { label: 'Error', tone: 'danger' },
  disabled: { label: 'Off', tone: 'muted' },
  unconfigured: { label: 'Setup needed', tone: 'warn' }
}

/** Display labels for connector categories, in the order the pane lists them. */
const MCP_CATEGORY_ORDER: readonly McpCategory[] = [
  'core',
  'files',
  'git',
  'web',
  'browser',
  'productivity',
  'development',
  'data',
  'database',
  'external'
]
const MCP_CATEGORY_LABEL: Record<McpCategory, string> = {
  core: 'Core',
  files: 'Files',
  git: 'Git',
  development: 'Development',
  browser: 'Browser',
  web: 'Web',
  database: 'Database',
  data: 'Data',
  productivity: 'Productivity',
  external: 'External services'
}

/** Display labels + tone for a server's risk/scope badge. */
const MCP_RISK: Record<McpRisk, { label: string; tone: ChipTone }> = {
  'read-only': { label: 'Read-only', tone: 'ok' },
  local: { label: 'Local', tone: 'info' },
  network: { label: 'Network', tone: 'warn' },
  system: { label: 'System', tone: 'warn' },
  high: { label: 'High risk', tone: 'danger' }
}

/** Display labels for skill categories, in the order the pane lists them. */
const SKILL_CATEGORY_ORDER: readonly SkillCategory[] = [
  'planning',
  'coding',
  'debugging',
  'testing',
  'project',
  'research',
  'documentation',
  'git',
  'security',
  'performance',
  'web',
  'devops'
]
const SKILL_CATEGORY_LABEL: Record<SkillCategory, string> = {
  coding: 'Coding',
  debugging: 'Debugging',
  planning: 'Planning',
  project: 'Project',
  testing: 'Testing',
  research: 'Research',
  web: 'Web',
  security: 'Security',
  documentation: 'Documentation',
  git: 'Git',
  devops: 'DevOps',
  performance: 'Performance'
}

/** The one-line status shown under a server's title (honest about each state). */
function mcpStatusLine(s: McpServerStatus): string {
  switch (s.state) {
    case 'connected':
      return `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'} available`
    case 'connecting':
      return 'Connecting…'
    case 'disabled':
      return 'Turned off — its tools are hidden from the assistant'
    case 'unconfigured':
      return s.requiresApiKey
        ? `Needs ${s.requiresApiKey} — add it to mcp.json, then Reconnect`
        : 'Needs a workspace folder — open one to use this server'
    case 'error':
      return s.error ?? 'Failed to connect'
  }
}

/** A centered modal over a dimmed backdrop; Esc, the backdrop, or ✕ closes it. */
function Modal({
  title,
  subtitle,
  onClose,
  children
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-text">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** A labelled multiline field for the add modals (JSON / instructions). */
function TextArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 6,
  mono,
  hint
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</span>
      <textarea
        value={value}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={
          'resize-y rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-muted/50 focus:border-primary/70 ' +
          (mono ? 'font-mono text-[12px] leading-relaxed' : '')
        }
      />
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  )
}

/** Global vs. project scope picker for the add modals (project only when open). */
function ScopePicker({
  scope,
  hasProject,
  onChange
}: {
  scope: ConfigScope
  hasProject: boolean
  onChange: (scope: ConfigScope) => void
}) {
  const options: ReadonlyArray<{ id: ConfigScope; label: string }> = hasProject
    ? [
        { id: 'global', label: 'All projects' },
        { id: 'project', label: 'This project' }
      ]
    : [{ id: 'global', label: 'All projects' }]
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Available in</span>
      <Segmented value={scope} options={options} onChange={onChange} ariaLabel="Where to save" />
    </div>
  )
}

/** The row of buttons shared by both add modals (Cancel + a busy-aware submit). */
function ModalActions({
  onClose,
  onSubmit,
  submitLabel,
  busy,
  disabled
}: {
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  busy: boolean
  disabled?: boolean
}) {
  return (
    <div className="mt-1 flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={onClose}
        className="rounded-md px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-text"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || disabled}
        className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-bg transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

const MCP_JSON_PLACEHOLDER = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
}

— or a remote server —

{ "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }`

/**
 * "Add / Import connector" modal. Accepts the flexible JSON shapes a user is
 * likely to paste (a full `{ "mcpServers": {…} }` block, a bare name→server map,
 * or a single server object keyed by the Name field) and hands them to the main
 * process, which validates + writes `mcp.json` and reconnects. Errors from the
 * main side (bad JSON, no valid server) surface inline; nothing is written until
 * it validates.
 */
function AddMcpModal({
  hasProject,
  onClose,
  onAdded
}: {
  hasProject: boolean
  onClose: () => void
  onAdded: (servers: McpServerStatus[]) => void
}) {
  const [name, setName] = useState('')
  const [json, setJson] = useState('')
  const [scope, setScope] = useState<ConfigScope>('global')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.sylor.mcp.addServer({ name, json, scope })
      if (res.ok) onAdded(res.servers)
      else setError(res.error ?? 'Could not add the server.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a connector"
      subtitle="Paste a server's config (from its docs) or fill in a command / URL. It runs only after you approve each tool call."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Name"
          value={name}
          onChange={setName}
          placeholder="e.g. filesystem"
          hint="Used as the key when you paste a single unnamed server. Optional if your JSON already names it."
        />
        <TextArea
          label="Configuration (JSON)"
          value={json}
          onChange={setJson}
          placeholder={MCP_JSON_PLACEHOLDER}
          rows={8}
          mono
        />
        <ScopePicker scope={scope} hasProject={hasProject} onChange={setScope} />
        {error && <p className="text-[12px] text-red-300">{error}</p>}
        <ModalActions
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Add connector"
          busy={busy}
          disabled={!json.trim()}
        />
      </div>
    </Modal>
  )
}

/**
 * "Add a skill" modal. Authors a `SKILL.md` from simple fields — the model sees
 * the name/description/when-to-use in its listing and loads the full instructions
 * only when it invokes the skill. The main process writes the file and re-scans.
 */
function AddSkillModal({
  hasProject,
  onClose,
  onAdded
}: {
  hasProject: boolean
  onClose: () => void
  onAdded: (skills: SkillStatus[]) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [instructions, setInstructions] = useState('')
  const [scope, setScope] = useState<ConfigScope>('global')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.sylor.skills.add({ name, description, whenToUse, instructions, scope })
      if (res.ok) onAdded(res.skills)
      else setError(res.error ?? 'Could not add the skill.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a skill"
      subtitle="A skill is a reusable set of instructions the assistant can invoke on demand. Anything it then does still asks for your approval."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" value={name} onChange={setName} placeholder="e.g. Release checklist" />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="One line shown to the assistant in its skill list"
        />
        <Field
          label="Use when (optional)"
          value={whenToUse}
          onChange={setWhenToUse}
          placeholder="e.g. When the user asks to cut a release"
        />
        <TextArea
          label="Instructions"
          value={instructions}
          onChange={setInstructions}
          placeholder="Step-by-step instructions the assistant follows once it invokes this skill…"
          rows={7}
          hint="Loaded into the conversation only when the skill is invoked."
        />
        <ScopePicker scope={scope} hasProject={hasProject} onChange={setScope} />
        {error && <p className="text-[12px] text-red-300">{error}</p>}
        <ModalActions
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Add skill"
          busy={busy}
          disabled={!name.trim() || !instructions.trim()}
        />
      </div>
    </Modal>
  )
}

/** A dashed full-width button that opens an add/import modal for a section. */
function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border border-dashed border-border py-2.5 text-[12px] font-medium text-muted transition-colors hover:border-primary/60 hover:text-text"
    >
      {label}
    </button>
  )
}

/**
 * MCP servers ("Connectors") pane. Servers come from a curated built-in catalog
 * and the user's own `mcp.json` (global + per-project). This lists each server's
 * transport, source, connection state, and tool count; offers an on/off toggle
 * (a disabled server drops its client so its tools vanish from the next turn);
 * and — via the "Add / Import" modal — writes new servers to `mcp.json` and
 * reconnects, no hand-editing required. Custom servers can be removed here too.
 * The on/off state is persisted separately (`sylor-mcp.json`) so a model-Save
 * can't clobber it. Self-contained: owns its fetch state, never touches provider
 * settings.
 */
function McpSection() {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [paths, setPaths] = useState<{ global: string; project: string | null } | null>(null)
  const [busy, setBusy] = useState<null | 'reconnect' | 'restore'>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.sylor.mcp.listServers().then((s) => {
      if (!cancelled) setServers(s)
    })
    void window.sylor.mcp.configPaths().then((p) => {
      if (!cancelled) setPaths(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleReconnect = async (): Promise<void> => {
    setBusy('reconnect')
    try {
      setServers(await window.sylor.mcp.reconnect())
    } finally {
      setBusy(null)
    }
  }

  const handleRestore = async (): Promise<void> => {
    setBusy('restore')
    try {
      // Clears the on/off overrides so servers revert to catalog defaults (mostly
      // off); custom mcp.json definitions are preserved, only re-defaulted.
      setServers(await window.sylor.mcp.restoreDefaults())
    } finally {
      setBusy(null)
    }
  }

  const handleToggle = async (server: McpServerStatus): Promise<void> => {
    setPending(server.name)
    try {
      // setEnabled persists the switch then reloads from disk + reconnects,
      // returning the full list — so a re-enabled server flips to connecting/
      // connected (or setup-needed) and a disabled one to 'off' without a refetch.
      setServers(await window.sylor.mcp.setEnabled(server.name, !server.enabled))
    } finally {
      setPending(null)
    }
  }

  // Remove a custom server's mcp.json entry (both scopes) and reconnect. Guarded
  // by a confirm since it deletes the definition — a catalog server configured on
  // disk would revert to its built-in default; a purely-custom one disappears.
  const handleRemove = async (server: McpServerStatus): Promise<void> => {
    if (!window.confirm(`Remove "${server.title}"? This deletes its entry from mcp.json.`)) return
    setRemoving(server.name)
    try {
      setServers(await window.sylor.mcp.removeServer(server.name))
    } finally {
      setRemoving(null)
    }
  }

  const hasProject = !!paths?.project

  const q = query.trim().toLowerCase()
  const filtered = q
    ? servers.filter((s) =>
        [s.name, s.title, s.description, MCP_CATEGORY_LABEL[s.category]].some((f) =>
          f.toLowerCase().includes(q)
        )
      )
    : servers
  const groups = groupByCategory(filtered, MCP_CATEGORY_ORDER, (s) => s.category)
  const enabledCount = servers.filter((s) => s.enabled).length

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted">
          {enabledCount} of {servers.length} enabled
        </span>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleRestore}
            disabled={busy !== null}
            className="text-[12px] font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore defaults'}
          </button>
          <button
            type="button"
            onClick={handleReconnect}
            disabled={busy !== null}
            className="text-[12px] font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
          >
            {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}
          </button>
        </div>
      </div>

      <SearchInput value={query} onChange={setQuery} placeholder="Search connectors…" />

      {servers.length === 0 ? (
        <p className="text-[12px] text-muted">
          No connectors yet. Use “Add / Import connector” below to add one.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-[12px] text-muted">No connectors match “{query}”.</p>
      ) : (
        <div className="space-y-4">
          {groups.map(([cat, list]) => (
            <div key={cat} className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {MCP_CATEGORY_LABEL[cat]}
              </h4>
              <ul className="space-y-2">
                {list.map((s) => {
                  const style = MCP_STATE_STYLE[s.state]
                  const risk = MCP_RISK[s.risk]
                  return (
                    <li key={s.name} className="rounded-md border border-border bg-bg px-3 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className={'min-w-0 flex-1 ' + (s.enabled ? '' : 'opacity-60')}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-text">{s.title}</span>
                            {s.recommended && <Chip tone="accent">Recommended</Chip>}
                            <Chip tone={s.builtIn ? 'muted' : 'info'}>
                              {s.builtIn ? 'Built-in' : 'Custom'}
                            </Chip>
                          </div>
                          {s.description && (
                            <p className="mt-1 text-[11px] leading-relaxed text-muted">{s.description}</p>
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Chip tone="muted">{s.transport.toUpperCase()}</Chip>
                            <Chip tone={s.local ? 'ok' : 'warn'}>{s.local ? 'Local' : 'External'}</Chip>
                            <Chip tone={risk.tone} title="What enabling this exposes">
                              {risk.label}
                            </Chip>
                            {s.free && <Chip tone="ok">Free</Chip>}
                            {s.requiresApiKey && (
                              <Chip tone="warn" title={s.requiresApiKey}>
                                Requires API key
                              </Chip>
                            )}
                          </div>
                          <div className="mt-1 text-[11px] text-muted">{mcpStatusLine(s)}</div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <Chip tone={style.tone}>{style.label}</Chip>
                          <Toggle
                            on={s.enabled}
                            disabled={pending === s.name}
                            onClick={() => handleToggle(s)}
                            label={`${s.enabled ? 'Disable' : 'Enable'} ${s.title}`}
                          />
                          {s.source !== 'catalog' && (
                            <button
                              type="button"
                              onClick={() => void handleRemove(s)}
                              disabled={removing === s.name}
                              className="text-[10px] font-medium text-muted transition-colors hover:text-red-300 disabled:opacity-50"
                            >
                              {removing === s.name ? 'Removing…' : 'Remove'}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <AddButton label="+ Add / Import connector" onClick={() => setShowAdd(true)} />

      <p className="text-[11px] text-muted">
        Only enabled servers connect and expose tools to the assistant. Remote (HTTP) servers reach
        URLs you configure — the one exception to Sylor&apos;s offline default. Every tool call still
        asks for your approval.
      </p>

      {showAdd && (
        <AddMcpModal
          hasProject={hasProject}
          onClose={() => setShowAdd(false)}
          onAdded={(next) => {
            setServers(next)
            setShowAdd(false)
          }}
        />
      )}
    </section>
  )
}

/**
 * Skills pane. Skills are disk-authored capability folders (a `SKILL.md` under
 * `~/.sylor/skills/<name>` or `<project>/.sylor/skills/<name>`) that the model
 * can invoke on demand. Authoring is by file, so this pane is read-only except
 * for one toggle per skill — enable/disable, persisted separately from provider
 * settings so a model-Save can't clobber it. Reload re-scans disk after the user
 * edits a SKILL.md. Self-contained; owns its own fetch state.
 */
function SkillsSection() {
  const [skills, setSkills] = useState<SkillStatus[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  const [paths, setPaths] = useState<{ global: string; project: string | null } | null>(null)
  const [busy, setBusy] = useState<null | 'reload' | 'restore'>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [enablingMcp, setEnablingMcp] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.sylor.skills.list().then((s) => {
      if (!cancelled) setSkills(s)
    })
    // The MCP list resolves each skill's dependency status (enabled or not).
    void window.sylor.mcp.listServers().then((s) => {
      if (!cancelled) setMcpServers(s)
    })
    void window.sylor.skills.configPaths().then((p) => {
      if (!cancelled) setPaths(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleReload = async (): Promise<void> => {
    setBusy('reload')
    try {
      setSkills(await window.sylor.skills.reload())
    } finally {
      setBusy(null)
    }
  }

  const handleRestore = async (): Promise<void> => {
    setBusy('restore')
    try {
      // Clears the overrides so skills revert to defaults (safe essentials on).
      setSkills(await window.sylor.skills.restoreDefaults())
    } finally {
      setBusy(null)
    }
  }

  const handleToggle = async (skill: SkillStatus): Promise<void> => {
    setPending(skill.name)
    try {
      // setEnabled returns the full updated list, so state stays authoritative.
      setSkills(await window.sylor.skills.setEnabled(skill.name, !skill.enabled))
    } finally {
      setPending(null)
    }
  }

  // Remove a disk-authored skill's SKILL.md (built-ins have nothing on disk).
  // Guarded by a confirm since it deletes the file.
  const handleRemove = async (skill: SkillStatus): Promise<void> => {
    if (!window.confirm(`Remove the "${skill.title}" skill? This deletes its SKILL.md.`)) return
    setRemoving(skill.name)
    try {
      setSkills(await window.sylor.skills.remove(skill.name))
    } finally {
      setRemoving(null)
    }
  }

  const hasProject = !!paths?.project

  // Enable a skill's required MCP server on request — never silently: the user
  // clicks "Enable" on the dependency chip. Refreshes the MCP list so the chip
  // flips to satisfied.
  const handleEnableMcp = async (name: string): Promise<void> => {
    setEnablingMcp(name)
    try {
      setMcpServers(await window.sylor.mcp.setEnabled(name, true))
    } finally {
      setEnablingMcp(null)
    }
  }

  const mcpByName = useMemo(() => new Map(mcpServers.map((s) => [s.name, s])), [mcpServers])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? skills.filter((s) =>
        [s.name, s.title, s.description, SKILL_CATEGORY_LABEL[s.category]].some((f) =>
          f.toLowerCase().includes(q)
        )
      )
    : skills
  const groups = groupByCategory(filtered, SKILL_CATEGORY_ORDER, (s) => s.category)
  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted">
          {enabledCount} of {skills.length} enabled
        </span>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleRestore}
            disabled={busy !== null}
            className="text-[12px] font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore defaults'}
          </button>
          <button
            type="button"
            onClick={handleReload}
            disabled={busy !== null}
            className="text-[12px] font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
          >
            {busy === 'reload' ? 'Reloading…' : 'Reload'}
          </button>
        </div>
      </div>

      <SearchInput value={query} onChange={setQuery} placeholder="Search skills…" />

      {skills.length === 0 ? (
        <p className="text-[12px] text-muted">No skills yet. Use “Add a skill” below to create one.</p>
      ) : filtered.length === 0 ? (
        <p className="text-[12px] text-muted">No skills match “{query}”.</p>
      ) : (
        <div className="space-y-4">
          {groups.map(([cat, list]) => (
            <div key={cat} className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {SKILL_CATEGORY_LABEL[cat]}
              </h4>
              <ul className="space-y-2">
                {list.map((s) => (
                  <li key={s.name} className="rounded-md border border-border bg-bg px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className={'min-w-0 flex-1 ' + (s.enabled ? '' : 'opacity-60')}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-text">{s.title}</span>
                          {s.recommended && <Chip tone="accent">Recommended</Chip>}
                          <Chip tone={s.builtIn ? 'muted' : 'info'}>
                            {s.builtIn ? 'Built-in' : 'Custom'}
                          </Chip>
                        </div>
                        {s.description && (
                          <p className="mt-1 text-[11px] leading-relaxed text-muted">{s.description}</p>
                        )}
                        {s.whenToUse && (
                          <p className="mt-0.5 text-[11px] text-muted/80">Use when: {s.whenToUse}</p>
                        )}
                        {s.requiresMcp.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {s.requiresMcp.map((dep) => {
                              const server = mcpByName.get(dep)
                              const label = server?.title ?? dep
                              return server?.enabled ? (
                                <Chip key={dep} tone="ok" title={`The ${label} MCP server is enabled`}>
                                  ✓ Needs {label}
                                </Chip>
                              ) : (
                                <span key={dep} className="inline-flex items-center gap-1">
                                  <Chip
                                    tone="warn"
                                    title={`This skill works best with the ${label} MCP server`}
                                  >
                                    Needs {label} MCP
                                  </Chip>
                                  <button
                                    type="button"
                                    onClick={() => handleEnableMcp(dep)}
                                    disabled={enablingMcp === dep}
                                    className="text-[10px] font-medium text-primary hover:text-primary/80 disabled:opacity-50"
                                  >
                                    {enablingMcp === dep ? 'Enabling…' : 'Enable'}
                                  </button>
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Toggle
                          on={s.enabled}
                          disabled={pending === s.name}
                          onClick={() => handleToggle(s)}
                          label={`${s.enabled ? 'Disable' : 'Enable'} ${s.title}`}
                        />
                        {s.source !== 'builtin' && (
                          <button
                            type="button"
                            onClick={() => void handleRemove(s)}
                            disabled={removing === s.name}
                            className="text-[10px] font-medium text-muted transition-colors hover:text-red-300 disabled:opacity-50"
                          >
                            {removing === s.name ? 'Removing…' : 'Remove'}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <AddButton label="+ Add a skill" onClick={() => setShowAdd(true)} />

      <p className="text-[11px] text-muted">
        Enabled skills appear to the assistant as a short listing; a skill&apos;s full instructions
        load only when it&apos;s invoked. Anything it then does (edits, commands) still asks for your
        approval.
      </p>

      {showAdd && (
        <AddSkillModal
          hasProject={hasProject}
          onClose={() => setShowAdd(false)}
          onAdded={(next) => {
            setSkills(next)
            setShowAdd(false)
          }}
        />
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands + Plugins panes
// ─────────────────────────────────────────────────────────────────────────────

/** Modal to author a new slash command written to `<scope>/commands/<name>.md`. */
function AddCommandModal({
  hasProject,
  onClose,
  onAdded
}: {
  hasProject: boolean
  onClose: () => void
  onAdded: (commands: CommandInfo[]) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [argumentHint, setArgumentHint] = useState('')
  const [body, setBody] = useState('')
  const [scope, setScope] = useState<ConfigScope>('global')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.sylor.commands.add({ name, description, argumentHint, body, scope })
      if (res.ok) onAdded(res.commands)
      else setError(res.error ?? 'Could not add the command.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a command"
      subtitle="A command is a reusable prompt you trigger by typing “/name” in the composer. Use $ARGUMENTS or $1, $2… to drop in whatever you type after it."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" value={name} onChange={setName} placeholder="e.g. review" />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="One line shown in the / menu"
        />
        <Field
          label="Argument hint (optional)"
          value={argumentHint}
          onChange={setArgumentHint}
          placeholder="e.g. [file] or <branch>"
        />
        <TextArea
          label="Prompt"
          value={body}
          onChange={setBody}
          placeholder="Review the changes in $ARGUMENTS for correctness and style…"
          rows={7}
          hint="Sent as your message when you run the command. $ARGUMENTS / $1… expand to your input."
        />
        <ScopePicker scope={scope} hasProject={hasProject} onChange={setScope} />
        {error && <p className="text-[12px] text-red-300">{error}</p>}
        <ModalActions
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Add command"
          busy={busy}
          disabled={!name.trim() || !body.trim()}
        />
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The Settings window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugins pane. A plugin is a git repo (or local folder) bundling skills,
 * commands, and connectors; installing unpacks them into the ordinary `.sylor`
 * locations. The user pastes an `owner/repo`, a git URL, or a local path, picks
 * a scope, and installs; the list shows what each plugin added and offers a
 * clean uninstall. Mirrors the in-chat `install_plugin` tool.
 */
function PluginsSection() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [source, setSource] = useState('')
  const [scope, setScope] = useState<ConfigScope>('global')
  const [hasProject, setHasProject] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.sylor.plugins.list().then((p) => {
      if (!cancelled) setPlugins(p)
    })
    // Reuse the skills config paths purely to learn whether a project is open
    // (so the project-scope option is offered only when it can be written).
    void window.sylor.skills.configPaths().then((p) => {
      if (!cancelled) setHasProject(!!p.project)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleInstall = async (): Promise<void> => {
    if (installing || !source.trim()) return
    setInstalling(true)
    setError(null)
    try {
      const res = await window.sylor.plugins.install({ source: source.trim(), scope })
      if (res.ok) {
        setPlugins(res.plugins)
        setSource('')
      } else {
        setError(res.error ?? 'Could not install the plugin.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const handleRemove = async (plugin: InstalledPlugin): Promise<void> => {
    if (!window.confirm(`Remove "${plugin.name}"? This deletes the skills, commands, and connectors it installed.`))
      return
    setRemoving(plugin.name)
    try {
      setPlugins(await window.sylor.plugins.remove(plugin.name))
    } finally {
      setRemoving(null)
    }
  }

  // PLUGINS_SECTION_RENDER
  return (
    <section className="space-y-4">
      <div className="space-y-2 rounded-md border border-border bg-bg px-3 py-3">
        <Field
          label="Repository or folder"
          value={source}
          onChange={setSource}
          placeholder="owner/repo, https://…​.git, or a local folder path"
          hint="A GitHub owner/repo, any git URL, or a path to a local folder bundling skills / commands / an mcp.json."
        />
        <ScopePicker scope={scope} hasProject={hasProject} onChange={setScope} />
        {error && <p className="text-[12px] text-red-300">{error}</p>}
        <button
          type="button"
          onClick={() => void handleInstall()}
          disabled={installing || !source.trim()}
          className="w-full rounded-md bg-primary py-2 text-[13px] font-semibold text-bg transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {installing ? 'Installing…' : 'Install plugin'}
        </button>
      </div>

      {plugins.length === 0 ? (
        <p className="text-[12px] text-muted">
          No plugins installed. Paste a repo above, or just tell Sylor “install this skill:
          owner/repo” in chat.
        </p>
      ) : (
        <ul className="space-y-2">
          {plugins.map((p) => {
            const counts = [
              [p.contents.skills.length, 'skill'],
              [p.contents.commands.length, 'command'],
              [p.contents.connectors.length, 'connector']
            ] as const
            const summary = counts
              .filter(([n]) => n > 0)
              .map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`)
              .join(' · ')
            return (
              <li key={p.name} className="rounded-md border border-border bg-bg px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-text">{p.name}</span>
                      <Chip tone={p.scope === 'project' ? 'info' : 'muted'}>
                        {p.scope === 'project' ? 'Project' : 'Global'}
                      </Chip>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted">{p.source}</p>
                    {summary && <p className="mt-0.5 text-[11px] text-muted/80">Added {summary}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRemove(p)}
                    disabled={removing === p.name}
                    className="shrink-0 text-[10px] font-medium text-muted transition-colors hover:text-red-300 disabled:opacity-50"
                  >
                    {removing === p.name ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-[11px] text-muted">
        Installing clones the source and unpacks its skills, commands, and connectors into your
        {scope === 'project' ? ' project' : ' global'} .sylor folder. Removing withdraws exactly what
        it added. Requires git on your PATH for remote repos.
      </p>
    </section>
  )
}

/**
 * Commands pane. Commands are disk-authored Markdown prompt templates in
 * `~/.sylor/commands/*.md` (global) + `<root>/.sylor/commands/*.md` (project);
 * the composer surfaces them in the `/` menu and expands `/name args` into the
 * body before the turn runs. This lists them, authors new ones, and removes
 * them — mirroring the Skills pane. Self-contained fetch state.
 */
function CommandsSection() {
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [paths, setPaths] = useState<{ global: string; project: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.sylor.commands.list().then((c) => {
      if (!cancelled) setCommands(c)
    })
    void window.sylor.commands.configPaths().then((p) => {
      if (!cancelled) setPaths(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleReload = async (): Promise<void> => {
    setBusy(true)
    try {
      setCommands(await window.sylor.commands.reload())
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (cmd: CommandInfo): Promise<void> => {
    if (!window.confirm(`Remove the "/${cmd.name}" command? This deletes its .md file.`)) return
    setRemoving(cmd.name)
    try {
      setCommands(await window.sylor.commands.remove(cmd.name))
    } finally {
      setRemoving(null)
    }
  }

  const hasProject = !!paths?.project
  const q = query.trim().toLowerCase()
  const filtered = q
    ? commands.filter((c) => [c.name, c.description].some((f) => f.toLowerCase().includes(q)))
    : commands

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted">
          {commands.length} command{commands.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={handleReload}
          disabled={busy}
          className="text-[12px] font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
        >
          {busy ? 'Reloading…' : 'Reload'}
        </button>
      </div>

      <SearchInput value={query} onChange={setQuery} placeholder="Search commands…" />

      {commands.length === 0 ? (
        <p className="text-[12px] text-muted">
          No commands yet. Use “Add a command” below, then type “/” in the composer to run it.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-[12px] text-muted">No commands match “{query}”.</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((c) => (
            <li key={c.name} className="rounded-md border border-border bg-bg px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-mono text-[13px] font-medium text-text">
                      /{c.name}
                    </span>
                    {c.argumentHint && (
                      <span className="truncate font-mono text-[11px] text-muted">{c.argumentHint}</span>
                    )}
                    <Chip tone={c.source === 'project' ? 'info' : 'muted'}>
                      {c.source === 'project' ? 'Project' : 'Global'}
                    </Chip>
                  </div>
                  {c.description && (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">{c.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemove(c)}
                  disabled={removing === c.name}
                  className="shrink-0 text-[10px] font-medium text-muted transition-colors hover:text-red-300 disabled:opacity-50"
                >
                  {removing === c.name ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddButton label="+ Add a command" onClick={() => setShowAdd(true)} />

      <p className="text-[11px] text-muted">
        Type “/” at the start of the composer to pick a command; its prompt is sent as your message,
        with $ARGUMENTS / $1… replaced by whatever you type after the name.
      </p>

      {showAdd && (
        <AddCommandModal
          hasProject={hasProject}
          onClose={() => setShowAdd(false)}
          onAdded={(next) => {
            setCommands(next)
            setShowAdd(false)
          }}
        />
      )}
    </section>
  )
}

export function SettingsPanel() {
  const storedSettings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const previewModels = useAppStore((s) => s.previewModels)
  const models = useAppStore((s) => s.models)
  const modelsLoading = useAppStore((s) => s.modelsLoading)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  const [category, setCategory] = useState<SettingsCategory>('general')

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
  // list" click needed (matches Claude Code: a base URL + API key is enough).
  // Debounced so it doesn't fire on every keystroke, and it fills in a model
  // automatically when none is chosen yet, so chat works right after Save.
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

          {/* Scrollable pane. Now that the panel is full-screen, cap the content
              to a comfortable reading width and center it so forms don't stretch
              edge-to-edge on wide windows. */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-3xl">
            {category === 'general' && <GeneralPane />}
            {category === 'appearance' && <AppearancePane />}
            {category === 'connectors' && <McpSection />}
            {category === 'skills' && <SkillsSection />}
            {category === 'commands' && <CommandsSection />}
            {category === 'plugins' && <PluginsSection />}

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
              the other panes apply immediately, so they need no footer. */}
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
