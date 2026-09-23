import { useEffect, useState } from 'react'

/** A single window-control button. Marked no-drag so clicks aren't swallowed by the drag region. */
function ControlButton({
  label,
  onClick,
  variant = 'default',
  children
}: {
  label: string
  onClick: () => void
  variant?: 'default' | 'danger'
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{ WebkitAppRegion: 'no-drag' }}
      className={
        'flex h-full w-11 items-center justify-center text-muted transition-colors ' +
        (variant === 'danger'
          ? 'hover:bg-red-600/80 hover:text-white'
          : 'hover:bg-surface-2 hover:text-text')
      }
    >
      {children}
    </button>
  )
}

/**
 * A seamless, draggable title strip for the frameless window. It carries no brand
 * or border — it blends into the paper background so the app reads as one flat
 * sheet (Claude-desktop style), with the wordmark living in the sidebar instead.
 * Only the window controls opt out of dragging so they stay clickable.
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    let active = true
    window.myto.window.isMaximized().then((value) => {
      if (active) setIsMaximized(value)
    })
    const unsubscribe = window.myto.window.onMaximizedChange(setIsMaximized)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return (
    <div
      style={{ WebkitAppRegion: 'drag' }}
      className="flex h-8 shrink-0 items-center justify-end bg-bg select-none"
    >
      <div className="flex h-full items-stretch">
        <ControlButton label="Minimize" onClick={() => window.myto.window.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
          </svg>
        </ControlButton>
        <ControlButton
          label={isMaximized ? 'Restore' : 'Maximize'}
          onClick={() => window.myto.window.toggleMaximize()}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" />
              <rect
                x="0.5"
                y="2.5"
                width="7"
                height="7"
                fill="var(--color-bg)"
                stroke="currentColor"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            </svg>
          )}
        </ControlButton>
        <ControlButton label="Close" variant="danger" onClick={() => window.myto.window.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
          </svg>
        </ControlButton>
      </div>
    </div>
  )
}
