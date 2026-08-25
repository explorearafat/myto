import { useState } from 'react'
import { useSessionStore } from '../store/useSessionStore'
import { useChatStore } from '../store/useChatStore'

/**
 * Sessions flyout (Phase 5): a sidebar overlay listing past sessions newest-first.
 * Click a row to reopen; rename/delete from the row menu. Styled like
 * {@link SettingsPanel} (overlay + card), anchored beside the rail.
 */
export function SessionList() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const open = useSessionStore((s) => s.open)
  const create = useSessionStore((s) => s.create)
  const rename = useSessionStore((s) => s.rename)
  const remove = useSessionStore((s) => s.remove)
  const setListOpen = useSessionStore((s) => s.setListOpen)
  // Sessions whose run is still going (possibly off-screen) — see ConversationRail.
  const liveSessionIds = useChatStore((s) => s.liveSessionIds)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const startRename = (id: string, title: string): void => {
    setRenaming(id)
    setDraft(title)
  }

  const commitRename = async (id: string): Promise<void> => {
    if (draft.trim()) await rename(id, draft.trim())
    setRenaming(null)
  }

  const cancelRename = (): void => {
    setRenaming(null)
    setDraft('')
  }

  const handleRemove = async (id: string): Promise<void> => {
    if (confirm('Delete this session? This cannot be undone.')) {
      await remove(id)
    }
  }

  const relativeTime = (ms: number): string => {
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

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-start bg-black/50 p-6 backdrop-blur-sm">
      <div className="ml-14 mt-11 flex w-80 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-text">Sessions</h2>
            <p className="text-[11px] text-muted">Reopen, rename, or delete past work.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setListOpen(false)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* List */}
        <div className="max-h-96 flex-1 overflow-y-auto py-1">
          {sessions.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-muted">
              No sessions yet. Start a conversation to create one.
            </div>
          ) : (
            sessions.map((s) => {
              const isActive = s.id === activeSessionId
              const isRenaming = renaming === s.id
              const isRunning = liveSessionIds.includes(s.id)
              return (
                <div
                  key={s.id}
                  className={
                    'group flex items-center gap-2 border-b border-border px-3 py-2 transition-colors hover:bg-surface-2 ' +
                    (isActive ? 'bg-primary/10' : '')
                  }
                >
                  {isRenaming ? (
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(s.id)
                        if (e.key === 'Escape') cancelRename()
                      }}
                      onBlur={() => void commitRename(s.id)}
                      autoFocus
                      className="min-w-0 flex-1 rounded border border-primary/60 bg-bg px-2 py-1 text-[12px] text-text outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void open(s.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className={'truncate text-[12px] font-medium ' + (isActive ? 'text-primary' : 'text-text')}>
                        {s.title}
                      </div>
                      <div className={'text-[10px] ' + (isRunning ? 'text-primary' : 'text-muted')}>
                        {isRunning
                          ? 'Working…'
                          : `${s.messageCount} message${s.messageCount === 1 ? '' : 's'} · ${relativeTime(s.updatedAt)}`}
                      </div>
                    </button>
                  )}
                  {!isRenaming && (
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        aria-label="Rename"
                        onClick={() => startRename(s.id, s.title)}
                        className="grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-text"
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M11 2l3 3-8 8H3v-3l8-8Z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="Delete"
                        onClick={() => void handleRemove(s.id)}
                        className="grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-red-500/20 hover:text-red-300"
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 7v5M8 7v5M11 7v5M4 4h8v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4Z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => void create()}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            New session
          </button>
        </div>
      </div>
    </div>
  )
}
