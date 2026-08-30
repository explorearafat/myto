/**
 * The New-Chat zero-state dashboard (items 7, 8). A calm, centered surface shown
 * whenever the chat has no messages yet. Every metric starts at zero because
 * there's no analytics store behind it — this is an honest fresh-install state,
 * not a mock. The greeting uses the OS display name (`window.sylor.userName`)
 * when available and gracefully drops the name when it isn't.
 */

/** A single labelled metric. `value` is a string so the "no data yet" metrics
 * can render an em-dash rather than a misleading 0. */
function Stat({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface-2/50 px-4 py-3 transition-colors hover:bg-surface-2">
      <span className="text-[11px] font-normal tracking-wide text-muted">{label}</span>
      <span className="text-[22px] font-light leading-none tracking-tight text-text tabular-nums">
        {value}
        {suffix && <span className="ml-0.5 text-[13px] font-normal text-muted">{suffix}</span>}
      </span>
    </div>
  )
}

/**
 * The contribution-style activity grid. Intentionally empty (all cells a single
 * muted tone) so a brand-new account reads as "nothing here yet" instead of
 * broken. Decorative, so it's hidden from assistive tech.
 */
function ActivityGrid() {
  const weeks = 20
  const days = 7
  const cells = Array.from({ length: weeks * days })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-wide text-muted">Activity</span>
        <span className="text-[11px] text-muted">No activity yet</span>
      </div>
      <div
        className="grid grid-flow-col gap-1 overflow-hidden"
        style={{ gridTemplateRows: `repeat(${days}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {cells.map((_, i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-[3px] bg-surface-2/70" />
        ))}
      </div>
    </div>
  )
}

/** The full zero-state: greeting, all-zero stats, and the empty activity grid. */
export function ZeroStateDashboard() {
  // The OS display name is a plain sync bridge property (never sent anywhere);
  // fall back to a name-less greeting when it isn't available.
  const name = (typeof window !== 'undefined' && window.sylor?.userName) || ''
  const greeting = name ? `What’s up next, ${name}?` : 'What’s up next?'

  const stats: { label: string; value: string; suffix?: string }[] = [
    { label: 'Sessions', value: '0' },
    { label: 'Messages', value: '0' },
    { label: 'Total tokens', value: '0' },
    { label: 'Active days', value: '0' },
    { label: 'Current streak', value: '0', suffix: 'd' },
    { label: 'Longest streak', value: '0', suffix: 'd' },
    { label: 'Peak hour', value: '—' },
    { label: 'Favorite model', value: '—' }
  ]

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-2xl motion-safe:animate-[fill-in_.4s_ease-out]">
        {/* Greeting */}
        <div className="mb-6 text-center">
          <h1 className="text-[26px] font-light leading-tight tracking-tight text-text sm:text-[30px]">
            {greeting}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[13px] font-normal leading-relaxed text-muted">
            This is your space. Start a conversation and your sessions, streaks, and activity will
            take shape here.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} suffix={s.suffix} />
          ))}
        </div>

        {/* Activity */}
        <div className="mt-4 rounded-xl bg-surface/60 p-4">
          <ActivityGrid />
        </div>
      </div>
    </div>
  )
}
