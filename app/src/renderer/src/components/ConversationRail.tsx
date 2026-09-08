import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Project, SessionSummary, WorkMode } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useProjectStore } from '@renderer/store/useProjectStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { ProjectDialog } from '@renderer/components/ProjectDialog'
import { SylorLogo } from '@renderer/components/SylorLogo'

/** The two top-level working modes, shown as the sidebar's nav-level toggle (item 1). */
const WORK_MODES: { value: WorkMode; label: string; title: string; icon: ReactNode }[] = [
  {
    value: 'cowork',
    label: 'Cowork',
    title: 'Cowork: chat only — Sylor answers and writes code in the message. No file or terminal access.',
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2.6 7.1c0-2.2 2.4-4.1 5.4-4.1s5.4 1.9 5.4 4.1c0 2.3-2.4 4.1-5.4 4.1-.6 0-1.2-.1-1.7-.2l-2.8 1.5.6-2.2a4.2 4.2 0 0 1-1.5-3.2Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    value: 'code',
    label: 'Code',
    title: 'Code: work on your folder — Sylor reads files, edits, and runs commands (with approval).',
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M6 4L2.5 8 6 12M10 4l3.5 4L10 12"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
]

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

/**
 * A section heading that reads as a ruled legend: the label, a hairline running out
 * to the edge of the rail, and optionally one small action pinned at its end.
 *
 * The rule is what gives the rail its regions. Without it five identical uppercase
 * captions floated in the same column as the rows they were labelling, so Projects
 * and Today and Older all had the same weight as the chats between them.
 */
function RailLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5 pt-3">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {children}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {action}
    </div>
  )
}

/**
 * Cowork / Code, as a switch with an indicator that slides between them.
 *
 * This is the one control in the rail that changes what Sylor is *allowed* to do —
 * Cowork can only talk, Code can read and edit the open folder — so it now sits
 * above the scroll region with New chat instead of scrolling away as the first item
 * of a list of destinations. The indicator moves rather than the two labels merely
 * swapping tints: at this size the movement is the part that registers peripherally,
 * and the active glyph picking up the accent is what confirms which one landed.
 */
function ModeSwitch({ mode, onChange }: { mode: WorkMode; onChange: (m: WorkMode) => void }) {
  return (
    <div
      role="group"
      aria-label="Working mode"
      className="relative grid grid-cols-2 rounded-lg bg-surface-2 p-0.5 ring-1 ring-inset ring-border/70"
    >
      <span
        aria-hidden="true"
        className={
          'pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-[calc(50%-2px)] rounded-md bg-surface shadow-sm ring-1 ring-border transition-transform duration-200 ease-out ' +
          (mode === 'code' ? 'translate-x-full' : 'translate-x-0')
        }
      />
      {WORK_MODES.map((m) => {
        const active = m.value === mode
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => onChange(m.value)}
            aria-pressed={active}
            title={m.title}
            className={
              'relative z-10 flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors ' +
              (active ? 'text-text' : 'text-muted hover:text-text')
            }
          >
            <span className={'shrink-0 ' + (active ? 'text-primary' : '')}>{m.icon}</span>
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * One key of the Configure pad. The cells have no border of their own — the grid's
 * `gap-px` over a `bg-border` ground draws the hairlines between them — so six
 * settings destinations cost one rounded block of about ninety pixels instead of
 * six full-width rows of a hundred and eighty, which is space the chat list wanted.
 * The label truncates rather than wrapping at the rail's minimum width, hence the
 * `title` on every key.
 */
function TileButton({
  icon,
  label,
  title,
  onClick
}: {
  icon: ReactNode
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="sylor-press group flex items-center gap-1.5 bg-surface px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
    >
      <span className="shrink-0 text-muted transition-colors group-hover:text-primary">{icon}</span>
      <span className="truncate text-[11px] text-text">{label}</span>
    </button>
  )
}

/**
 * A borderless icon button for the sidebar's control row (item 2). Interaction is
 * conveyed by a subtle background tint on hover/active — never a persistent
 * border — and disabled arrows dim to make their unavailable state obvious.
 */
function NavIconButton({
  label,
  onClick,
  children,
  active = false,
  disabled = false
}: {
  label: string
  onClick: () => void
  children: ReactNode
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        'grid h-8 w-8 place-items-center rounded-md transition-colors ' +
        (disabled
          ? 'cursor-not-allowed text-muted/40'
          : active
            ? 'bg-surface-2 text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text')
      }
    >
      {children}
    </button>
  )
}

/**
 * A borderless destination row. The settings deep-links moved into the Configure
 * pad below, so what is left on a full-width row is the one item that is a *place*
 * rather than a setting: the Browser panel, which is either beside the chat or it
 * isn't. `trailing` carries that on/off word, since a row that toggles a panel
 * should say which way it is currently pointing.
 */
function NavRow({
  icon,
  label,
  onClick,
  active = false,
  trailing
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'sylor-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ' +
        (active ? 'bg-primary/12 font-medium text-primary' : 'text-text hover:bg-surface-2')
      }
    >
      <span className={'shrink-0 ' + (active ? 'text-primary' : 'text-muted')}>{icon}</span>
      <span className="truncate">{label}</span>
      {trailing ? <span className="ml-auto shrink-0">{trailing}</span> : null}
    </button>
  )
}

/**
 * The left conversation rail: brand + collapse control, New chat and the Cowork/Code
 * switch pinned above the scroll, then the Browser destination, a hairline Configure
 * pad for the six settings panes, the Projects list, and the recents grouped into
 * date buckets (Today / Yesterday / …) with inline rename/delete on hover. While a
 * search is active the recents collapse to a single flat "Results" list, and the
 * footer keeps Settings and the Ctrl+K palette reachable from any scroll position.
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
  const back = useSessionStore((s) => s.back)
  const forward = useSessionStore((s) => s.forward)
  const navStack = useSessionStore((s) => s.navStack)
  const navPos = useSessionStore((s) => s.navPos)
  const projects = useProjectStore((s) => s.projects)
  const removeProject = useProjectStore((s) => s.remove)
  const openSettings = useAppStore((s) => s.openSettings)
  const togglePalette = useAppStore((s) => s.togglePalette)
  const toggleRail = useAppStore((s) => s.toggleRail)
  const browserOpen = useAppStore((s) => s.browserOpen)
  const setBrowserOpen = useAppStore((s) => s.setBrowserOpen)
  const workMode = useAppStore((s) => s.workMode)
  const setWorkMode = useAppStore((s) => s.setWorkMode)
  // Chats with a run still in flight — including ones started here and left behind
  // by a New Chat. Badging them is what makes background work visible; without it
  // a still-running task read as paused the moment it left the screen.
  const liveSessionIds = useChatStore((s) => s.liveSessionIds)

  const [query, setQuery] = useState('')
  // The search field is revealed by the nav-row search icon (item 2), so the
  // controls stay a compact icon cluster until the user actually searches.
  const [searchShown, setSearchShown] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // `undefined` = dialog closed; `null` = create mode; a Project = edit mode.
  const [dialogFor, setDialogFor] = useState<Project | null | undefined>(undefined)

  // Back/forward availability for the nav arrows (item 2): clear disabled states.
  const canBack = navPos > 0
  const canForward = navPos >= 0 && navPos < navStack.length - 1

  // The chat is the only destination now — the browser is a side panel beside it,
  // not somewhere else to be — so opening a chat is just opening a chat.
  const openSession = (id: string): void => {
    void open(id)
  }
  const startNewChat = (): void => {
    void newDraft()
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
          // The accent bar, not the tint, is what identifies the open chat: at 12%
          // the primary wash is close enough to a hover state that on a long list
          // you cannot tell which row you are actually in.
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
      {/* Brand */}
      <div className="flex min-w-0 items-center gap-2 px-3 pb-1 pt-3">
        <SylorLogo size={22} showBubbles={false} />
        <span className="truncate text-[13px] font-semibold tracking-wide text-text">Sylor</span>
      </div>

      {/* Controls: collapse · search · back · forward (item 2) */}
      <div className="flex items-center gap-0.5 px-2 pb-1">
        <NavIconButton label="Collapse sidebar" onClick={toggleRail}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </NavIconButton>
        <NavIconButton
          label="Search chats"
          active={searchShown}
          onClick={() => setSearchShown((v) => !v)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </NavIconButton>
        <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <NavIconButton label="Back" disabled={!canBack} onClick={() => void back()}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M12 4.5L6.5 10l5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </NavIconButton>
        <NavIconButton label="Forward" disabled={!canForward} onClick={() => void forward()}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M8 4.5L13.5 10 8 15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </NavIconButton>
      </div>
      {/* Search field — revealed by the search control */}
      {searchShown && (
        <div className="px-2 pb-1">
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

      {/* New chat + the mode switch: the two controls that must never scroll away */}
      <div className="space-y-1.5 px-2 pt-1">
        <button
          type="button"
          onClick={startNewChat}
          className="sylor-press flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-[12px] font-medium text-bg shadow-sm transition-colors hover:bg-primary/90"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          New chat
        </button>
        <ModeSwitch mode={workMode} onChange={(m) => void setWorkMode(m)} />
      </div>

      {/* Scroll region: destinations · configure · projects · recents (items 1, 10, 16) */}
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* The one destination that is a place rather than a setting. */}
        <div className="pt-1">
          <NavRow
            active={browserOpen}
            onClick={() => setBrowserOpen(!browserOpen)}
            label="Browser"
            trailing={
              browserOpen ? (
                <span className="text-[10px] font-medium uppercase tracking-wider text-primary">On</span>
              ) : null
            }
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
                <path
                  d="M2 8h12M8 2c1.8 1.7 2.8 3.8 2.8 6S9.8 12.3 8 14C6.2 12.3 5.2 10.2 5.2 8S6.2 3.7 8 2Z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
        </div>

        {/* Configure: six settings destinations as one hairline pad */}
        <RailLabel>Configure</RailLabel>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border">
          <TileButton
            onClick={() => openSettings('connectors')}
            label="Connectors"
            title="Connectors — MCP servers: turn them on or off, add your own"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5ZM8 11v3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
          <TileButton
            onClick={() => openSettings('skills')}
            label="Skills"
            title="Skills — reusable instruction sets the assistant can invoke"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 1.5l1.8 3.7 4.1.6-3 2.9.7 4L8 10.8 4.4 12.7l.7-4-3-2.9 4.1-.6L8 1.5Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
          <TileButton
            onClick={() => openSettings('commands')}
            label="Commands"
            title="Commands — your own slash commands"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3.5 5l3 3-3 3M8 11h4.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
          <TileButton
            onClick={() => openSettings('plugins')}
            label="Plugins"
            title="Plugins — bundles that ship connectors, skills and commands together"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6 2.5v2M10 2.5v2M4 4.5h8v4a4 4 0 0 1-8 0v-4Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
          <TileButton
            onClick={() => openSettings('model')}
            label="Model"
            title="Model — which model answers, and its keys"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path
                  d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            }
          />
          <TileButton
            onClick={() => openSettings('browsing')}
            label="Browsing"
            title="Browsing rules — which sites the assistant may open, and what it may do there"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 1.8l5 1.9v3.4c0 3-2 5.6-5 7-3-1.4-5-4-5-7V3.7l5-1.9Z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
        </div>

      {/* Projects */}
      <div>
        <RailLabel
          action={
            <button
              type="button"
              aria-label="New project"
              title="New project"
              onClick={() => setDialogFor(null)}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          }
        >
          Projects
        </RailLabel>

        <div className="space-y-0.5">
          {/* All chats — clears the project scope. */}
          <button
            type="button"
            onClick={() => void setActiveProject(null)}
            className={
              'sylor-press relative flex w-full items-center gap-2 rounded-lg py-1.5 pl-3 pr-2 text-left text-[12px] transition-colors ' +
              (activeProjectId === null ? 'bg-primary/10 font-medium text-primary' : 'text-text hover:bg-surface-2')
            }
          >
            {activeProjectId === null && (
              <span
                aria-hidden="true"
                className="absolute bottom-1.5 left-0.5 top-1.5 w-[2px] rounded-full bg-primary"
              />
            )}
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
      <div>
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
      {/* end scroll region */}
      </div>

      {/* Footer: settings + the palette's one keyboard entry point */}
      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => openSettings()}
          className="sylor-press flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M8 1.8v1.6M8 12.6v1.6M2.5 8H1M15 8h-1.5M4.1 4.1L3 3M13 13l-1.1-1.1M11.9 4.1L13 3M3 13l1.1-1.1"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
          <span className="truncate">Settings</span>
        </button>
        <button
          type="button"
          onClick={togglePalette}
          title="Command palette — search every action, chat and restore point"
          aria-label="Open the command palette"
          className="sylor-press ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2"
        >
          <kbd className="rounded border border-border px-1 font-mono text-[9.5px] text-muted/70">Ctrl</kbd>
          <kbd className="rounded border border-border px-1 font-mono text-[9.5px] text-muted/70">K</kbd>
        </button>
      </div>

      {dialogFor !== undefined && (
        <ProjectDialog project={dialogFor} onClose={() => setDialogFor(undefined)} />
      )}
    </div>
  )
}
