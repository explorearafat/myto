/**
 * ChromeStage — what the browser panel shows while Sylor is driving the user's
 * **real** Chrome.
 *
 * There is deliberately no mirrored picture of that browser here. It is a genuine
 * Chrome window sitting next to Sylor, and streaming its frames back into this
 * panel (`Page.startScreencast`) would cost latency and complexity to show the
 * user something they can already see — and can click, scroll and type into
 * directly.
 *
 * So this is a *control surface*: what page the browser is on, whether Sylor is
 * attached, and the handful of buttons that only make sense from in here (bring
 * the window forward to sign in, hand control back to the in-app page view, shut
 * the window down). The address row above it already routes to whichever browser
 * is selected, so typing a URL works the same in both modes.
 */
import type { ChromeStatus } from '@shared/types'
import { IconShield, IconWarn } from './icons'

/** Shorten a url for display: host + a clipped path, no scheme. */
function prettyUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    const tail = `${path}${parsed.search}`
    return parsed.host + (tail.length > 42 ? tail.slice(0, 42) + '…' : tail)
  } catch {
    return url
  }
}

export interface ChromeStageProps {
  chrome: ChromeStatus
  busy: boolean
  error: string | null
  onOpen: () => void | Promise<void>
  onSignIn: () => void | Promise<void>
  onFinishSignIn: () => void | Promise<void>
  onCloseChrome: () => void | Promise<void>
  onFocus: () => void
  onBackToApp: () => void
}

export function ChromeStage({
  chrome,
  busy,
  error,
  onOpen,
  onSignIn,
  onFinishSignIn,
  onCloseChrome,
  onFocus,
  onBackToApp
}: ChromeStageProps) {
  const missing = !chrome.available && !chrome.running
  const page = prettyUrl(chrome.url)
  const browser = chrome.browserName || 'your browser'

  return (
    <div className="absolute inset-0 z-30 grid place-items-center overflow-y-auto bg-bg p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-surface-2 text-primary">
          {missing || error ? <IconWarn /> : <IconShield />}
        </div>

        {missing ? (
          <>
            <h2 className="text-[16px] font-medium text-text">No browser to drive</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
              Sylor drives a real Chrome, Edge or Chromium already installed on this
              computer, and couldn’t find one. Install Chrome, then try again.
            </p>
          </>
        ) : chrome.signingIn ? (
          <>
            <h2 className="text-[16px] font-medium text-text">Sign in over in that window</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
              Sylor opened a plain {browser} window and let go of it completely — Google
              refuses to sign in to a browser that something else is controlling, so this one
              has nothing attached. Sign in there, then press Done and Sylor picks the profile
              back up. You only do this once per account.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-[16px] font-medium text-text">
              {chrome.running
                ? `Sylor is driving ${browser}`
                : busy
                  ? `Opening ${browser}…`
                  : `Ready to drive ${browser}`}
            </h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
              It opens as its own window beside Sylor — a real browser, so any site or webapp
              works, Gmail included. It uses a profile Sylor made for it, so sign in once with
              the button below and it stays signed in from then on.
            </p>
            {/* Where the browser actually is right now (mirrored, so this is live). */}
            {page && (
              <div className="mx-auto mt-3 flex max-w-sm items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                <span
                  className={
                    'h-1.5 w-1.5 shrink-0 rounded-full ' +
                    (chrome.loading ? 'animate-pulse bg-primary' : 'bg-primary/60')
                  }
                />
                <span className="min-w-0 truncate text-[12px] text-text">
                  {chrome.title || page}
                </span>
                {chrome.title && <span className="shrink-0 text-[11px] text-muted">{page}</span>}
              </div>
            )}
          </>
        )}

        {(error ?? chrome.error) && (
          <p className="mx-auto mt-3 max-w-sm rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text">
            {error ?? chrome.error}
          </p>
        )}

        {/* Controls that only make sense from in here. "Sign in" hands the profile to
            a window Sylor deliberately isn't driving. */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {chrome.signingIn ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onFinishSignIn()}
              className="sylor-press rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Resuming…' : 'Done — resume Sylor'}
            </button>
          ) : (
            <>
              {chrome.running && (
                <button
                  type="button"
                  onClick={onFocus}
                  className="sylor-press rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90"
                >
                  Bring to front
                </button>
              )}
              {!chrome.running && !missing && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onOpen()}
                  className="sylor-press rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Opening…' : 'Open it'}
                </button>
              )}
              {/* Sign-in is its own button because it can't happen in the driven
                  window: Sylor has to let go of the profile first. */}
              {!missing && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onSignIn()}
                  className="sylor-press rounded-lg bg-surface-2 px-3.5 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-border disabled:opacity-50"
                >
                  Sign in
                </button>
              )}
              <button
                type="button"
                onClick={onBackToApp}
                className="sylor-press rounded-lg bg-surface-2 px-3.5 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-border"
              >
                Back to in-app browser
              </button>
              {chrome.running && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onCloseChrome()}
                  className="sylor-press rounded-lg bg-surface-2 px-3.5 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-border disabled:opacity-50"
                >
                  Close it
                </button>
              )}
            </>
          )}
        </div>

        {/* The tradeoff, stated plainly rather than buried: a controllable browser is
            a capability, and the user should know its bounds. */}
        <p className="mx-auto mt-4 max-w-sm text-[11px] leading-relaxed text-muted">
          Sylor drives it through a private control port on this computer only, using a
          separate browser profile it created — not your everyday Chrome profile — and closes
          it when Sylor quits. Sign-ins you do there stay in that profile.
        </p>
      </div>
    </div>
  )
}
