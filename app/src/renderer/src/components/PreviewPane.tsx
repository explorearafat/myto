import { useEffect, useRef, useState } from 'react'
import { usePreviewStore, currentTarget } from '../store/usePreviewStore'

/**
 * Myto's preview pane (Cowork): a small browser beside the chat that Myto drives
 * with the `preview` tool to show its work as it goes — a plan, an HTML page, a
 * generated PDF/chart/image, or a localhost dev server. The user gets ordinary
 * browser controls over it (back / forward / reload / pop out / close).
 *
 * The guest is an isolated `<webview>` on its own `partition="preview"` session, so
 * the strict app CSP never clamps it and its cookies/storage stay walled off from
 * the app. It is driven ENTIRELY by props: the `src` and a `key` composed from the
 * URL + reload nonce. Navigating (back/forward) changes the URL, reloading bumps
 * the nonce; either way the `key` changes and React remounts the guest with a fresh
 * `src`. Nothing ever calls an imperative `reload()`/`goBack()` on the element —
 * doing that from a React effect is what crashed this panel before.
 */

/**
 * The sliver of the Electron `<webview>` element we touch: it's an Element +
 * EventTarget, so we only need `addEventListener` (load-state events) and
 * `setAttribute` (to enable the built-in PDF/plugin viewer). Typed locally to avoid
 * pulling the Electron namespace (absent from the web tsconfig) into the renderer.
 */
type PreviewGuest = Pick<Element, 'addEventListener' | 'setAttribute'>

/** A compact header control button. */
function PaneButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

export function PreviewPane() {
  const target = usePreviewStore(currentTarget)
  const index = usePreviewStore((s) => s.index)
  const historyLen = usePreviewStore((s) => s.history.length)
  const reloadNonce = usePreviewStore((s) => s.reloadNonce)
  const back = usePreviewStore((s) => s.back)
  const forward = usePreviewStore((s) => s.forward)
  const reload = usePreviewStore((s) => s.reload)
  const close = usePreviewStore((s) => s.close)
  const openExternal = usePreviewStore((s) => s.openExternal)

  const url = target?.url ?? ''
  const guestKey = `${url}#${reloadNonce}`

  // A quiet top loading bar while the guest fetches. Reset whenever the guest
  // remounts (new key), cleared when it stops loading. The listener is attached via
  // a ref callback — safe, unlike calling methods on the element imperatively.
  const [loading, setLoading] = useState(true)
  useEffect(() => setLoading(true), [guestKey])
  const attach = useRef<((el: PreviewGuest | null) => void) | null>(null)
  attach.current = (el): void => {
    if (!el) return
    // Enable Chromium's built-in viewer (so a file:// PDF renders in-pane). Set as
    // a plain attribute — React would serialise a `plugins` JSX prop wrong.
    el.setAttribute('plugins', '')
    const stop = (): void => setLoading(false)
    el.addEventListener('did-stop-loading', stop)
    el.addEventListener('did-fail-load', stop)
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-bg">
      {/* Header: identity on the left, browser controls on the right. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center text-muted">
          {target?.kind === 'url' ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M2 8h12M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14M8 2C6.2 3.6 5.2 5.8 5.2 8S6.2 12.4 8 14"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M9 1.75H4a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.75L9 1.75Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <path d="M9 1.75V5.75h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text" title={target?.title}>
            {target?.title || 'Preview'}
          </div>
          <div className="text-[10px] text-muted">Myto preview</div>
        </div>

        <PaneButton label="Back" disabled={index <= 0} onClick={back}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </PaneButton>
        <PaneButton label="Forward" disabled={index >= historyLen - 1} onClick={forward}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </PaneButton>
        <PaneButton label="Reload" onClick={reload}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </PaneButton>
        <PaneButton label="Open in my browser" onClick={openExternal}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6.5 3H3.5A1 1 0 0 0 2.5 4v8.5a1 1 0 0 0 1 1H12a1 1 0 0 0 1-1v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9.5 2.5H13.5V6.5M13 3L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </PaneButton>
        <PaneButton label="Close preview" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </PaneButton>
      </div>

      {/* The loading shimmer sits just under the header. */}
      <div className="h-0.5 shrink-0 overflow-hidden bg-transparent">
        {loading && <div className="myto-preview-bar h-full w-1/3 bg-primary/70" />}
      </div>

      {/* The guest. Keyed remounts on navigate/reload keep it purely prop-driven. */}
      <div className="min-h-0 flex-1 bg-white">
        {url ? (
          <webview
            key={guestKey}
            ref={(el) => attach.current?.(el as unknown as PreviewGuest | null)}
            src={url}
            partition="preview"
            className="h-full w-full"
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-muted">Nothing to preview yet.</div>
        )}
      </div>
    </div>
  )
}
