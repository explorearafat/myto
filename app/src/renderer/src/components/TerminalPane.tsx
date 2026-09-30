import { useEffect, useRef } from 'react'
import { useTerminalStore } from '../store/useTerminalStore'
import { useAppStore } from '../store/useAppStore'
import { InteractiveShell } from './InteractiveShell'

/**
 * Myto's Terminal pane (Cowork) — a tabbed right-hand surface with two faces:
 *
 * - **Agent** — a read-only transcript of the shell commands Myto runs as it works
 *   (every `run_command`: build, test, install, typecheck), fed from
 *   {@link useTerminalStore} so the user can watch real output instead of taking
 *   "it passed" on faith. Nothing here runs commands.
 * - **Shell** — a real interactive PTY the user drives themselves (#2), hosted by
 *   {@link InteractiveShell}. Gated behind an explicit one-time consent because it
 *   bypasses Cowork's per-command approval; consent lives in `cowork.terminalConsent`.
 *
 * It mirrors {@link PreviewPane}'s shape (an h-11 header over a min-h-0 flex-1 body)
 * so the two right-hand panes feel like one family. The Agent transcript auto-scrolls
 * to the newest entry — a plain scrollTop write on a div, which is safe.
 */

/** A compact header control button (matches PreviewPane's PaneButton). */
function PaneButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  )
}

/** A header tab toggle (Agent ↔ Shell). */
function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-[12px] transition-colors ${
        active ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}

// PLACEHOLDER

/** The consent gate shown on the Shell tab until the user arms the PTY. */
function ShellConsent({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[13px] font-medium text-text">Interactive shell</div>
      <p className="max-w-xs text-[12px] leading-5 text-muted">
        This opens a real shell in your Build folder. Commands you type run directly on your
        machine with no per-command approval &mdash; the same access you have in a normal
        terminal. It stays scoped to the folder Build is working in.
      </p>
      <button
        type="button"
        onClick={onEnable}
        className="rounded-lg bg-text px-3 py-1.5 text-[12px] font-medium text-bg transition-opacity hover:opacity-90"
      >
        Enable interactive shell
      </button>
      <p className="text-[10px] text-muted">You can turn this off again in Settings &rsaquo; Tools.</p>
    </div>
  )
}

export function TerminalPane() {
  const entries = useTerminalStore((s) => s.entries)
  const cwd = useTerminalStore((s) => s.cwd)
  const clear = useTerminalStore((s) => s.clear)
  const close = useTerminalStore((s) => s.close)
  const tab = useTerminalStore((s) => s.tab)
  const setTab = useTerminalStore((s) => s.setTab)

  const terminalConsent = useAppStore((s) => s.settings.cowork.terminalConsent)
  const setTerminalConsent = useAppStore((s) => s.setCoworkTerminalConsent)

  // Pin the Agent transcript to the newest command as more stream in.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tab !== 'agent') return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, tab])

  // The working folder shown in the header — just the last path segment, full path in
  // the tooltip — so the pane reads like a terminal opened in the project.
  const folder = cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd : null

  return (
    <div className="flex h-full flex-col border-l border-border bg-bg">
      {/* Header: identity + tabs on the left, controls on the right. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center text-muted">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M4.5 6.5 6.5 8l-2 1.5M8 9.5h3.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="flex items-center gap-0.5">
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>
            Agent
          </TabButton>
          <TabButton active={tab === 'shell'} onClick={() => setTab('shell')}>
            Shell
          </TabButton>
        </div>
        <div className="ml-2 min-w-0 flex-1">
          <div className="truncate text-[10px] text-muted" title={cwd ?? undefined}>
            {folder ?? 'Myto Build'}
          </div>
        </div>

        {tab === 'agent' && (
          <PaneButton label="Clear terminal" onClick={clear}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 4.5h10M6 4.5V3.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75V4.5M4.5 4.5l.6 8a1 1 0 0 0 1 .95h3.8a1 1 0 0 0 1-.95l.6-8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </PaneButton>
        )}
        <PaneButton label="Close terminal" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </PaneButton>
      </div>

      {/* Body: the agent transcript, or the interactive shell (consent-gated). */}
      {tab === 'agent' ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          {entries.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center text-[12px] text-muted">
              No commands yet. Build&rsquo;s build, test and install output shows up here.
            </div>
          ) : (
            entries.map((e, i) => (
              <div key={i} className="border-b border-border/40 px-3 py-2 font-mono text-[12px] leading-5">
                <div className="flex items-center gap-1.5 text-text">
                  <span className="shrink-0 text-muted">$</span>
                  <span className="min-w-0 flex-1 truncate" title={e.command}>
                    {e.command}
                  </span>
                  {typeof e.exitCode === 'number' && e.exitCode !== 0 && (
                    <span className="ml-auto shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                      exit {e.exitCode}
                    </span>
                  )}
                </div>
                {e.output && (
                  <pre className="mt-1 whitespace-pre-wrap break-words text-muted">{e.output}</pre>
                )}
              </div>
            ))
          )}
        </div>
      ) : terminalConsent ? (
        <InteractiveShell />
      ) : (
        <ShellConsent onEnable={() => void setTerminalConsent(true)} />
      )}
    </div>
  )
}
