import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AuthSchema,
  CommandInfo,
  ConfigScope,
  GatewayConfig,
  HookDefinition,
  HookEvent,
  HooksConfig,
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
  ScheduledTask,
  ScheduledTaskInput,
  SkillCategory,
  SkillStatus,
  TestConnectionResult,
  Theme,
  WorkMode
} from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { BrowserPermissionsSection } from '@renderer/components/browser/BrowserPermissions'
import {
  emptyBoardMessage,
  filterCounts,
  FILTER_LABEL,
  FILTER_ORDER,
  matchesFilter,
  matchesQuery,
  type CatalogFilter
} from '@renderer/lib/catalogFilter'

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
  | 'browsing'
  | 'automation'

/** Title + one-line subtitle shown in each category pane's header. */
const CATEGORY_META: Record<SettingsCategory, { label: string; subtitle: string }> = {
  general: { label: 'General', subtitle: 'How Sylor works and how much it deliberates.' },
  appearance: { label: 'Appearance', subtitle: 'Theme and visual style.' },
  model: { label: 'Model', subtitle: 'Provider connection and the model Sylor talks to.' },
  connectors: { label: 'Connectors', subtitle: 'MCP servers that add tools, configured on disk.' },
  skills: { label: 'Skills', subtitle: 'Capability folders the model can invoke on demand.' },
  commands: { label: 'Commands', subtitle: 'Reusable slash-command prompts, surfaced with “/”.' },
  plugins: { label: 'Plugins', subtitle: 'Install a repo of skills, commands, and connectors at once.' },
  browsing: {
    label: 'Browsing',
    subtitle: 'What Sylor may do on a web page on your behalf, and what always asks first.'
  },
  automation: {
    label: 'Automation',
    subtitle: 'Scheduled prompts and lifecycle hooks that run shell commands around the agent.'
  }
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
    case 'browsing':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.8l5 1.9v3.4c0 3-2 5.6-5 7-3-1.4-5-4-5-7V3.7l5-1.9Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M5.8 8.2l1.6 1.6 3-3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'automation':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="9" r="5" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 6.5V9l1.8 1.1M8 1.5v1.6M5.5 2.3l.8 1.4M10.5 2.3l-.8 1.4"
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
  'plugins',
  'browsing',
  'automation'
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
  const fullAccess = useAppStore((s) => s.fullAccess)
  const setFullAccess = useAppStore((s) => s.setFullAccess)
  const autoSend = useAppStore((s) => s.autoSend)
  const setAutoSend = useAppStore((s) => s.setAutoSend)

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
        description="For substantial edit turns, show the plan and wait for your go-ahead before touching a single file."
      >
        <Switch checked={planFirst} onChange={(v) => void setPlanFirst(v)} label="Plan first" />
      </SettingRow>
      <div className="py-3.5">
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-red-600">Full-PC access</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
              Lets Sylor read, write, and delete <span className="font-medium text-red-600">any file
              anywhere on this computer</span> — not just the project folder — and run any command
              without asking. The project sandbox and every approval prompt are turned off.
            </p>
          </div>
          <div className="shrink-0">
            <Switch
              checked={fullAccess}
              onChange={(v) => void setFullAccess(v)}
              label="Full-PC access"
            />
          </div>
        </div>
        {fullAccess && (
          <p className="mt-2 rounded-md bg-red-500/14 px-3 py-2 text-[12px] leading-relaxed text-red-600">
            Full-PC access is ON. Sylor no longer asks before editing files outside your project or
            running commands. Buying things is still blocked, and {autoSend ? 'deleting' : 'posting or deleting'} in
            the browser still asks once. Turn this off when you don’t need it.
          </p>
        )}
        {fullAccess && (
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-red-600">Auto-send messages</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                  Lets Sylor <span className="font-medium text-red-600">send messages, posts, and
                  emails on its own</span> — replying to a mail, posting for you, messaging someone —
                  without asking first. Deleting data still asks, and buying things stays blocked.
                </p>
              </div>
              <div className="shrink-0">
                <Switch
                  checked={autoSend}
                  onChange={(v) => void setAutoSend(v)}
                  label="Auto-send messages"
                />
              </div>
            </div>
            {autoSend && (
              <p className="mt-2 rounded-md bg-red-500/14 px-3 py-2 text-[12px] leading-relaxed text-red-600">
                Auto-send is ON. Sylor can post and send messages or email as you without a prompt.
                Make sure you trust the task before leaving it running.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Appearance pane: color theme, and the floating status card. */
function AppearancePane() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const statusWidget = useAppStore((s) => s.statusWidget)
  const setStatusWidget = useAppStore((s) => s.setStatusWidget)
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
      {/* This switch IS the window: main opens and destroys the card on the save, so
          the toggle can never claim something the desktop disagrees with. It is also
          the only way to dismiss it — the card is deliberately not closable, since a
          window that could close itself would leave this row lying until next launch. */}
      <SettingRow
        title="Floating status card"
        description="A small always-on-top card showing what Sylor is doing, with a clock and a stop button. The tray icon reports the same thing without taking a corner of the screen."
      >
        <Switch
          checked={statusWidget}
          onChange={(v) => void setStatusWidget(v)}
          label="Floating status card"
        />
      </SettingRow>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Connectors (MCP) & Skills panes (disk-authored; status + per-item toggle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Small pill used for the badges on connector/skill cards.
 *
 * The text sits at the 600 step rather than 300: the app's default theme is warm
 * paper, and amber-300 on #faf9f5 is a badge you cannot read. 600 clears legible
 * contrast on the paper ground and is still bright enough on the dark charcoal one,
 * so a single value serves both themes — the `dark:` variant is not available here
 * (it keys off the OS scheme, while the app's theme is a `data-theme` attribute).
 */
type ChipTone = 'muted' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'
const CHIP_TONE: Record<ChipTone, string> = {
  muted: 'bg-surface-2 text-muted',
  ok: 'bg-emerald-500/14 text-emerald-600',
  warn: 'bg-amber-500/16 text-amber-600',
  danger: 'bg-red-500/14 text-red-600',
  info: 'bg-sky-500/14 text-sky-600',
  accent: 'bg-primary/14 text-primary'
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
    <span title={title} className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The board: the shared vocabulary the Connectors and Skills panes are built from
//
// Both panes are the same thing — two dozen items of which a handful are live —
// and both used to render as an undifferentiated column of bordered boxes, every
// row the same weight whether it was running or switched off, its state carried
// only by a 20px switch at the far right edge. The board gives that column a
// spine: a state-tinted monogram tile per row so on/off is readable straight down
// the left edge, one dotted trait line in place of five identical chips, and a
// sticky header that counts, filters, searches and adds without scrolling.
// ─────────────────────────────────────────────────────────────────────────────

/** What a card's tile and status dot say about it at a glance. */
type BoardTone = 'on' | 'off' | 'warn' | 'error'
const BOARD_TONE: Record<BoardTone, { tile: string; dot: string; text: string }> = {
  on: { tile: 'bg-primary/14 text-primary', dot: 'bg-primary', text: 'text-primary' },
  off: { tile: 'bg-surface-2 text-muted', dot: 'bg-muted/50', text: 'text-muted' },
  warn: { tile: 'bg-amber-500/16 text-amber-600', dot: 'bg-amber-500', text: 'text-amber-600' },
  error: { tile: 'bg-red-500/14 text-red-600', dot: 'bg-red-500', text: 'text-red-600' }
}

/**
 * A card's identity tile: the item's initial in a rounded square, tinted by state.
 * This is what makes a long board scannable — terracotta tiles are live, grey ones
 * are off — and it is tinted by the brand accent rather than a per-category rainbow
 * so the pane still reads as Sylor rather than as a plugin bazaar.
 */
function Monogram({ label, tone }: { label: string; tone: BoardTone }) {
  const initial = (label.match(/[a-z0-9]/i)?.[0] ?? '·').toUpperCase()
  return (
    <span
      aria-hidden="true"
      className={
        'grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[13px] font-semibold ' +
        BOARD_TONE[tone].tile
      }
    >
      {initial}
    </span>
  )
}

/** The state dot beside a card's status line; `pulse` only while a connect is in flight. */
function StateDot({ tone, pulse = false }: { tone: BoardTone; pulse?: boolean }) {
  return (
    <span className="flex h-4 shrink-0 items-center">
      <span
        aria-hidden="true"
        className={'h-1.5 w-1.5 rounded-full ' + BOARD_TONE[tone].dot + (pulse ? ' animate-pulse' : '')}
      />
    </span>
  )
}

/** One fact on a card's trait line; a tone lifts the two that are worth noticing. */
type Trait = { text: string; tone?: 'warn' | 'danger' }

/**
 * A card's facts as one dotted line. It replaces a row of five same-shaped chips —
 * transport, local/external, risk, free, built-in — which competed with each other
 * and with the badges that actually mattered. Only the two that are worth a second
 * look (a network/system reach, a high-risk scope) keep any colour.
 */
function TraitLine({ traits }: { traits: readonly Trait[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted">
      {traits.map((trait, i) => (
        <span key={trait.text} className="flex items-center gap-1.5">
          {i > 0 && (
            <span aria-hidden="true" className="text-border">
              ·
            </span>
          )}
          <span
            className={
              trait.tone === 'danger' ? 'text-red-600' : trait.tone === 'warn' ? 'text-amber-600' : ''
            }
          >
            {trait.text}
          </span>
        </span>
      ))}
    </div>
  )
}

/** A category heading that reads as a ruled legend rather than a floating caption. */
function GroupLegend({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</h4>
      <span className="text-[10px] tabular-nums text-muted/70">{count}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
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
        // The off state needs the inset ring: surface-2 (#efeee6) on bg (#faf9f5) is
        // barely a shade apart on the paper theme, so without it an off switch reads
        // as an empty gap rather than as a control.
        (on ? 'bg-primary' : 'bg-surface-2 ring-1 ring-inset ring-border')
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

/**
 * The four state pills, each carrying its count.
 *
 * `Needs setup` disappears when its count is zero rather than sitting there as a
 * dead `0` — on the Skills board it is always zero (a skill has no connection to
 * fail), so the strip is a three-pill strip there and nobody is invited to click
 * into an empty result.
 */
function FilterStrip({
  value,
  onChange,
  counts
}: {
  value: CatalogFilter
  onChange: (f: CatalogFilter) => void
  counts: Record<CatalogFilter, number>
}) {
  return (
    <div role="tablist" aria-label="Filter by state" className="flex items-center gap-1">
      {FILTER_ORDER.filter((f) => f !== 'attention' || counts.attention > 0).map((f) => {
        const active = value === f
        return (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(f)}
            className={
              'sylor-press flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ' +
              (active
                ? 'bg-primary text-bg'
                : 'text-muted hover:bg-surface-2 hover:text-text') +
              (f === 'attention' && !active ? ' text-amber-600' : '')
            }
          >
            {FILTER_LABEL[f]}
            <span className={'tabular-nums ' + (active ? 'text-bg/70' : 'text-muted/70')}>
              {counts[f]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A quiet text action for the header's right side (Reconnect, Reload, Reset…). */
function GhostAction({
  children,
  onClick,
  disabled,
  title
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="sylor-press rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/**
 * The board's control deck: how many are live, a hairline capacity bar, the add
 * action, then filter + search.
 *
 * It is sticky because both boards are long enough to scroll past their own
 * controls — the old panes put `+ Add a connector` at the very bottom, under two
 * dozen rows, which is the one place a user looking to add something will not
 * look. The `-mt-6 pt-6` pair swallows the scroll pane's own top padding so the
 * pinned band stays opaque as rows slide under it.
 */
function BoardHeader({
  noun,
  on,
  total,
  filter,
  onFilter,
  counts,
  query,
  onQuery,
  searchPlaceholder,
  addLabel,
  onAdd,
  children
}: {
  noun: string
  on: number
  total: number
  filter: CatalogFilter
  onFilter: (f: CatalogFilter) => void
  counts: Record<CatalogFilter, number>
  query: string
  onQuery: (v: string) => void
  searchPlaceholder: string
  addLabel: string
  onAdd: () => void
  children?: ReactNode
}) {
  const pct = total === 0 ? 0 : Math.round((on / total) * 100)
  return (
    <div className="sticky top-0 z-10 -mt-6 bg-surface pb-3 pt-6">
      <div className="overflow-hidden rounded-xl border border-border bg-bg">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">
              <span className="tabular-nums">{on}</span>
              <span className="text-muted"> of </span>
              <span className="tabular-nums">{total}</span>
              <span className="text-muted"> {noun} on</span>
            </p>
            <div
              aria-hidden="true"
              className="mt-1.5 h-px w-32 overflow-hidden rounded-full bg-border"
            >
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {children}
            <button
              type="button"
              onClick={onAdd}
              className="sylor-press rounded-md bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
            >
              {addLabel}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <FilterStrip value={filter} onChange={onFilter} counts={counts} />
          <div className="ml-auto w-44 shrink-0">
            <SearchInput value={query} onChange={onQuery} placeholder={searchPlaceholder} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The dashed card a board shows in place of its list when it has nothing to list. */
function BoardEmpty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
      <p className="text-[12px] text-muted">{message}</p>
      {action ? <div className="mt-2 flex justify-center">{action}</div> : null}
    </div>
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

/**
 * The word a server's status line leads with. The colour no longer comes from
 * here: the card's tile, dot and state word all read their tone from
 * `serverTone`, so a state has exactly one place that decides how it looks.
 */
const MCP_STATE_LABEL: Record<McpConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
  disabled: 'Off',
  unconfigured: 'Setup needed'
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

/**
 * The detail that follows the state word on a server's status line.
 *
 * It deliberately does not repeat the state itself: the line renders as
 * `● Connected — 12 tools available`, so a detail of `'Connecting…'` after the
 * word `Connecting…` would just stutter. An empty string means the state word
 * already said everything there is to say.
 */
function mcpStateDetail(s: McpServerStatus): string {
  switch (s.state) {
    case 'connected':
      return `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'} available`
    case 'connecting':
      return ''
    case 'disabled':
      return 'its tools are hidden from the assistant'
    case 'unconfigured':
      return s.requiresApiKey
        ? `needs ${s.requiresApiKey} — add it to mcp.json, then Reconnect`
        : 'needs a workspace folder — open one to use this server'
    case 'error':
      return s.error ?? 'failed to connect'
  }
}

/** Which tile/dot tone a server wears: a broken one outranks the switch. */
function serverTone(s: McpServerStatus): BoardTone {
  if (s.state === 'error') return 'error'
  if (s.state === 'unconfigured') return 'warn'
  return s.enabled ? 'on' : 'off'
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

{ "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer \${MCP_TOKEN}" } }

— one that signs you in —

{ "url": "https://example.com/mcp", "oauth": true }

Optional: "type" pins the transport ("stdio", "http" or "sse").
\${VAR} and \${VAR:-fallback} are read from your environment.`

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
 *
 * It renders as a board (`BoardHeader` + monogram cards): two dozen rows of which
 * three or four are live is a list you scan for state, not for names, and a switch
 * at the far right edge is the one place state was legible from. The header's
 * `Needs setup` filter is the pane's real job — a connector the user turned on that
 * has no key on disk is invisible in a plain list and looks like a Sylor bug.
 */
function McpSection() {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [paths, setPaths] = useState<{ global: string; project: string | null } | null>(null)
  const [busy, setBusy] = useState<null | 'reconnect' | 'restore'>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('all')

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

  const visible = servers.filter(
    (s) =>
      matchesFilter(s, filter) &&
      matchesQuery([s.name, s.title, s.description, MCP_CATEGORY_LABEL[s.category]], query)
  )
  const groups = groupByCategory(visible, MCP_CATEGORY_ORDER, (s) => s.category)
  const counts = filterCounts(servers)

  return (
    <section className="space-y-3">
      <BoardHeader
        noun="connectors"
        on={counts.on}
        total={counts.all}
        filter={filter}
        onFilter={setFilter}
        counts={counts}
        query={query}
        onQuery={setQuery}
        searchPlaceholder="Search connectors…"
        addLabel="+ Add"
        onAdd={() => setShowAdd(true)}
      >
        <GhostAction
          onClick={handleRestore}
          disabled={busy !== null}
          title="Revert every switch to its catalog default (your mcp.json entries stay)"
        >
          {busy === 'restore' ? 'Restoring…' : 'Reset'}
        </GhostAction>
        <GhostAction onClick={handleReconnect} disabled={busy !== null} title="Reconnect every enabled server">
          {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}
        </GhostAction>
      </BoardHeader>

      {servers.length === 0 ? (
        <BoardEmpty
          message="No connectors yet."
          action={
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="sylor-press rounded-md bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
            >
              + Add / Import a connector
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <BoardEmpty
          message={emptyBoardMessage(filter, query, 'connectors')}
          action={
            filter === 'all' ? undefined : (
              <GhostAction onClick={() => setFilter('all')}>Show all connectors</GhostAction>
            )
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map(([cat, list]) => (
            <div key={cat} className="space-y-2">
              <GroupLegend label={MCP_CATEGORY_LABEL[cat]} count={list.length} />
              <ul className="space-y-2">
                {list.map((s) => {
                  const tone = serverTone(s)
                  const risk = MCP_RISK[s.risk]
                  const detail = mcpStateDetail(s)
                  // The old card carried five to six chips of equal weight —
                  // transport, local/external, risk, free, built-in — so the two
                  // that matter got lost among the three that never change. They
                  // collapse into one dotted line, in the order a reader asks:
                  // whose is it, how does it talk, where does it run, what can it
                  // reach, does it cost.
                  const traits: Trait[] = [
                    { text: s.builtIn ? 'Built-in' : 'Custom' },
                    { text: s.transport.toUpperCase() },
                    { text: s.local ? 'Local' : 'External' },
                    {
                      text: risk.label,
                      tone: risk.tone === 'danger' ? 'danger' : risk.tone === 'warn' ? 'warn' : undefined
                    }
                  ]
                  if (s.free) traits.push({ text: 'Free' })
                  return (
                    <li
                      key={s.name}
                      className="rounded-xl border border-border bg-bg px-3 py-3 transition-colors hover:border-primary/40"
                    >
                      <div className="flex items-start gap-3">
                        <Monogram label={s.title} tone={tone} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={
                                    'truncate text-[13px] font-medium ' +
                                    (s.enabled ? 'text-text' : 'text-muted')
                                  }
                                >
                                  {s.title}
                                </span>
                                {s.recommended && <Chip tone="accent">Recommended</Chip>}
                                {s.requiresApiKey && (
                                  <Chip tone="warn" title={s.requiresApiKey}>
                                    Needs a key
                                  </Chip>
                                )}
                              </div>
                              {s.description && (
                                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                                  {s.description}
                                </p>
                              )}
                              <TraitLine traits={traits} />
                            </div>
                            <Toggle
                              on={s.enabled}
                              disabled={pending === s.name}
                              onClick={() => handleToggle(s)}
                              label={`${s.enabled ? 'Disable' : 'Enable'} ${s.title}`}
                            />
                          </div>
                          <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2 text-[11px]">
                            <StateDot tone={tone} pulse={s.state === 'connecting'} />
                            <span className={'shrink-0 font-medium ' + BOARD_TONE[tone].text}>
                              {MCP_STATE_LABEL[s.state]}
                            </span>
                            {detail && (
                              <span className="truncate text-muted" title={detail}>
                                — {detail}
                              </span>
                            )}
                            {s.source !== 'catalog' && (
                              <button
                                type="button"
                                onClick={() => void handleRemove(s)}
                                disabled={removing === s.name}
                                className="ml-auto shrink-0 font-medium text-muted transition-colors hover:text-red-600 disabled:opacity-50"
                              >
                                {removing === s.name ? 'Removing…' : 'Remove'}
                              </button>
                            )}
                          </div>
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
 *
 * Same board as Connectors, minus a connection: a skill is on or off, so its
 * `Needs setup` bucket is always empty and the filter strip drops that pill. What a
 * skill *can* be missing is a connector it depends on, and that is the one thing its
 * status row acts on — `Turn on GitHub` right there, rather than sending the user to
 * the other pane to work out which server the chip was naming.
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
  const [filter, setFilter] = useState<CatalogFilter>('all')

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

  const visible = skills.filter(
    (s) =>
      matchesFilter(s, filter) &&
      matchesQuery([s.name, s.title, s.description, SKILL_CATEGORY_LABEL[s.category]], query)
  )
  const groups = groupByCategory(visible, SKILL_CATEGORY_ORDER, (s) => s.category)
  const counts = filterCounts(skills)

  return (
    <section className="space-y-3">
      <BoardHeader
        noun="skills"
        on={counts.on}
        total={counts.all}
        filter={filter}
        onFilter={setFilter}
        counts={counts}
        query={query}
        onQuery={setQuery}
        searchPlaceholder="Search skills…"
        addLabel="+ Add"
        onAdd={() => setShowAdd(true)}
      >
        <GhostAction
          onClick={handleRestore}
          disabled={busy !== null}
          title="Revert every switch to its default (the safe essentials on)"
        >
          {busy === 'restore' ? 'Restoring…' : 'Reset'}
        </GhostAction>
        <GhostAction onClick={handleReload} disabled={busy !== null} title="Re-scan the skills folders on disk">
          {busy === 'reload' ? 'Reloading…' : 'Reload'}
        </GhostAction>
      </BoardHeader>

      {skills.length === 0 ? (
        <BoardEmpty
          message="No skills yet."
          action={
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="sylor-press rounded-md bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
            >
              + Write a skill
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <BoardEmpty
          message={emptyBoardMessage(filter, query, 'skills')}
          action={
            filter === 'all' ? undefined : (
              <GhostAction onClick={() => setFilter('all')}>Show all skills</GhostAction>
            )
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map(([cat, list]) => (
            <div key={cat} className="space-y-2">
              <GroupLegend label={SKILL_CATEGORY_LABEL[cat]} count={list.length} />
              <ul className="space-y-2">
                {list.map((s) => {
                  // A skill has no connection to fail, so its tone is the switch and
                  // nothing else — the board's `attention` bucket is always empty
                  // here and the filter strip drops that pill.
                  const tone: BoardTone = s.enabled ? 'on' : 'off'
                  const missing = s.requiresMcp.filter((dep) => !mcpByName.get(dep)?.enabled)
                  return (
                    <li
                      key={s.name}
                      className="rounded-xl border border-border bg-bg px-3 py-3 transition-colors hover:border-primary/40"
                    >
                      <div className="flex items-start gap-3">
                        <Monogram label={s.title} tone={tone} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={
                                    'truncate text-[13px] font-medium ' +
                                    (s.enabled ? 'text-text' : 'text-muted')
                                  }
                                >
                                  {s.title}
                                </span>
                                {s.recommended && <Chip tone="accent">Recommended</Chip>}
                              </div>
                              {s.description && (
                                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                                  {s.description}
                                </p>
                              )}
                              <TraitLine
                                traits={[
                                  { text: s.builtIn ? 'Built-in' : 'Custom' },
                                  ...(s.requiresMcp.length === 0
                                    ? []
                                    : missing.length === 0
                                      ? [{ text: 'Connectors ready' }]
                                      : [
                                          {
                                            text: `Needs ${missing
                                              .map((dep) => mcpByName.get(dep)?.title ?? dep)
                                              .join(', ')}`,
                                            tone: 'warn' as const
                                          }
                                        ])
                                ]}
                              />
                            </div>
                            <Toggle
                              on={s.enabled}
                              disabled={pending === s.name}
                              onClick={() => handleToggle(s)}
                              label={`${s.enabled ? 'Disable' : 'Enable'} ${s.title}`}
                            />
                          </div>
                          {(s.whenToUse || missing.length > 0 || s.source !== 'builtin') && (
                            <div className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-[11px]">
                              {s.whenToUse ? (
                                <span className="truncate text-muted" title={s.whenToUse}>
                                  <span className="text-muted/70">Use when</span> {s.whenToUse}
                                </span>
                              ) : (
                                <span className="text-muted/70">Invoked on request</span>
                              )}
                              <span className="ml-auto flex shrink-0 items-center gap-2">
                                {missing.map((dep) => (
                                  <button
                                    key={dep}
                                    type="button"
                                    onClick={() => handleEnableMcp(dep)}
                                    disabled={enablingMcp === dep}
                                    title={`Turn on the ${mcpByName.get(dep)?.title ?? dep} connector`}
                                    className="font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
                                  >
                                    {enablingMcp === dep
                                      ? 'Turning on…'
                                      : `Turn on ${mcpByName.get(dep)?.title ?? dep}`}
                                  </button>
                                ))}
                                {s.source !== 'builtin' && (
                                  <button
                                    type="button"
                                    onClick={() => void handleRemove(s)}
                                    disabled={removing === s.name}
                                    className="font-medium text-muted transition-colors hover:text-red-600 disabled:opacity-50"
                                  >
                                    {removing === s.name ? 'Removing…' : 'Remove'}
                                  </button>
                                )}
                              </span>
                            </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// Automation pane (Phase 4): scheduled prompts + lifecycle hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Automation pane. Two independent power-user features share one category:
 *  - **Scheduled tasks** — a stored prompt the main-process scheduler fires on a
 *    cron cadence into a *fresh* chat (durable ones survive a restart). Listed
 *    live through `window.sylor.scheduler`; the run still pauses at sensitive
 *    tools for approval, so nothing runs silently.
 *  - **Hooks** — shell commands the engine runs around the agent loop (before/
 *    after a tool, on prompt submit, on finish). They live inside
 *    `settings.hooks` and are edited through the ordinary settings save.
 */
function AutomationSection() {
  return (
    <div className="space-y-8">
      <ScheduledTasksSection />
      <div className="border-t border-border" />
      <HooksSection />
    </div>
  )
}

const TASK_MODE_OPTIONS: ReadonlyArray<{ id: WorkMode; label: string }> = [
  { id: 'cowork', label: 'Cowork' },
  { id: 'code', label: 'Code' }
]

/** A few ready-made cron cadences offered as one-click chips in the add modal. */
const CRON_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: 'Every day 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Mondays 8am', cron: '0 8 * * 1' }
]

/** Format an epoch-ms instant as a compact local date-time, or “—” when absent. */
function formatWhen(ms?: number): string {
  if (ms == null) return '—'
  try {
    return new Date(ms).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return '—'
  }
}

/** Lists the main-process scheduler's tasks with add / pause / remove controls. */
function ScheduledTasksSection() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  useEffect(() => {
    let cancelled = false
    const pull = (): void => {
      void window.sylor.scheduler.list().then((t) => {
        if (!cancelled) setTasks(t)
      })
    }
    pull()
    // A fire updates lastRunAt/nextRunAt on the task; re-pull so the list stays honest.
    const dispose = window.sylor.scheduler.onTaskFired(() => pull())
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  const refresh = (): void => {
    void window.sylor.scheduler.list().then(setTasks)
  }

  const handleToggle = async (task: ScheduledTask): Promise<void> => {
    setBusyId(task.id)
    try {
      await window.sylor.scheduler.setEnabled(task.id, !task.enabled)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (task: ScheduledTask): Promise<void> => {
    if (!window.confirm(`Remove the scheduled task “${task.name}”?`)) return
    setBusyId(task.id)
    try {
      await window.sylor.scheduler.remove(task.id)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text">Scheduled tasks</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
          A saved prompt Sylor runs on a schedule, in a fresh chat. The run still pauses at
          sensitive tools for approval — nothing runs silently. Durable tasks survive a restart.
        </p>
      </div>

      {tasks.length === 0 ? (
        <p className="text-[12px] text-muted">
          No scheduled tasks yet. Use “Add a scheduled task” below to run a prompt on a cadence.
        </p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li key={t.id} className="rounded-md border border-border bg-bg px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-text">{t.name}</span>
                    <Chip tone="muted" title="Cron schedule (local time)">
                      <span className="font-mono">{t.cron}</span>
                    </Chip>
                    {t.mode && <Chip tone="info">{t.mode === 'code' ? 'Code' : 'Cowork'}</Chip>}
                    {t.durable ? (
                      <Chip tone="accent" title="Saved to disk; reloads on restart">
                        Durable
                      </Chip>
                    ) : (
                      <Chip tone="muted" title="Cleared when Sylor quits">
                        Session
                      </Chip>
                    )}
                    {!t.enabled && <Chip tone="warn">Paused</Chip>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">
                    {t.prompt}
                  </p>
                  <p className="mt-1 text-[10px] text-muted">
                    Next {formatWhen(t.nextRunAt)} · Last {formatWhen(t.lastRunAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Toggle
                    on={t.enabled}
                    disabled={busyId === t.id}
                    onClick={() => void handleToggle(t)}
                    label={t.enabled ? `Pause ${t.name}` : `Resume ${t.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => void handleRemove(t)}
                    disabled={busyId === t.id}
                    className="text-[10px] font-medium text-muted transition-colors hover:text-red-300 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddButton label="+ Add a scheduled task" onClick={() => setShowAdd(true)} />

      {showAdd && (
        <AddScheduledTaskModal
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            refresh()
            setShowAdd(false)
          }}
        />
      )}
    </section>
  )
}

function AddScheduledTaskModal({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: (task: ScheduledTask) => void
}) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [mode, setMode] = useState<WorkMode>('cowork')
  const [durable, setDurable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Cheap gate only (five whitespace fields). The main-process scheduler is the
  // real validator — it rejects a malformed expression and we surface it below.
  const cronLooksValid = cron.trim().split(/\s+/).length === 5

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const input: ScheduledTaskInput = {
        name: name.trim(),
        prompt: prompt.trim(),
        cron: cron.trim(),
        durable,
        mode
      }
      const task = await window.sylor.scheduler.add(input)
      onAdded(task)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a scheduled task"
      subtitle="Sylor runs the prompt on this cadence in a fresh chat. Times are your local time."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" value={name} onChange={setName} placeholder="e.g. Morning triage" />
        <TextArea
          label="Prompt"
          value={prompt}
          onChange={setPrompt}
          placeholder="Summarise what changed in the repo since yesterday…"
          rows={5}
          hint="Sent as the first message of a brand-new chat each time the task fires."
        />
        <div className="flex flex-col gap-1.5">
          <Field
            label="Schedule (cron)"
            value={cron}
            onChange={setCron}
            placeholder="minute hour day month weekday — e.g. 0 9 * * 1-5"
            hint="Five fields, local time: minute, hour, day-of-month, month, day-of-week."
          />
          <div className="flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCron(p.cron)}
                className="rounded border border-border px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/50 hover:text-text"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
            Working mode
          </span>
          <Segmented
            value={mode}
            options={TASK_MODE_OPTIONS}
            onChange={setMode}
            ariaLabel="Working mode for the task"
          />
        </div>
        <label className="flex items-center justify-between gap-6">
          <span className="flex flex-col">
            <span className="text-[12px] font-medium text-text">Keep after restart</span>
            <span className="text-[11px] text-muted">
              Durable tasks are saved to disk and reload when Sylor starts.
            </span>
          </span>
          <Switch checked={durable} onChange={setDurable} label="Keep after restart" />
        </label>
        {error && <p className="text-[12px] text-red-300">{error}</p>}
        <ModalActions
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Add task"
          busy={busy}
          disabled={!name.trim() || !prompt.trim() || !cronLooksValid}
        />
      </div>
    </Modal>
  )
}

/** The four lifecycle points, in display order, each with a short + long label. */
const HOOK_EVENT_META: ReadonlyArray<{
  id: HookEvent
  short: string
  label: string
  blurb: string
  usesMatcher: boolean
}> = [
  {
    id: 'PreToolUse',
    short: 'Before tool',
    label: 'Before a tool runs',
    blurb:
      'Runs before a tool is dispatched. A non-zero exit blocks the tool (a timeout counts as a block).',
    usesMatcher: true
  },
  {
    id: 'PostToolUse',
    short: 'After tool',
    label: 'After a tool runs',
    blurb: 'Runs after a tool finished — e.g. a formatter or linter. It cannot block.',
    usesMatcher: true
  },
  {
    id: 'UserPromptSubmit',
    short: 'On prompt',
    label: 'When a run starts',
    blurb: 'Runs once when you submit a prompt, with the prompt text in the environment.',
    usesMatcher: false
  },
  {
    id: 'Stop',
    short: 'On finish',
    label: 'When a run finishes',
    blurb: 'Runs once when a run completes (not when you cancel it).',
    usesMatcher: false
  }
]

/** Reads/writes `settings.hooks`; add / remove per lifecycle event. */
function HooksSection() {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [showAdd, setShowAdd] = useState(false)

  const hooks = settings.hooks ?? {}
  const total = HOOK_EVENT_META.reduce((n, e) => n + (hooks[e.id]?.length ?? 0), 0)

  const persist = (next: HooksConfig): void => {
    void saveSettings({ ...settings, hooks: next })
  }

  const addHook = (event: HookEvent, def: HookDefinition): void => {
    persist({ ...hooks, [event]: [...(hooks[event] ?? []), def] })
  }

  const removeHook = (event: HookEvent, index: number): void => {
    const list = (hooks[event] ?? []).filter((_, i) => i !== index)
    const next: HooksConfig = { ...hooks }
    if (list.length) next[event] = list
    else delete next[event]
    persist(next)
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text">Hooks</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
          Shell commands Sylor runs at lifecycle points, in the workspace root. A “before a tool
          runs” hook that exits non-zero blocks the tool — handy for guardrails and formatters.
        </p>
      </div>

      {total === 0 ? (
        <p className="text-[12px] text-muted">
          No hooks yet. Use “Add a hook” below to run a command before/after a tool, on prompt
          submit, or when a run finishes.
        </p>
      ) : (
        <ul className="space-y-2">
          {HOOK_EVENT_META.flatMap((e) =>
            (hooks[e.id] ?? []).map((def, i) => (
              <li key={`${e.id}-${i}`} className="rounded-md border border-border bg-bg px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip tone="info">{e.label}</Chip>
                      {e.usesMatcher && (
                        <Chip tone="muted" title="Regex tested against the tool name">
                          {def.matcher ? (
                            <span className="font-mono">{def.matcher}</span>
                          ) : (
                            'all tools'
                          )}
                        </Chip>
                      )}
                      {def.timeoutMs != null && <Chip tone="muted">{def.timeoutMs} ms</Chip>}
                    </div>
                    <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-text">
                      {def.command}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeHook(e.id, i)}
                    className="shrink-0 text-[10px] font-medium text-muted transition-colors hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      )}

      <AddButton label="+ Add a hook" onClick={() => setShowAdd(true)} />

      {showAdd && (
        <AddHookModal
          onClose={() => setShowAdd(false)}
          onAdd={(event, def) => {
            addHook(event, def)
            setShowAdd(false)
          }}
        />
      )}
    </section>
  )
}

function AddHookModal({
  onClose,
  onAdd
}: {
  onClose: () => void
  onAdd: (event: HookEvent, def: HookDefinition) => void
}) {
  const [event, setEvent] = useState<HookEvent>('PreToolUse')
  const [matcher, setMatcher] = useState('')
  const [command, setCommand] = useState('')
  const [timeoutText, setTimeoutText] = useState('')

  const meta = HOOK_EVENT_META.find((e) => e.id === event) ?? HOOK_EVENT_META[0]

  const submit = (): void => {
    const cmd = command.trim()
    if (!cmd) return
    const def: HookDefinition = { command: cmd }
    if (meta.usesMatcher && matcher.trim()) def.matcher = matcher.trim()
    const ms = Number(timeoutText.trim())
    if (timeoutText.trim() && Number.isFinite(ms) && ms > 0) def.timeoutMs = Math.floor(ms)
    onAdd(event, def)
  }

  return (
    <Modal
      title="Add a hook"
      subtitle="A shell command Sylor runs at a lifecycle point, in the workspace root."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">When</span>
          <Segmented
            value={event}
            options={HOOK_EVENT_META.map((e) => ({ id: e.id, label: e.short }))}
            onChange={setEvent}
            ariaLabel="When the hook fires"
          />
          <span className="text-[11px] leading-relaxed text-muted">{meta.blurb}</span>
        </div>
        {meta.usesMatcher && (
          <Field
            label="Tool matcher (optional)"
            value={matcher}
            onChange={setMatcher}
            placeholder="Regex on the tool name — e.g. write_file|edit_file. Blank = all tools."
            hint="Tested against names like write_file, edit_file, run_command, read_file."
          />
        )}
        <TextArea
          label="Command"
          value={command}
          onChange={setCommand}
          placeholder="npx prettier --write ."
          rows={3}
          mono
          hint="Runs in the workspace root with SYLOR_* context env vars set."
        />
        <Field
          label="Timeout (ms, optional)"
          value={timeoutText}
          onChange={setTimeoutText}
          placeholder="e.g. 5000"
          hint="Max run time before the hook is killed. A timeout blocks a “before a tool runs” hook."
        />
        <ModalActions
          onClose={onClose}
          onSubmit={submit}
          submitLabel="Add hook"
          busy={false}
          disabled={!command.trim()}
        />
      </div>
    </Modal>
  )
}

export function SettingsPanel() {
  const storedSettings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const previewModels = useAppStore((s) => s.previewModels)
  const models = useAppStore((s) => s.models)
  const modelsLoading = useAppStore((s) => s.modelsLoading)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  // The sidebar's Connectors/Skills/Commands/Plugins/Model rows deep-link here
  // via openSettings(tab). The panel is mounted fresh on each open, so seeding
  // the initial category from the requested tab is all it takes to land there.
  const settingsTab = useAppStore((s) => s.settingsTab)

  const [category, setCategory] = useState<SettingsCategory>(settingsTab ?? 'general')

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
            {category === 'browsing' && <BrowserPermissionsSection />}
            {category === 'automation' && <AutomationSection />}

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
