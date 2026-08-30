/**
 * Sylorium first-run onboarding (requirement 10). Shown the first time the user
 * opens the Sylorium destination and never again once completed — the
 * `syloriumInitialized` flag is persisted in the store (localStorage), so this
 * initialization screen does not replay across launches.
 *
 * It sets expectations honestly before any browsing starts: Sylorium is a real
 * browser with persistent logins, Sylor can perceive and (with permission) drive
 * it, and sensitive actions are gated by default. The single call-to-action marks
 * onboarding done and drops the user into the browser.
 */
import { useAppStore } from '@renderer/store/useAppStore'

/** A labelled capability line in the onboarding intro. */
function Point({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-[15px]"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-text">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  )
}

export function SyloriumOnboarding() {
  const complete = useAppStore((s) => s.completeSyloriumOnboarding)

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-bg px-6 py-10">
      <div className="w-full max-w-lg sylor-view-in">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary/12 text-primary">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M2 8h12M8 2c1.8 1.7 2.8 3.8 2.8 6S9.8 12.3 8 14C6.2 12.3 5.2 10.2 5.2 8S6.2 3.7 8 2Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-[24px] font-light tracking-tight text-text">Welcome to Sylorium</h1>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
            Sylor is the intelligence. Sylorium is its web world — a real browser you both share.
          </p>
        </div>

        <div className="space-y-4 rounded-2xl bg-surface/70 p-5">
          <Point
            icon="🌐"
            title="A real browser"
            body="Open any site, use tabs, and stay logged in to your real accounts. Your sessions persist here between visits."
          />
          <Point
            icon="👁️"
            title="Sylor can see the page"
            body="It reads the page through its structure first, and only falls back to a screenshot when it must — never guessing blindly."
          />
          <Point
            icon="🛡️"
            title="You stay in control"
            body="Reading and browsing are open; sending messages, deleting data, and payments are gated by default. Passwords and cookies are never shared with the AI."
          />
        </div>

        <button
          type="button"
          onClick={complete}
          className="sylor-press mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-medium text-bg transition-colors hover:opacity-90"
        >
          Enter Sylorium
        </button>
        <p className="mt-3 text-center text-[11px] text-muted">
          You can review and change AI permissions any time from the shield icon.
        </p>
      </div>
    </div>
  )
}
