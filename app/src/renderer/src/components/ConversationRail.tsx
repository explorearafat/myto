import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Project, SessionSummary } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useProjectStore } from '@renderer/store/useProjectStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { ProjectDialog } from '@renderer/components/ProjectDialog'
import { SylorLogo } from '@renderer/components/SylorLogo'

/** Relative "8m ago" style timestamp for a recents row. */
function relativeTime(ms: number): string {
  const delta = Date.now() - ms
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ms).toLocaleDateString()
}

/** A labelled bucket of recents (Today / Yesterday / …). */
interface SessionGroup {
  label: string
  items: SessionSummary[]
}

/**
 * Bucket sessions into Today / Yesterday / Previous 7 days / Previous 30 days /
 * Older by their `updatedAt` (Claude-desktop style). Input order (newest-first)
 * is preserved within each bucket, and empty buckets are dropped so the rail
 * only shows headings that have chats under them.
 */
function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 86_400_000
  const d1 = startOfToday - dayMs
  const d7 = startOfToday - 7 * dayMs
  const d30 = startOfToday - 30 * dayMs

  const today: SessionSummary[] = []
  const yesterday: SessionSummary[] = []
  const week: SessionSummary[] = []
  const month: SessionSummary[] = []
  const older: SessionSummary[] = []

  for (const s of sessions) {
    const t = s.updatedAt
    if (t >= startOfToday) today.push(s)
    else if (t >= d1) yesterday.push(s)
    else if (t >= d7) week.push(s)
    else if (t >= d30) month.push(s)
    else older.push(s)
  }

  return (
    [
      { label: 'Today', items: today },
      { label: 'Yesterday', items: yesterday },
      { label: 'Previous 7 days', items: week },
      { label: 'Previous 30 days', items: month },
      { label: 'Older', items: older }
    ] satisfies SessionGroup[]
  ).filter((g) => g.items.length > 0)
}

/** Small uppercase section heading used above the projects list and each recents bucket. */
function RailLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
      {children}
    </div>
  )
}

/**
 * The left conversation rail (Claude-desktop style): brand + collapse control, a
 * prominent "New chat" button, a search box that filters recents by title, the
 * Projects list, and the recents grouped into date buckets (Today / Yesterday /
 * …) with inline rename/delete on hover. While a search is active the recents
 * collapse to a single flat "Results" list.
 */
export function ConversationRail() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeProjectId = useSessionStore((s) => s.activeProjectId)
  const setActiveProject = useSessionStore((s) => s.setActiveProject)
  const open = useSessionStore((s) => s.open)
  const create = useSessionStore((s) => s.create)
  const rename = useSessionStore((s) => s.rename)
  const remove = useSessionStore((s) => s.remove)
  const projects = useProjectStore((s) => s.projects)
  const removeProject = useProjectStore((s) => s.remove)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const toggleRail = useAppStore((s) => s.toggleRail)
  // Chats with a run still in flight — including ones started here and left behind
  // by a New Chat. Badging them is what makes background work visible; without it
  // a still-running task read as paused the moment it left the screen.
  const liveSessionIds = useChatStore((s) => s.liveSessionIds)

  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // `undefined` = dialog closed; `null` = create mode; a Project = edit mode.
  const [dialogFor, setDialogFor] = useState<Project | null | undefined>(undefined)

  // Backend search results for a non-blank query. `null` means "not searching" —
  // the list falls back to the full recents. Debounced so we don't hit the DB on
  // every keystroke; the search is scoped to the active project like the recents.
  const [searchResults, setSearchResults] = useState<SessionSummary[] | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (q === '') {
      setSearchResults(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      void window.sylor.sessions.search(q, activeProjectId).then((rows) => {
        if (!cancelled) setSearchResults(rows)
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
    // `sessions` is a dep so a rename/delete/create (which refreshes the store)
    // re-runs the active search, keeping results from going stale.
  }, [query, activeProjectId, sessions])

  const searching = searchResults !== null
  // Group the recents into date buckets when browsing; searching shows a flat list.
  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const resultCount = searching ? searchResults.length : sessions.length

  const startRename = (id: string, title: string): void => {
    setRenaming(id)
    setDraft(title)
  }
  const commitRename = async (id: string): Promise<void> => {
    if (draft.trim()) await rename(id, draft.trim())
    setRenaming(null)
  }
  const handleRemove = async (id: string): Promise<void> => {
    if (confirm('Delete this chat? This cannot be undone.')) await remove(id)
  }
  const handleRemoveProject = async (p: Project): Promise<void> => {
    if (
      confirm(
        `Delete project "${p.name}"? Its ${p.sessionCount} chat${p.sessionCount === 1 ? '' : 's'} will be kept but ungrouped.`
      )
    ) {
      await removeProject(p.id)
    }
  }

  /** One recents row — reused by the flat search list and each date bucket. */
  const renderRow = (s: SessionSummary): ReactNode => {
    const isActive = s.id === activeSessionId
    const isRenaming = renaming === s.id
    const isRunning = liveSessionIds.includes(s.id)
    return (
      <div
        key={s.id}
        className={
          'group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ' +
          (isActive ? 'bg-primary/12' : 'hover:bg-surface-2')
        }
      >
        {isRenaming ? (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(s.id)
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => void commitRename(s.id)}
            autoFocus
            className="min-w-0 flex-1 rounded border border-primary/60 bg-bg px-1.5 py-0.5 text-[12px] text-text outline-none"
          />
        ) : (
          <button type="button" onClick={() => void open(s.id)} className="min-w-0 flex-1 text-left">
            <div className="flex min-w-0 items-center gap-1.5">
              {isRunning && (
                <span
                  title="Still working in this chat"
                  aria-label="Still working in this chat"
                  className="relative grid h-2 w-2 shrink-0 place-items-center"
                >
                  <span className="absolute h-2 w-2 animate-ping rounded-full bg-primary/60" />
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
              )}
              <span
                className={
                  'truncate text-[12px] ' + (isActive ? 'font-medium text-primary' : 'text-text')
                }
              >
                {s.title}
              </span>
            </div>
            <div className={'text-[10px] ' + (isRunning ? 'text-primary' : 'text-muted')}>
              {isRunning ? 'Working…' : relativeTime(s.updatedAt)}
            </div>
          </button>
        )}
        {!isRenaming && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              aria-label="Rename"
              onClick={() => startRename(s.id, s.title)}
              className="grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M11 2l3 3-8 8H3v-3l8-8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Delete"
              onClick={() => void handleRemove(s.id)}
              className="grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-red-500/20 hover:text-red-400"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4h8v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-surface">
      {/* Brand + collapse */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <SylorLogo size={22} showBubbles={false} />
          <span className="truncate text-[13px] font-semibold tracking-wide text-text">Sylor</span>
        </div>
        <button
          type="button"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={toggleRail}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.4" />
            <path d="M13 7.5L10.5 10 13 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* New chat */}
      <div className="px-2">
        <button
          type="button"
          onClick={() => void create()}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-[12px] font-medium text-text transition-colors hover:border-primary/60 hover:bg-surface-2"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New chat
        </button>
      </div>

      {/* Search */}
      <div className="px-2 pt-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 focus-within:border-primary/50">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-muted">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text placeholder:text-muted focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted transition-colors hover:text-text"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Projects */}
      <div className="mt-3 px-2">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Projects
          </span>
          <button
            type="button"
            aria-label="New project"
            onClick={() => setDialogFor(null)}
            className="grid h-5 w-5 place-items-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="space-y-0.5">
          {/* All chats — clears the project scope. */}
          <button
            type="button"
            onClick={() => void setActiveProject(null)}
            className={
              'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ' +
              (activeProjectId === null ? 'bg-primary/12 font-medium text-primary' : 'text-text hover:bg-surface-2')
            }
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            All chats
          </button>

          {projects.map((p) => {
            const isActive = p.id === activeProjectId
            return (
              <div
                key={p.id}
                className={
                  'group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ' +
                  (isActive ? 'bg-primary/12' : 'hover:bg-surface-2')
                }
              >
                <button
                  type="button"
                  onClick={() => void setActiveProject(p.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={'shrink-0 ' + (isActive ? 'text-primary' : 'text-muted')}>
                    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.2 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                  <span className={'truncate text-[12px] ' + (isActive ? 'font-medium text-primary' : 'text-text')}>
                    {p.name}
                  </span>
                  {p.sessionCount > 0 && (
                    <span className="shrink-0 text-[10px] text-muted">{p.sessionCount}</span>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label="Edit project"
                    onClick={() => setDialogFor(p)}
                    className="grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-text"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M11 2l3 3-8 8H3v-3l8-8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete project"
                    onClick={() => void handleRemoveProject(p)}
                    className="grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-red-500/20 hover:text-red-400"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4h8v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Recents */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {resultCount === 0 ? (
          <div className="px-1 py-4 text-[11px] text-muted">
            {searching ? 'No chats match your search.' : 'No chats yet. Start a new one.'}
          </div>
        ) : searching ? (
          <>
            <RailLabel>Results</RailLabel>
            <div className="space-y-0.5">{searchResults.map(renderRow)}</div>
          </>
        ) : (
          groups.map((g) => (
            <div key={g.label}>
              <RailLabel>{g.label}</RailLabel>
              <div className="space-y-0.5">{g.items.map(renderRow)}</div>
            </div>
          ))
        )}
      </div>

      {/* Settings */}
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Settings
        </button>
      </div>

      {dialogFor !== undefined && (
        <ProjectDialog project={dialogFor} onClose={() => setDialogFor(undefined)} />
      )}
    </div>
  )
}
