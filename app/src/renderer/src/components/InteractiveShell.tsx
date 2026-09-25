import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useChatStore } from '../store/useChatStore'
import { useAppStore } from '../store/useAppStore'

/**
 * InteractiveShell — the live PTY face of the Terminal pane (#2).
 *
 * A real interactive shell (node-pty in main) the user drives themselves: keystrokes
 * flow to the PTY, its output streams back to this xterm.js view. The PTY lives in
 * the MAIN process keyed by the chat's `sessionId`, so this component can unmount and
 * remount freely — a tab switch, or the preview pane taking the shared right slot —
 * without killing the shell. On (re)mount we `spawn`, which either starts the PTY or
 * returns the existing session's rolling output buffer; we replay that buffer so the
 * scrollback is intact. Unmount disposes the xterm but deliberately leaves the PTY
 * alive; only an explicit Restart (or app quit) tears it down.
 *
 * Consent is enforced in main (`spawn` refuses without `cowork.terminalConsent`); the
 * Shell tab in {@link TerminalPane} also gates on it, so this only renders once armed.
 */

// Myto's palette so the shell reads as part of the app, not a stock black box.
const THEME = {
  background: '#181818',
  foreground: '#E8E8E0',
  cursor: '#E8E8E0',
  cursorAccent: '#181818',
  selectionBackground: 'rgba(176, 168, 160, 0.35)'
}

const FONT_FAMILY =
  '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "SF Mono", Menlo, monospace'

export function InteractiveShell() {
  const sessionId = useChatStore((s) => s.sessionId)
  const workspaceDir = useAppStore((s) => s.settings.cowork.workspaceDir)

  const hostRef = useRef<HTMLDivElement>(null)
  const [generation, setGeneration] = useState(0)
  const [exited, setExited] = useState<number | null>(null)
  // Set just before a kill we intend to auto-respawn from (one-click Restart).
  const restartRef = useRef(false)

  // PLACEHOLDER_EFFECT
  useEffect(() => {
    if (!sessionId) return
    const host = hostRef.current
    if (!host) return

    let disposed = false
    setExited(null)

    const term = new Terminal({
      theme: THEME,
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
    } catch {
      /* container not measured yet — falls back to xterm's 80×24 default */
    }

    // User keystrokes → PTY stdin.
    const keyDisposer = term.onData((data) => {
      window.myto.terminal.write(sessionId, data)
    })

    // PTY output → screen. The main-process broadcast carries a sessionId; a window
    // hosting a different chat's shell must ignore chunks that aren't its own.
    const offData = window.myto.terminal.onData((evt) => {
      if (evt.sessionId === sessionId) term.write(evt.data)
    })
    const offExit = window.myto.terminal.onExit((evt) => {
      if (evt.sessionId !== sessionId) return
      if (restartRef.current) {
        // One-click Restart: the kill we asked for has landed — respawn a fresh PTY.
        restartRef.current = false
        setGeneration((g) => g + 1)
      } else {
        setExited(evt.exitCode)
        term.write(
          `\r\n\x1b[90m[process exited with code ${evt.exitCode} — press Restart]\x1b[0m\r\n`
        )
      }
    })

    // Attach: spawn (start the PTY, or re-attach to an existing one) then replay its
    // rolling buffer. We subscribed above first, so a chunk that streams *during*
    // re-attach could in theory arrive before the replay — the documented, microscopic
    // limitation of instant re-attach.
    void window.myto.terminal
      .spawn(sessionId, workspaceDir || '', term.cols, term.rows)
      .then((res) => {
        if (disposed) return
        if (!res.ok) {
          term.write(
            `\r\n\x1b[31m${
              res.error === 'consent-required'
                ? 'Interactive shell is disabled. Enable it in Settings → Cowork.'
                : `Could not start shell: ${res.error ?? 'unknown error'}`
            }\x1b[0m\r\n`
          )
          return
        }
        if (res.buffer) term.write(res.buffer)
        term.focus()
      })

    // Keep the PTY's dimensions in step with the pane as it resizes.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.myto.terminal.resize(sessionId, term.cols, term.rows)
      } catch {
        /* transient 0-size mid-layout — the next observation re-fits */
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      keyDisposer.dispose()
      offData()
      offExit()
      // Deliberately NOT killing the PTY here: unmount happens on tab switch or when
      // the preview takes the shared slot, and the shell must survive to be re-attached.
      term.dispose()
    }
  }, [sessionId, workspaceDir, generation])

  const restart = (): void => {
    if (!sessionId) return
    if (exited !== null) {
      // Already dead — just respawn.
      setExited(null)
      setGeneration((g) => g + 1)
    } else {
      // Running — kill it; the exit handler auto-respawns via restartRef.
      restartRef.current = true
      window.myto.terminal.kill(sessionId)
    }
  }

  if (!sessionId) {
    return (
      <div className="grid h-full place-items-center px-4 text-center text-[12px] text-muted">
        Start a Cowork chat to open an interactive shell.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#181818]">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
        <span className="truncate text-[10px] text-[#B0A8A0]">
          Unrestricted shell · commands run directly on your machine
        </span>
        <button
          type="button"
          onClick={restart}
          className="shrink-0 rounded-md px-2 py-0.5 text-[11px] text-[#B0A8A0] transition-colors hover:bg-white/10 hover:text-[#E8E8E0]"
        >
          Restart
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 pb-2" />
    </div>
  )
}
