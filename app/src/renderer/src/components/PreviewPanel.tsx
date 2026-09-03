import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import { setPreviewWebview } from '@renderer/lib/preview/inspector'
import type { WebviewElement } from '@renderer/types/webview'

/** True for the localhost origins the preview server is ever allowed to serve. */
function isLocalhost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/** Circular-arrow reload glyph, matching the header icon set. */
function ReloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M15.5 6.8A6 6 0 1 0 16.2 11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M15.8 3.7v3.2h-3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Arrow-out-of-box (open externally) glyph. */
function ExternalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M8.5 5.5H5A1.5 1.5 0 0 0 3.5 7v8A1.5 1.5 0 0 0 5 16.5h8A1.5 1.5 0 0 0 14.5 15v-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 4.5h4.5V9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15.2 4.8 9 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Close (X) glyph. */
function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5.5 5.5l9 9M14.5 5.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

const iconButton =
  'grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40'

/**
 * Right-side live preview panel (Phase 2). Shows whatever the main-process
 * preview server is serving — static HTML from the sandbox root, or a spawned
 * dev server — inside an Electron `<webview>` running in its own `preview`
 * session partition (so the strict app CSP never clamps guest content, and the
 * guest is only ever pointed at localhost).
 *
 * All lifecycle state is mirrored into the store by the `preview:event`
 * subscription in useAppStore; this component is a pure view over it plus a few
 * imperative webview calls (reload on file-change, route external links out).
 */
export function PreviewPanel() {
  const url = useAppStore((s) => s.previewUrl)
  const phase = useAppStore((s) => s.previewPhase)
  const error = useAppStore((s) => s.previewError)
  const reloadNonce = useAppStore((s) => s.previewReloadNonce)
  const closePreview = useAppStore((s) => s.closePreview)
  const showLocalPreviewUrl = useAppStore((s) => s.showLocalPreviewUrl)

  const webviewRef = useRef<WebviewElement | null>(null)
  // Register the live guest with the inspector so engine `preview_inspect`
  // requests can drive it. React calls this with null on unmount (and before a
  // `key={url}` remount), which clears the inspector's ref + console buffer.
  const registerWebview = (el: WebviewElement | null): void => {
    webviewRef.current = el
    setPreviewWebview(el)
  }
  // Draft text for the editable address bar, kept in sync with the live URL so it
  // always reflects what's actually loaded until the user starts editing.
  const [address, setAddress] = useState('')
  useEffect(() => {
    setAddress(url ?? '')
  }, [url])

  // File-change reloads arrive as a bumped nonce (same URL). Skip the initial 0
  // so a freshly mounted webview isn't reloaded out from under its first load.
  useEffect(() => {
    if (reloadNonce > 0) webviewRef.current?.reload()
  }, [reloadNonce])

  // Keep navigation inside the preview: any attempt to leave localhost is sent to
  // the OS browser instead (window.open → main-process setWindowOpenHandler →
  // shell.openExternal) and the guest is snapped back to our page.
  useEffect(() => {
    const el = webviewRef.current
    if (!el || !url) return
    const onWillNavigate = (event: Event): void => {
      const target = (event as unknown as { url?: string }).url
      if (target && !isLocalhost(target)) {
        window.open(target, '_blank')
        el.stop()
        void el.loadURL(url)
      }
    }
    el.addEventListener('will-navigate', onWillNavigate as EventListener)
    return () => el.removeEventListener('will-navigate', onWillNavigate as EventListener)
  }, [url])

  // Submit the address bar: an http(s) value points the webview straight at it
  // (localhost only — showLocalPreviewUrl drops anything else); any other value is
  // treated as a project-relative path and served by the static file server.
  const submitAddress = (): void => {
    const value = address.trim()
    if (!value) return
    if (/^https?:\/\//i.test(value)) {
      showLocalPreviewUrl(value)
      return
    }
    void window.sylor.preview.startStatic(value)
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        <button
          type="button"
          aria-label="Reload preview"
          title="Reload"
          onClick={() => webviewRef.current?.reload()}
          disabled={!url}
          className={iconButton}
        >
          <ReloadIcon />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            submitAddress()
          }}
        >
          <input
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="localhost URL or project path (e.g. dist/index.html)"
            aria-label="Preview address"
            spellCheck={false}
            className="w-full truncate rounded-md bg-surface px-2 py-1 text-[11px] text-text outline-none focus:ring-1 focus:ring-primary/40"
          />
        </form>
        <button
          type="button"
          aria-label="Open in browser"
          title="Open in browser"
          onClick={() => url && window.open(url, '_blank')}
          disabled={!url}
          className={iconButton}
        >
          <ExternalIcon />
        </button>
        <button
          type="button"
          aria-label="Close preview"
          title="Close preview"
          onClick={closePreview}
          className={iconButton}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {phase === 'error' ? (
          <div className="grid h-full place-items-center p-6">
            <div className="max-w-sm rounded-lg border border-border bg-surface p-4 text-center">
              <p className="text-sm font-medium text-primary">Preview failed</p>
              <p className="mt-1 text-xs text-muted">
                {error ?? 'The live preview could not start.'}
              </p>
            </div>
          </div>
        ) : url ? (
          // `key={url}` remounts the guest when the target changes (static→dev or a
          // new port); same-URL file-change reloads go through reload() above.
          <webview
            key={url}
            ref={registerWebview}
            src={url}
            partition="preview"
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm text-muted">
                {phase === 'starting' ? 'Starting preview…' : 'Nothing to preview yet'}
              </p>
              <p className="mt-1 text-xs text-muted/70">
                {phase === 'starting'
                  ? 'Waiting for the server to come online.'
                  : 'When Sylor builds a page or starts a dev server, it shows up here.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
