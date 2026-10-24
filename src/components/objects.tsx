import type { ReactNode } from 'react'

// The product's visual objects: hand-built HTML/CSS renditions of Myto's own
// surfaces — the desktop window, a diff card, the plan checklist, the phone —
// used across the marketing pages. Every claim on the site gets one of these
// drawn objects next to it, so the pages SHOW the product instead of
// describing it. No image assets: they stay crisp at any size, render before
// fonts load, and inherit the theme.

/** The window chrome every desktop mockup sits in. */
export function WindowChrome({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={
        'overflow-hidden rounded-xl border border-[#d9d5ca] bg-[#1a1917] shadow-[0_40px_90px_-40px_rgba(20,20,19,0.5)] ' +
        className
      }
    >
      {/* Title bar */}
      <div className="flex items-center gap-1.5 border-b border-[#2d2b27] bg-[#232119] px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#4a463d]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#4a463d]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#4a463d]" />
        <span className="ml-3 flex items-center gap-1.5 text-[11px] font-medium text-[#8a857a]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1l6 3.2v7.6L8 15l-6-3.2V4.2L8 1z" />
          </svg>
          Myto
        </span>
      </div>
      {children}
    </div>
  )
}

/**
 * The hero object: a miniature of the real workspace — rail, chat, a diff the
 * agent is proposing, and the approval buttons that gate it. Drawn at a fixed
 * compact scale so it holds together at every viewport width.
 */
export function AppWindowMockup() {
  return (
    <WindowChrome>
      <div className="flex text-[10.5px] leading-snug">
        {/* Rail */}
        <div className="hidden w-28 shrink-0 flex-col gap-1 border-r border-[#2d2b27] p-2.5 sm:flex">
          <div className="rounded-md bg-[#2d2b27] px-2 py-1 text-[#c9c4b8]">+ New</div>
          {['Projects', 'Artifacts', 'Code', 'Customize'].map((l, i) => (
            <div key={l} className={'px-2 py-1 ' + (i === 0 ? 'text-[#8a857a]' : 'text-[#6b675e]')}>
              {l}
            </div>
          ))}
          <div className="mt-2 border-t border-[#2d2b27] pt-2 text-[#57544e]">Today</div>
          <div className="rounded-md px-2 py-1 text-[#c9c4b8]">Rebrand EngagePilot</div>
          <div className="px-2 py-1 text-[#6b675e]">Fix flaky auth test</div>
        </div>
        {/* Transcript */}
        <div className="min-w-0 flex-1 space-y-2.5 p-3.5">
          <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-[#3a362e] px-2.5 py-1.5 text-[#e8e5dd]">
            Rename every EngagePilot reference to InstaMation
          </div>
          <div className="max-w-[92%] space-y-2 text-[#b5b0a4]">
            <p>
              Scanning the repo — <span className="text-[#d8d3c8]">38 files</span> mention the old
              name.
            </p>
            {/* The diff object */}
            <div className="overflow-hidden rounded-md border border-[#3a362e] font-mono text-[9.5px]">
              <div className="border-b border-[#3a362e] bg-[#232119] px-2.5 py-1.5 text-[#8a857a]">
                src/config/brand.ts
              </div>
              <div className="bg-[#2a1d1a] px-2.5 py-1 text-[#d98a7a] line-through">ENGAGEPILOT_NAME</div>
              <div className="bg-[#1c2a20] px-2.5 py-1 text-[#7fc79a]">INSTAMATION_NAME</div>
            </div>
            <p>3 of 38 files done. Approve to continue?</p>
          </div>
          {/* Approval row */}
          <div className="flex gap-1.5 pt-0.5">
            <span className="rounded-md bg-[#e8e5dd] px-2.5 py-1 font-medium text-[#1a1917]">Approve</span>
            <span className="rounded-md border border-[#3a362e] px-2.5 py-1 text-[#8a857a]">Show diff</span>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}

/** The plan checklist object — the live progress panel from Build mode. */
export function PlanChecklist() {
  const items = [
    { t: 'Scaffold the project', done: true },
    { t: 'Write index.html + styles', done: true },
    { t: 'Wire the signup flow', done: true },
    { t: 'Run the build', done: false, active: true },
    { t: 'Fix warnings, verify', done: false },
  ]
  return (
    <div className="w-56 rounded-xl border border-border bg-surface/95 p-3 shadow-[0_18px_44px_-24px_rgba(20,20,19,0.4)]">
      <div className="flex items-center justify-between text-[10.5px] font-medium uppercase tracking-wide text-muted">
        Progress
        <span className="font-mono normal-case">3/5</span>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {items.map((it) => (
          <li key={it.t} className="flex items-start gap-2 text-[11.5px] leading-snug">
            {it.done ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-0.5 shrink-0 text-green-600">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M5.3 8.2l1.9 1.9 3.5-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : it.active ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-0.5 shrink-0 animate-pulse text-primary">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="8" cy="8" r="2.5" fill="currentColor" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-0.5 shrink-0 text-muted">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2" />
              </svg>
            )}
            <span className={it.done ? 'text-muted line-through' : 'text-text'}>{it.t}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The phone object: the Android app's chat, in a drawn device frame — the
 * "same workspace in your pocket" visual for the download/community pages.
 */
export function PhoneFrame() {
  return (
    <div className="relative w-[218px] shrink-0 rounded-[2rem] border border-[#d9d5ca] bg-[#141413] p-2 shadow-[0_40px_90px_-40px_rgba(20,20,19,0.5)]">
      <div className="overflow-hidden rounded-[1.6rem] bg-[#1a1917]">
        <div className="flex justify-center pt-2">
          <span className="h-1 w-14 rounded-full bg-[#3a362e]" />
        </div>
        <div className="space-y-2 p-3 text-[9.5px] leading-snug">
          <div className="ml-auto w-fit max-w-[80%] rounded-lg rounded-br-sm bg-[#3a362e] px-2 py-1.5 text-[#e8e5dd]">
            build and verify the login page
          </div>
          <div className="flex items-center gap-1.5 text-[#8a857a]">
            <span className="flex gap-0.5">
              <span className="h-1 w-1 animate-pulse rounded-full bg-[#8a857a]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-[#8a857a] [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-[#8a857a] [animation-delay:300ms]" />
            </span>
            Myto is building…
          </div>
          <div className="rounded-lg bg-[#232119] p-2 text-[#b5b0a4]">
            <div className="font-medium text-[#e8e5dd]">Progress 2/4</div>
            <div className="mt-1 text-[#8a857a]">✓ Login form · ✓ API stub</div>
            <div className="text-[#c9c4b8]">● Session handling…</div>
          </div>
          <div className="rounded-lg rounded-bl-sm bg-[#2d2b27] px-2 py-1.5 text-[#e8e5dd]">
            Login page builds clean — verified with 3 passing checks.
          </div>
        </div>
        <div className="border-t border-[#2d2b27] px-3 py-2">
          <div className="rounded-full border border-[#3a362e] px-2.5 py-1 text-[#57544e]">Message Myto…</div>
        </div>
      </div>
    </div>
  )
}

/**
 * The stat strip: only numbers Myto can honestly claim — no invented metrics.
 */
export function StatStrip() {
  const stats = [
    { k: 'Windows + Android', v: 'Native apps' },
    { k: '$0', v: 'For the app, forever' },
    { k: 'Any endpoint', v: 'Ollama or OpenAI-compatible' },
    { k: 'Your keys', v: 'Never leave your account' },
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-6 text-left sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.k}>
          <dt className="font-display text-[20px] tracking-[-0.01em] text-[#141413]">{s.k}</dt>
          <dd className="mt-1 text-[13px] leading-snug text-[#6b675e]">{s.v}</dd>
        </div>
      ))}
    </dl>
  )
}
