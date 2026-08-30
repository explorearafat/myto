import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import type { PermissionMode, ReasoningEffort, WorkMode } from '@shared/types'

/** A compact, pill-shaped selector used across the chat header / nav. */
export function Selector({
  label,
  value,
  onClick,
  tone = 'default',
  chevron = false
}: {
  /** Optional caption (e.g. "Mode"). Omit it to show the value alone — the
   * composer's model/effort pills do this so they read as "Opus 4.8" / "High"
   * rather than "MODEL Opus 4.8". */
  label?: string
  value: string
  onClick?: () => void
  /** `warn` tints the value amber — used to flag the hands-free Autonomous mode. */
  tone?: 'default' | 'warn'
  /** Show a small caret hinting the pill opens a menu (used when the label is hidden). */
  chevron?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'group flex items-center gap-2 rounded-md border bg-surface px-2.5 py-1 text-left transition-colors ' +
        (tone === 'warn'
          ? 'border-amber-500/50 hover:border-amber-500'
          : 'border-border hover:border-primary/60')
      }
    >
      {label && <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>}
      <span
        className={'text-[12px] font-medium ' + (tone === 'warn' ? 'text-amber-400' : 'text-text')}
      >
        {value}
      </span>
      {chevron && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className="text-muted transition-transform group-hover:text-text"
        >
          <path
            d="M3 4.5L6 7.5l3-3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
}

/** The model selector: a pill that opens a dropdown of the provider's models. */
export function ModelSelector({ openUp = false }: { openUp?: boolean } = {}) {
  const model = useAppStore((s) => s.model)
  const models = useAppStore((s) => s.models)
  const modelsLoading = useAppStore((s) => s.modelsLoading)
  const activeModelId = useAppStore((s) => s.settings.modelId)
  const refreshModels = useAppStore((s) => s.refreshModels)
  const selectModel = useAppStore((s) => s.selectModel)
  const openSettings = useAppStore((s) => s.openSettings)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    // Lazily load the model list the first time the dropdown opens.
    if (next && models.length === 0 && !modelsLoading) void refreshModels()
  }

  // Anchor above the pill when it lives in the bottom composer, below otherwise.
  const menuPosition = openUp ? 'bottom-full mb-1' : 'top-full mt-1'

  return (
    <div ref={ref} className="relative">
      <Selector value={model || 'Select model'} onClick={toggle} chevron />
      {open && (
        <div
          className={`absolute left-0 z-30 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-xl ${menuPosition}`}
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {modelsLoading && (
              <div className="px-3 py-2 text-[12px] text-muted">Loading models…</div>
            )}
            {!modelsLoading && models.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-muted">
                No models found. Check provider settings.
              </div>
            )}
            {models.map((m) => {
              const active = m.id === activeModelId
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    void selectModel(m.id, m.name)
                    setOpen(false)
                  }}
                  className={
                    'flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-2 ' +
                    (active ? 'text-primary' : 'text-text')
                  }
                >
                  <span className="truncate">{m.name}</span>
                  {active && (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M3 8.5l3 3 7-7"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openSettings('model')
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              Provider settings…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Effort tiers shown in the composer selector, cheapest → most thorough. */
const EFFORT_OPTIONS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fast, direct answers' },
  { value: 'medium', label: 'Medium', hint: 'Balanced (default)' },
  { value: 'high', label: 'High', hint: 'Reasons step by step' },
  { value: 'max', label: 'Max', hint: 'Deliberates thoroughly' }
]

/**
 * Reasoning-effort selector: a pill that opens a dropdown of effort tiers. The
 * chosen effort is threaded into every workflow run (engine system prompt), so
 * it genuinely changes how the model deliberates.
 */
export function EffortSelector({ openUp = false }: { openUp?: boolean } = {}) {
  const effort = useAppStore((s) => s.effort)
  const setEffort = useAppStore((s) => s.setEffort)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = EFFORT_OPTIONS.find((o) => o.value === effort) ?? EFFORT_OPTIONS[1]
  const menuPosition = openUp ? 'bottom-full mb-1' : 'top-full mt-1'

  return (
    <div ref={ref} className="relative">
      <Selector value={current.label} onClick={() => setOpen((v) => !v)} chevron />
      {open && (
        <div
          className={`absolute left-0 z-30 w-52 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl ${menuPosition}`}
        >
          {EFFORT_OPTIONS.map((o) => {
            const active = o.value === effort
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  void setEffort(o.value)
                  setOpen(false)
                }}
                className={
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2 ' +
                  (active ? 'text-primary' : 'text-text')
                }
              >
                <span className="flex flex-col">
                  <span className="text-[12px] font-medium">{o.label}</span>
                  <span className="text-[10px] text-muted">{o.hint}</span>
                </span>
                {active && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Permission modes shown in the composer selector, safest first.
 *
 * `ask` confirms every edit and command. `auto-edit` auto-applies file edits but
 * still asks before running commands. `autonomous` is the opt-in hands-free
 * posture (requirement D): it auto-approves edits, commands, AND MCP calls so a
 * build can run end-to-end — but every action is still surfaced as a card and
 * sandboxed to the workspace root, and the mode is non-persistent (it resets to
 * `ask` on relaunch, so it can never be left on by accident).
 */
const MODE_OPTIONS: { value: PermissionMode; label: string; hint: string; warn?: boolean }[] = [
  { value: 'ask', label: 'Ask', hint: 'Approve every edit & command' },
  { value: 'auto-edit', label: 'Auto-edit', hint: 'Auto-apply edits; ask to run commands' },
  {
    value: 'autonomous',
    label: 'Autonomous',
    hint: 'Hands-free: auto-runs edits, commands & tools',
    warn: true
  }
]

/**
 * Permission-mode selector: a pill that opens a dropdown of postures. The chosen
 * mode governs how the engine auto-approves edits (see decideAuto); commands are
 * always confirmed regardless of the selected mode.
 */
export function ModeSelector({ openUp = false }: { openUp?: boolean } = {}) {
  const permissionMode = useAppStore((s) => s.permissionMode)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = MODE_OPTIONS.find((o) => o.value === permissionMode) ?? MODE_OPTIONS[0]
  const menuPosition = openUp ? 'bottom-full mb-1' : 'top-full mt-1'

  return (
    <div ref={ref} className="relative">
      <Selector
        label="Mode"
        value={current.label}
        tone={current.warn ? 'warn' : 'default'}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          className={`absolute left-0 z-30 w-64 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl ${menuPosition}`}
        >
          {MODE_OPTIONS.map((o) => {
            const active = o.value === permissionMode
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  setPermissionMode(o.value)
                  setOpen(false)
                }}
                className={
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2 ' +
                  (active ? (o.warn ? 'text-amber-400' : 'text-primary') : 'text-text')
                }
              >
                <span className="flex flex-col">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    {o.label}
                    {o.warn && (
                      <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-400">
                        hands-free
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-muted">{o.hint}</span>
                </span>
                {active && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Plan-first toggle: a pill that flips the composer's "write plan.md first"
 * posture. When on, an edit turn is told to emit only a `plan.md` and stop, so
 * the user reviews the plan before any code lands. Persisted via settings.
 */
export function PlanFirstToggle() {
  const planFirst = useAppStore((s) => s.planFirst)
  const setPlanFirst = useAppStore((s) => s.setPlanFirst)

  return (
    <button
      type="button"
      onClick={() => void setPlanFirst(!planFirst)}
      aria-pressed={planFirst}
      title={
        planFirst
          ? 'Plan-first is on: edits write plan.md first, then pause'
          : 'Plan-first is off: edits proceed directly'
      }
      className={
        'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-left transition-colors ' +
        (planFirst
          ? 'border-primary/60 bg-primary/10 text-primary'
          : 'border-border bg-surface text-muted hover:border-primary/60 hover:text-text')
      }
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M4 2.5h6l2.5 2.5V13.5H4z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M6 6.5h4M6 9h4M6 11.5h2.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[12px] font-medium">Plan first</span>
    </button>
  )
}

/** The two top-level working modes shown in the composer's segmented control. */
const WORK_MODE_OPTIONS: { value: WorkMode; label: string; title: string }[] = [
  {
    value: 'cowork',
    label: 'Cowork',
    title: 'Cowork: chat only — Sylor answers and writes code in the message. No file or terminal access.'
  },
  {
    value: 'code',
    label: 'Code',
    title: 'Code: work on your folder — Sylor reads files, edits, and runs commands (with approval).'
  }
]

/**
 * Cowork / Code selector: a segmented control picking the top-level working
 * mode. Cowork is a ChatGPT-like chat with no folder access; Code is the full
 * folder agent. This is the primary composer control — distinct from the
 * permission "Mode" pill, which only governs edit/command approval *within*
 * Code mode (and is hidden while Cowork is active).
 */
export function WorkModeSelector() {
  const workMode = useAppStore((s) => s.workMode)
  const setWorkMode = useAppStore((s) => s.setWorkMode)

  return (
    <div
      role="group"
      aria-label="Working mode"
      className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
    >
      {WORK_MODE_OPTIONS.map((o) => {
        const active = o.value === workMode
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => void setWorkMode(o.value)}
            aria-pressed={active}
            title={o.title}
            className={
              'rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors ' +
              (active ? 'bg-primary text-bg' : 'text-muted hover:text-text')
            }
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
