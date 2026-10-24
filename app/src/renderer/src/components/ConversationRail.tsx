import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Project, SessionSummary } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useProjectStore } from '@renderer/store/useProjectStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { useAuthUser } from '@renderer/lib/useAuthUser'
import { ProjectDialog } from '@renderer/components/ProjectDialog'

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

/** A small uppercase ruled caption for a date bucket inside the recents list. */
function RailLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1 pt-3">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {children}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {action}
    </div>
  )
}

/**
 * A primary navigation row in the top cluster (Projects / Artifacts / Code /
 * Customize). Icon + label, with an optional trailing badge or disclosure. Rows
 * for features this build doesn't ship are marked `inert` — they keep the exact
 * layout of the reference app but carry a quiet "not available" note instead of
 * navigating anywhere.
 */
function NavRow({
  icon,
  label,
  onClick,
  active = false,
  inert = false,
  trailing,
  title
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  inert?: boolean
  trailing?: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      title={title ?? (inert ? 'Not available in this build' : undefined)}
      aria-pressed={active}
      onClick={inert ? undefined : onClick}
      className={
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors ' +
        (active
          ? 'bg-primary/10 text-primary'
          : inert
            ? 'text-text/80 hover:bg-surface-2/70'
            : 'text-text hover:bg-surface-2')
      }
    >
      <span className={'grid shrink-0 place-items-center ' + (active ? 'text-primary' : 'text-muted')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}

/**
 * The left conversation rail — a pixel-faithful shell of the Claude-desktop home:
 * the Myto wordmark, a New action, a primary nav cluster (Projects, Artifacts,
 * Code, Customize), then the "Chats and tasks" section with date-bucketed recents
 * and inline rename/delete on hover, and a pinned account footer (avatar + name +
 * plan) beside a small icon cluster. Artifacts / Code are inert chrome; Projects
 * and Customize are wired to the real stores.
 */
export function ConversationRail() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeProjectId = useSessionStore((s) => s.activeProjectId)
  const setActiveProject = useSessionStore((s) => s.setActiveProject)
  const open = useSessionStore((s) => s.open)
  const newDraft = useSessionStore((s) => s.newDraft)
  const rename = useSessionStore((s) => s.rename)
  const remove = useSessionStore((s) => s.remove)
  const projects = useProjectStore((s) => s.projects)
  const removeProject = useProjectStore((s) => s.remove)
  const openSettings = useAppStore((s) => s.openSettings)
  const toggleRail = useAppStore((s) => s.toggleRail)
  // Chats with a run still in flight — including ones started here and left behind
  // by a New Chat. Badging them is what makes background work visible; without it
  // a still-running task read as paused the moment it left the screen.
  const liveSessionIds = useChatStore((s) => s.liveSessionIds)
  // Chat/Cowork mode toggle — moved out of the composer into the rail (Task 5).
  const coworkMode = useChatStore((s) => s.coworkMode)
  const setCoworkMode = useChatStore((s) => s.setCoworkMode)
  // A saved conversation's mode is fixed (Task 6): once it has a row, the toggle
  // locks so Chat and Cowork turns never mix in one thread.
  const chatSessionId = useChatStore((s) => s.sessionId)

  // The signed-in Google account, for the footer. Held by AuthGate; surfaced here
  // through a small subscription hook so the rail never imports Firebase directly.
  const authUser = useAuthUser()
  const fullName = authUser?.displayName?.trim() || window.myto.userName || 'You'
  const firstName = fullName.split(/\s+/)[0] || 'You'
  const email = authUser?.email ?? ''
  const photoURL = authUser?.photoURL ?? null
  const avatarInitial = (firstName || '?').charAt(0).toUpperCase()
  // Google avatars can be blocked (CSP) or 403 on a stale URL; fall back to the
  // initial rather than showing a broken image. Reset when the photo URL changes.
  const [avatarError, setAvatarError] = useState(false)
  useEffect(() => setAvatarError(false), [photoURL])

  const [query, setQuery] = useState('')
  // The search field is revealed by the section's sort/search control, so the
  // header stays a clean caption until the user actually searches.
  const [searchShown, setSearchShown] = useState(false)
  // Projects collapse to a single nav row (reference-app look); expanding reveals
  // "All chats" + the project list inline.
  const [projectsExpanded, setProjectsExpanded] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // `undefined` = dialog closed; `null` = create mode; a Project = edit mode.
  const [dialogFor, setDialogFor] = useState<Project | null | undefined>(undefined)

  // The chat is the only destination — opening a chat is just opening a chat.
  const openSession = (id: string): void => {
    void open(id)
  }
  const startNewChat = (): void => {
    void newDraft()
  }
  // The mode toggle above "New". A saved chat's mode is fixed, so it locks once
  // the open conversation has a row; a fresh draft (no id yet) stays switchable.
  const modeLocked = chatSessionId !== null
  // Enabling Cowork doesn't force the native folder picker here — the composer makes
  // folder selection mandatory instead: a Cowork message can't be sent until the user
  // picks a working folder (ChatPanel opens the picker on send if none is set).
  const enableCowork = (): void => {
    setCoworkMode(true)
  }

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
      void window.myto.sessions.search(q, activeProjectId).then((rows) => {
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

  const toggleSearch = (): void => setSearchShown((v) => !v)

  /** One recents row — reused by the flat search list and each date bucket. */
  const renderRow = (s: SessionSummary): ReactNode => {
    const isActive = s.id === activeSessionId
    const isRenaming = renaming === s.id
    const isRunning = liveSessionIds.includes(s.id)
    return (
      <div
        key={s.id}
        className={
          'group relative flex items-center gap-1 rounded-lg py-1.5 pl-3 pr-2 transition-colors ' +
          (isActive ? 'bg-primary/10' : 'hover:bg-surface-2')
        }
      >
        {isActive && (
          <span
            aria-hidden="true"
            className="absolute bottom-1.5 left-0.5 top-1.5 w-[2px] rounded-full bg-primary"
          />
        )}
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
          <button type="button" onClick={() => openSession(s.id)} className="min-w-0 flex-1 text-left">
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
                  'truncate text-[13px] ' + (isActive ? 'font-medium text-primary' : 'text-text')
                }
              >
                {s.title}
              </span>
              {/* Mode tag (Task 6): a compact glyph beside every name marks whether the
                  session is a Chat or a Cowork thread — its mode is fixed for life, so
                  opening it always restores that mode. Icon-only to stay quiet in the
                  narrow rail; the label rides the tooltip + aria-label. */}
              <span
                title={
                  s.mode === 'cowork'
                    ? 'Build session'
                    : s.mode === 'research'
                      ? 'Cowork session'
                      : 'Chat session'
                }
                aria-label={
                  s.mode === 'cowork'
                    ? 'Build session'
                    : s.mode === 'research'
                      ? 'Cowork session'
                      : 'Chat session'
                }
                className="grid shrink-0 place-items-center text-muted/70"
              >
                {s.mode === 'cowork' ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : s.mode === 'research' ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 1.7l1.5 3.9 3.9 1.5-3.9 1.5L8 12.5 6.5 8.6 2.6 7.1l3.9-1.5L8 1.7Z"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5V10A1.5 1.5 0 0 1 12 11.5H6l-3 2.5V11.5H4A1.5 1.5 0 0 1 2.5 10V4.5Z"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
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
    <div className="flex h-full flex-col border-r border-border bg-bg">
      {/* Brand wordmark + split toggle — top-left as requested. */}
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="font-serif text-[19px] leading-none text-text">Myto</span>
        <button
          type="button"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={toggleRail}
          className="grid h-6 w-6 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 7l2 3-2 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Fixed top cluster: New · Projects · Artifacts · Code · Customize. */}
      <div className="px-2 pt-1">
        {/* Chat / Cowork mode — the whole conversation's working mode, lifted out of
            the composer. A new chat opens in the last-used mode (Task 7); once it is
            saved the mode is fixed (Task 6), so the toggle locks. Ultra-low-opacity
            track so it reads as chrome, not a primary action. */}
        <div
          role="group"
          aria-label="Conversation mode"
          className="mb-1 flex items-center gap-0.5 rounded-lg bg-surface-2/40 p-0.5"
        >
          <button
            type="button"
            onClick={() => setCoworkMode(false)}
            disabled={modeLocked}
            aria-pressed={!coworkMode}
            title={
              modeLocked
                ? "This chat's mode is fixed — start a new chat to switch"
                : 'Cowork — the all-rounder: browser, your files & sub-agents, no folder needed'
            }
            className={
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ' +
              (!coworkMode
                ? 'bg-surface text-text shadow-sm'
                : 'text-muted hover:text-text disabled:hover:text-muted')
            }
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4.5l2.5 2.5L4 9.5M7.5 4.5l2.5 2.5L7.5 9.5M11 4.5l2.5 2.5L11 9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Cowork
          </button>
          <button
            type="button"
            onClick={enableCowork}
            disabled={modeLocked}
            aria-pressed={coworkMode}
            title={
              modeLocked
                ? "This chat's mode is fixed — start a new chat to switch"
                : 'Build — scaffold & ship a real project in a folder on your computer'
            }
            className={
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ' +
              (coworkMode
                ? 'bg-surface text-text shadow-sm'
                : 'text-muted hover:text-text disabled:hover:text-muted')
            }
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 4.5h5l1.5 1.5H14v6H2.5V4.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
              <path d="M7.2 8.2l1.6 1.6 2.4-2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Build
          </button>
        </div>
        <button
          type="button"
          onClick={startNewChat}
          className="myto-press group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] text-text transition-colors hover:bg-surface-2"
        >
          <span className="grid shrink-0 place-items-center text-muted transition-colors group-hover:text-primary">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <span className="min-w-0 flex-1 truncate">New</span>
        </button>

        <NavRow
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.2 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          }
          label="Projects"
          onClick={() => setProjectsExpanded((v) => !v)}
          active={projectsExpanded}
          trailing={
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
              className={'shrink-0 text-muted transition-transform ' + (projectsExpanded ? 'rotate-180' : '')}
            >
              <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />

        {/* Projects expansion — All chats + the project list, capped so a long list
            scrolls without pushing the recents off-screen. */}
        {projectsExpanded && (
          <div className="mb-0.5 ml-3 max-h-52 space-y-0.5 overflow-y-auto border-l border-border pl-2">
            <button
              type="button"
              onClick={() => void setActiveProject(null)}
              className={
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ' +
                (activeProjectId === null ? 'font-medium text-primary' : 'text-text hover:bg-surface-2')
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
                    'group relative flex items-center gap-1 rounded-lg py-1.5 pl-2 pr-1.5 transition-colors ' +
                    (isActive ? 'bg-primary/10' : 'hover:bg-surface-2')
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

            <button
              type="button"
              onClick={() => setDialogFor(null)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              New project
            </button>
          </div>
        )}

        <NavRow
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2.5 6.5h11M6.5 6.5v7" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          }
          label="Artifacts"
          inert
        />
        <NavRow
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 5h7M11.5 5h2M2.5 11h2M6.5 11h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="10" cy="5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="5" cy="11" r="1.6" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          }
          label="Customize"
          onClick={() => openSettings('appearance')}
          title="Appearance & model settings"
        />
      </div>

      {/* Scroll region: Chats and tasks. */}
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col px-2">
        <div className="flex items-center justify-between px-1.5 pb-0.5">
          <span className="text-[12px] font-medium text-muted">Chats and tasks</span>
          <button
            type="button"
            aria-label="Search chats"
            title="Search chats"
            aria-pressed={searchShown}
            onClick={toggleSearch}
            className={
              'grid h-6 w-6 place-items-center rounded-md transition-colors ' +
              (searchShown ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2 hover:text-text')
            }
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Search field — revealed by the section's search control. */}
        {searchShown && (
          <div className="px-1 pb-1 pt-0.5">
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 ring-1 ring-transparent transition-shadow focus-within:ring-primary/40">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-muted">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                autoFocus
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
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {resultCount === 0 ? (
            <div className="px-1 py-4 text-[11px] text-muted">
              {searching ? 'No chats match your search.' : 'No chats yet. Start a new one.'}
            </div>
          ) : searching ? (
            <>
              <RailLabel action={<span className="shrink-0 text-[10px] tabular-nums text-muted/70">{resultCount}</span>}>
                Results
              </RailLabel>
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
      </div>

      {/* Footer: the signed-in account — avatar + name + plan — and an icon cluster. */}
      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        <button
          type="button"
          title={email || fullName}
          onClick={() => openSettings()}
          className="myto-press flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-2"
        >
          {photoURL && !avatarError ? (
            <img
              src={photoURL}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setAvatarError(true)}
              className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-border"
            />
          ) : (
            <span
              aria-hidden="true"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
            >
              {avatarInitial}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
            {firstName}
            <span className="text-muted"> · Free</span>
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0 text-muted">
            <path d="M3.5 5L6 2.5 8.5 5M3.5 7L6 9.5 8.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => openSettings('tools')}
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            {/* Inline SVG gear — strokes follow `currentColor`, so the icon adapts to
                the active theme (light/dark) instead of being a fixed-colour PNG that
                could wash out against the wrong background. Weight (1.8 at a 24 viewBox
                scaled to 16px ≈ 1.2px) matches the rail's other stroke icons. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Search chats"
            title="Search chats"
            onClick={toggleSearch}
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {dialogFor !== undefined && (
        <ProjectDialog project={dialogFor} onClose={() => setDialogFor(undefined)} />
      )}
    </div>
  )
}
