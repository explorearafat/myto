/**
 * SyloriumLauncher — the browser pane's home screen.
 *
 * A focused start page (not a general new-tab dump): a grid of the user's essential
 * web apps over a single search box. There is deliberately NO address bar — the
 * user reaches the web through a tile or the search field, and both go through the
 * normal, user-driven navigation path (never the AI's permission gate). It shows
 * whenever the active tab is "at home"; opening an app or searching leaves it.
 */
import { useState } from 'react'
import type { SyloriumEnv } from './useSyloriumEnv'
import { ESSENTIAL_APPS } from '@renderer/lib/sylorium/apps'
import { AppGlyph } from './appIcons'
import { IconSearch } from './icons'

export function SyloriumLauncher({ env }: { env: SyloriumEnv }) {
  const [query, setQuery] = useState('')

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-bg sylor-view-in">
      <div className="m-auto w-full max-w-lg px-6 py-10">
        {/* ── App grid: brand-glyph tiles ─────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-y-5 gap-x-2">
          {ESSENTIAL_APPS.map((app) => (
            <button
              key={app.key}
              type="button"
              onClick={() => env.openApp(app.url)}
              title={app.label}
              className="sylor-press group flex flex-col items-center gap-2 rounded-2xl p-1 outline-none"
            >
              <span
                className="grid h-14 w-14 place-items-center rounded-2xl text-white shadow-sm ring-1 ring-black/5 transition-transform group-hover:scale-105 group-focus-visible:scale-105"
                style={{ backgroundColor: app.color }}
              >
                <AppGlyph appKey={app.key} />
              </span>
              <span className="max-w-[68px] truncate text-[11.5px] text-muted transition-colors group-hover:text-text">
                {app.label}
              </span>
            </button>
          ))}
        </div>

        {/* ── Search: directly beneath the grid (no address bar) ──────────── */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const q = query.trim()
            if (!q) return
            env.submitSearch(q)
            setQuery('')
          }}
          className="mt-9"
        >
          <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3 shadow-sm transition-colors focus-within:border-primary/40">
            <span className="shrink-0 text-muted">
              <IconSearch />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="Search the web or enter a link"
              aria-label="Search the web or enter a link"
              className="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-muted"
            />
          </div>
        </form>
      </div>
    </div>
  )
}
