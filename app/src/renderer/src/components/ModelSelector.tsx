import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'

/** A compact, pill-shaped selector used across the chat header / nav. */
export function Selector({
  label,
  value,
  onClick,
  tone = 'default',
  chevron = false
}: {
  /** Optional caption (e.g. "Mode"). Omit it to show the value alone — the
   * composer's model pill does this so it reads as "Opus 4.8" rather than
   * "MODEL Opus 4.8". */
  label?: string
  value: string
  onClick?: () => void
  /** `warn` tints the value amber. */
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

  // The model list comes from the account's config (mirrored into the store), so
  // opening the menu just toggles it — nothing to fetch.
  const toggle = (): void => setOpen((o) => !o)

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
                No models — add them on the website.
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

