/**
 * SyloriumChat — the agentic chat pane of the Sylorium environment (right half).
 *
 * A dedicated conversation with Sylor about the web: ask about the open page, or
 * give it a task and it will drive the browser over multiple steps (the perceive →
 * act → observe loop in useSyloriumEnv). It reads the shared {@link SyloriumEnv},
 * so it always knows which live page it can see and act on — that page is shown
 * right beside it in the browser pane. A ≡ menu holds "New chat" and the AI
 * permissions.
 *
 * Security is unchanged: Sylor is shown page structure, never cookies, passwords,
 * or field values, and sensitive actions still require your approval.
 */
import { useEffect, useRef, useState } from 'react'
import type { SyloriumEnv } from './useSyloriumEnv'
import { IconMenu, IconOcto, IconPage, IconPlus, IconSend, IconShield, IconSpark } from './icons'

/** Starter prompts shown before the first exchange. */
const SUGGESTIONS = [
  'Summarize this page',
  'What can I do on this page?',
  'Find the main search box',
  'Read the top result'
]

/** Best-effort host label for the "seeing" line (falls back gracefully). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function SyloriumChat({ env }: { env: SyloriumEnv }) {
  const { active, askLog, askBusy, aiActive, aiStatus } = env
  const endRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [askLog, askBusy])

  const onPage = !!active && !active.atHome
  const seeing = onPage ? active.title || hostOf(active.url) : null

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-bg">
      {/* ── Slim header: Sylor mark · what it's seeing · status · ≡ menu ───── */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
          <IconSpark />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-[13px] font-medium tracking-tight text-text">Sylor</span>
          {seeing && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
              <span className="shrink-0 opacity-70">
                <IconPage />
              </span>
              <span className="truncate">{seeing}</span>
            </span>
          )}
        </div>

        {aiActive && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary sylor-fade-in">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-primary" />
            {aiStatus || 'Sylor is browsing…'}
          </span>
        )}

        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="Menu"
            onClick={() => setMenuOpen((v) => !v)}
            className="sylor-press grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <IconMenu />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-9 z-50 w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg sylor-drawer-in">
                <button
                  type="button"
                  disabled={askBusy}
                  onClick={() => {
                    env.clearChat()
                    setMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-text transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="text-muted">
                    <IconPlus />
                  </span>
                  New chat
                </button>
                <button
                  type="button"
                  onClick={() => {
                    env.setShowPermissions(true)
                    setMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-text transition-colors hover:bg-surface-2"
                >
                  <span className="text-muted">
                    <IconShield />
                  </span>
                  AI permissions
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Transcript ────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-5">
          {askLog.length === 0 ? (
            <div className="sylor-fade-in pt-6 text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary/12 text-primary">
                <IconOcto size={24} />
              </div>
              <h2 className="text-[16px] font-medium text-text">Ask Sylor about the web</h2>
              <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
                Open an app or search on the left, then ask about the page — or just tell Sylor what to
                do and it will browse for you, step by step. Sensitive steps always ask you first.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={askBusy}
                    onClick={() => void env.submitAsk(s)}
                    className="sylor-press rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] text-text transition-colors hover:border-primary/40 hover:bg-surface-2 disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3.5">
              {askLog.map((line, i) => (
                <div key={i} className={line.role === 'you' ? 'flex justify-end' : 'flex justify-start'}>
                  <span
                    className={
                      'inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ' +
                      (line.role === 'you' ? 'bg-primary text-bg' : 'bg-surface-2/80 text-text')
                    }
                  >
                    {line.text}
                  </span>
                </div>
              ))}
              {askBusy && (
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
                  <span className="h-1.5 w-1.5 animate-ping rounded-full bg-primary" />
                  {aiActive && aiStatus ? aiStatus : 'working…'}
                </div>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* ── Composer ──────────────────────────────────────────────────────── */}
      <div className="border-t border-border bg-surface px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void env.submitAsk()
          }}
          className="mx-auto w-full max-w-2xl"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-2/60 p-2 focus-within:border-primary/40">
            <textarea
              value={env.askInput}
              onChange={(e) => env.setAskInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void env.submitAsk()
                }
              }}
              rows={1}
              placeholder="Ask about this page, or tell Sylor what to do…"
              className="max-h-40 min-h-[28px] w-full resize-none bg-transparent px-2 py-1 text-[13px] text-text outline-none placeholder:text-muted"
            />
            <button
              type="submit"
              disabled={askBusy || !env.askInput.trim()}
              aria-label="Send"
              className="sylor-press grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <IconSend />
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[10.5px] text-muted">
            Passwords, cookies, and session tokens are never shared with Sylor.
          </p>
        </form>
      </div>
    </div>
  )
}
