/**
 * BrowserPanel — the right-side BROWSER panel, and the whole of what used to be
 * the separate browser destination it replaced.
 *
 * It is a control surface, not a browser widget: the page itself is a
 * `WebContentsView` the MAIN process owns and draws over this panel's rectangle.
 * That is deliberate — main owning the page is what lets the engine's `browse`
 * tool drive it directly, with no main → renderer → main round-trip. So the two
 * things this component must get right are:
 *
 *  1. **Where** the page goes — a `ResizeObserver` reports this panel's rect to
 *     `browser.setBounds` on every layout change.
 *  2. **Whether** it shows — a native view floats *above* the DOM, so anything
 *     that must be readable (the launcher, the real-Chrome stage, a settings
 *     overlay) requires hiding it first, and closing the panel must hide it too.
 *
 * The driver switch picks which browser the agent uses: the in-app view, or the
 * user's real Chrome over CDP (where signed-in web apps actually work).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserDriver, BrowserViewStatus, ChromeStatus } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { ESSENTIAL_APPS, needsRealBrowser } from '@renderer/lib/browser/apps'
import { AppGlyph } from './appIcons'
import { IconBack, IconClose, IconForward, IconHome, IconReload, IconSearch } from './icons'
import { ChromeStage } from './ChromeStage'

const NO_VIEW: BrowserViewStatus = {
  attached: false,
  visible: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

const NO_CHROME: ChromeStatus = {
  available: false,
  browserName: '',
  running: false,
  url: '',
  title: '',
  loading: false,
  signingIn: false,
  error: null
}

export function BrowserPanel() {
  const [view, setView] = useState<BrowserViewStatus>(NO_VIEW)
  const [chrome, setChrome] = useState<ChromeStatus>(NO_CHROME)
  const [driver, setDriver] = useState<BrowserDriver>('app')
  const [address, setAddress] = useState('')
  // The launcher is a DOM overlay, so it can only be seen with the native view
  // hidden — hence its own state rather than a url check.
  const [atHome, setAtHome] = useState(true)
  const [chromeBusy, setChromeBusy] = useState(false)
  const [chromeError, setChromeError] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeBrowser = useAppStore((s) => s.closeBrowser)

  const onChrome = driver === 'chrome'
  // Everything that must be legible has to win over a view that floats above the DOM.
  const showPage = !onChrome && !atHome && !settingsOpen

  // ── 1. Where the page goes ──
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      void window.sylor.browser.setBounds({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    // A resize/move changes the rect without resizing the element (the panel keeps
    // its share of a smaller window), so the observer alone is not enough.
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  // ── 2. Whether it shows ──
  useEffect(() => {
    void window.sylor.browser.setVisible(showPage)
  }, [showPage])

  // Hide on unmount: the panel closing must never leave a page floating over the chat.
  useEffect(() => {
    return () => {
      void window.sylor.browser.setVisible(false)
    }
  }, [])

  // Mirror both browsers' status. `onStatus` fires on url/title/loading changes,
  // so the address field and the nav buttons stay live in either mode.
  useEffect(() => {
    void window.sylor.browser.status().then(setView)
    void window.sylor.chrome.status().then(setChrome)
    const offView = window.sylor.browser.onStatus(setView)
    const offChrome = window.sylor.chrome.onStatus(setChrome)
    return () => {
      offView()
      offChrome()
    }
  }, [])

  // Follow whichever browser is selected, unless the user is mid-edit (focus).
  const editing = useRef(false)
  const liveUrl = onChrome ? chrome.url : view.url
  useEffect(() => {
    if (editing.current) return
    setAddress(liveUrl === 'about:blank' ? '' : liveUrl)
  }, [liveUrl])

  /** Switch which browser the agent drives, keeping main in step with the UI. */
  const pickDriver = useCallback(async (next: BrowserDriver): Promise<void> => {
    setDriver(next)
    setChromeError(null)
    await window.sylor.browser.setDriver(next)
    if (next !== 'chrome') return
    // Selecting the real browser is also the request to open it.
    setChromeBusy(true)
    try {
      setChrome(await window.sylor.chrome.open())
    } catch (err) {
      setChromeError(err instanceof Error ? err.message : String(err))
    } finally {
      setChromeBusy(false)
    }
  }, [])

  const openUrl = useCallback(
    async (url: string): Promise<void> => {
      // Google refuses sign-in inside ANY embedded browser — measured, and not a
      // thing a better user agent fixes. So a Google-account URL goes straight to
      // the real browser instead of walking the user into a refusal page.
      if (!onChrome && needsRealBrowser(url)) {
        await pickDriver('chrome')
        setChromeBusy(true)
        try {
          setChrome(await window.sylor.chrome.navigate(url))
        } catch (err) {
          setChromeError(err instanceof Error ? err.message : String(err))
        } finally {
          setChromeBusy(false)
        }
        return
      }
      if (onChrome) {
        setChromeBusy(true)
        try {
          setChrome(await window.sylor.chrome.navigate(url))
        } catch (err) {
          setChromeError(err instanceof Error ? err.message : String(err))
        } finally {
          setChromeBusy(false)
        }
        return
      }
      setAtHome(false)
      setView(await window.sylor.browser.open(url))
    },
    [onChrome, pickDriver]
  )

  const go = (delta: number): void => {
    void (onChrome ? window.sylor.chrome.go(delta) : window.sylor.browser.go(delta))
  }
  const reload = (): void => {
    void (onChrome ? window.sylor.chrome.reload() : window.sylor.browser.reload())
  }

  const loading = onChrome ? chrome.loading : view.loading
  const chromeLabel =
    chrome.browserName && chrome.available
      ? `My ${chrome.browserName.replace(/^Google /, '')}`
      : 'My browser'

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-bg">
      {/* ── Address row ── */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const value = address.trim()
          if (value) void openUrl(value)
        }}
        className="flex items-center gap-1 border-b border-border bg-surface px-2 py-2"
      >
        <button
          type="button"
          aria-label="Back"
          disabled={!onChrome && !view.canGoBack}
          onClick={() => go(-1)}
          className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
        >
          <IconBack />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={!onChrome && !view.canGoForward}
          onClick={() => go(1)}
          className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
        >
          <IconForward />
        </button>
        <button
          type="button"
          aria-label={loading ? 'Stop' : 'Reload'}
          onClick={() => {
            if (!loading) return reload()
            void (onChrome ? window.sylor.chrome.stop() : window.sylor.browser.stop())
          }}
          className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <IconReload spinning={loading} />
        </button>
        <button
          type="button"
          aria-label="Home"
          onClick={() => setAtHome(true)}
          className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <IconHome />
        </button>

        <span className="ml-1 shrink-0 text-muted">
          <IconSearch />
        </span>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => {
            editing.current = true
          }}
          onBlur={() => {
            editing.current = false
          }}
          placeholder="Search or enter a web address"
          aria-label="Address bar"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none transition-colors placeholder:text-muted focus:border-text/35"
        />

        {/* Which browser Sylor drives. The in-app one is instant, but Google refuses
            to sign in to it — this switch is how Gmail and every other
            account-backed webapp become reachable. */}
        <div
          role="group"
          aria-label="Browser Sylor drives"
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-bg p-0.5"
        >
          <button
            type="button"
            aria-pressed={!onChrome}
            onClick={() => void pickDriver('app')}
            className={
              'rounded-md px-2 py-1 text-[11px] font-medium transition-colors ' +
              (onChrome ? 'text-muted hover:text-text' : 'bg-surface-2 text-text')
            }
          >
            In app
          </button>
          <button
            type="button"
            aria-pressed={onChrome}
            onClick={() => void pickDriver('chrome')}
            title="Drive the real browser on this computer — signed-in sites like Gmail work there"
            className={
              'rounded-md px-2 py-1 text-[11px] font-medium transition-colors ' +
              (onChrome ? 'bg-surface-2 text-text' : 'text-muted hover:text-text')
            }
          >
            {chromeLabel}
          </button>
        </div>

        <button
          type="button"
          aria-label="Close browser"
          onClick={closeBrowser}
          className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <IconClose />
        </button>
      </form>

      {/* ── Stage: the rectangle the native page view is drawn into ── */}
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-white">
        {/* Launcher — shown with the page hidden, since a native view floats above DOM. */}
        {!onChrome && atHome && (
          <div className="absolute inset-0 h-full w-full overflow-y-auto bg-bg">
            <div className="mx-auto w-full max-w-2xl px-7 py-8">
              <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-muted">
                Pinned
              </p>
              <div className="grid grid-cols-5 gap-x-3 gap-y-5">
                {ESSENTIAL_APPS.map((app) => (
                  <button
                    key={app.key}
                    type="button"
                    onClick={() => void openUrl(app.url)}
                    title={app.label}
                    className="group flex min-w-0 flex-col items-center gap-1.5 py-1 outline-none"
                  >
                    <span className="grid h-11 w-11 place-items-center overflow-hidden rounded-xl bg-white ring-1 ring-black/5 transition-transform duration-150 group-hover:-translate-y-0.5 group-focus-visible:-translate-y-0.5">
                      <AppGlyph appKey={app.key} />
                    </span>
                    <span className="max-w-[76px] truncate text-[11px] text-muted transition-colors group-hover:text-text">
                      {app.label}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-7 text-[11.5px] leading-relaxed text-muted">
                Ask Sylor in the chat to do something here — “open my inbox and tell me what
                needs a reply”. It works the page like a person would, and asks first before
                anything that sends, deletes, or spends.
              </p>
            </div>
          </div>
        )}

        {/* Real-browser mode: a control surface for the window outside Sylor. */}
        {onChrome && (
          <ChromeStage
            chrome={chrome}
            busy={chromeBusy}
            error={chromeError}
            onOpen={async () => {
              setChromeBusy(true)
              try {
                setChrome(await window.sylor.chrome.open())
              } catch (err) {
                setChromeError(err instanceof Error ? err.message : String(err))
              } finally {
                setChromeBusy(false)
              }
            }}
            onSignIn={async () => {
              setChromeBusy(true)
              try {
                setChrome(await window.sylor.chrome.signIn())
              } catch (err) {
                setChromeError(err instanceof Error ? err.message : String(err))
              } finally {
                setChromeBusy(false)
              }
            }}
            onFinishSignIn={async () => {
              setChromeBusy(true)
              try {
                setChrome(await window.sylor.chrome.finishSignIn())
              } catch (err) {
                setChromeError(err instanceof Error ? err.message : String(err))
              } finally {
                setChromeBusy(false)
              }
            }}
            onCloseChrome={async () => {
              setChromeBusy(true)
              try {
                setChrome(await window.sylor.chrome.close())
              } catch (err) {
                setChromeError(err instanceof Error ? err.message : String(err))
              } finally {
                setChromeBusy(false)
              }
            }}
            onFocus={() => void window.sylor.chrome.focus()}
            onBackToApp={() => void pickDriver('app')}
          />
        )}

        {/* A failed in-app navigation, explained where the page would have been. */}
        {showPage && view.error && (
          <div className="absolute inset-x-0 top-0 z-10 bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-200/90">
            {view.error}
          </div>
        )}
      </div>
    </div>
  )
}
