/**
 * SyloriumBrowser — the "browser" pane of the Sylorium environment (left half).
 *
 * A curated browser, not a generic one: its home is the app launcher (a grid of
 * essential web apps + a search box), and it deliberately has NO address bar. When
 * a page is open it shows a slim tab strip and a minimal nav bar (back · home ·
 * read-only title · reload); at the launcher those are hidden for a clean start
 * screen. It reads and drives the shared {@link SyloriumEnv}, so the tab shown here
 * is exactly the page Sylor (in the chat pane) can see and control. The user's own
 * clicks and typing are never gated — that's just browsing; only AI-initiated
 * actions pass through the permission system (surfaced by the AI ring).
 */
import type { SyloriumEnv } from './useSyloriumEnv'
import { USER_AGENT, diagnose } from './useSyloriumEnv'
import { SyloriumLauncher } from './SyloriumLauncher'
import { IconBack, IconClose, IconHome, IconPlus, IconReload, IconWarn } from './icons'

/** Best-effort host label for the read-only title (falls back gracefully). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function SyloriumBrowser({ env }: { env: SyloriumEnv }) {
  const { tabs, activeId, active } = env
  const onPage = !!active && !active.atHome
  // Keep the launcher clean: hide the tab strip when a lone tab is at home.
  const showTabs = tabs.length > 1 || onPage

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-bg">
      {/* ── Tab strip — only when a page is open or there are multiple tabs ── */}
      {showTabs && (
        <div className="flex items-center gap-1 border-b border-border bg-surface px-2 pt-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-1.5">
            {tabs.map((t) => {
              const on = t.id === activeId
              return (
                <div
                  key={t.id}
                  onClick={() => env.selectTab(t.id)}
                  className={
                    'sylor-tab-in group flex min-w-0 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border-x border-t px-2.5 py-1.5 text-[12px] transition-colors ' +
                    (on
                      ? 'border-border bg-bg text-text'
                      : 'border-transparent text-muted hover:bg-surface-2/70 hover:text-text')
                  }
                >
                  <span
                    className={
                      'h-1.5 w-1.5 shrink-0 rounded-full ' +
                      (t.loading ? 'animate-pulse bg-primary' : on ? 'bg-primary/60' : 'bg-transparent')
                    }
                  />
                  <span className="truncate">{t.atHome ? 'New tab' : t.title || 'New tab'}</span>
                  <button
                    type="button"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation()
                      env.closeTab(t.id)
                    }}
                    className="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-text group-hover:opacity-100"
                  >
                    <IconClose />
                  </button>
                </div>
              )
            })}
            <button
              type="button"
              aria-label="New tab"
              onClick={() => env.openTab()}
              className="sylor-press grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <IconPlus />
            </button>
          </div>
        </div>
      )}

      {/* ── Slim page-nav bar — only when a page is open (no address bar) ──── */}
      {onPage && (
        <div className="flex items-center gap-1 border-b border-border bg-surface px-2 py-1.5">
          <button
            type="button"
            aria-label="Back"
            disabled={!active?.canBack}
            onClick={env.goBack}
            className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
          >
            <IconBack />
          </button>
          <button
            type="button"
            aria-label="Home"
            onClick={env.goLauncher}
            className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <IconHome />
          </button>
          <div className="mx-1.5 min-w-0 flex-1 truncate text-[12px] text-muted" title={active?.url}>
            {active?.title || hostOf(active?.url ?? '')}
          </div>
          <button
            type="button"
            aria-label={active?.loading ? 'Loading' : 'Reload'}
            onClick={env.reload}
            className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <IconReload spinning={!!active?.loading} />
          </button>
        </div>
      )}

      {/* ── Body: live viewport, with the launcher shown over it at "home" ── */}
      <div className="relative min-h-0 flex-1 bg-white">
        {tabs.map((t) => (
          <webview
            key={t.id}
            ref={env.registerWebview(t.id)}
            src={t.url || 'about:blank'}
            partition="persist:sylorium"
            useragent={USER_AGENT}
            allowpopups={true}
            className={'absolute inset-0 h-full w-full border-0 ' + (t.id === activeId ? '' : 'hidden')}
          />
        ))}

        {/* App launcher — the tab's home screen, over the (idle) webview. */}
        {active?.atHome && (
          <div className="absolute inset-0 z-10">
            <SyloriumLauncher env={env} />
          </div>
        )}

        {/* Subtle "AI is acting" ring — the user always knows Sylor is driving. */}
        {env.aiActive && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 rounded-sm ring-2 ring-inset ring-primary/40 sylor-fade-in"
          />
        )}

        {/* Self-healing card: shown after a bounded auto-recovery attempt. */}
        {onPage && active?.failed && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-bg/95 p-6 sylor-fade-in">
            <div className="w-full max-w-md text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-surface-2 text-primary">
                {active.healing ? <IconReload spinning /> : <IconWarn />}
              </div>
              <h2 className="text-[16px] font-medium text-text">
                {active.healing ? 'Trying to recover…' : 'This page didn’t load'}
              </h2>
              <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
                {active.healing
                  ? 'Sylorium is retrying the page once automatically.'
                  : diagnose(active.failed.code, active.failed.desc)}
              </p>
              {!active.healing && (
                <div className="mt-4 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={env.reload}
                    className="sylor-press rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg transition-colors hover:opacity-90"
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={env.goLauncher}
                    className="sylor-press rounded-lg bg-surface-2 px-3.5 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-border"
                  >
                    Go home
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
