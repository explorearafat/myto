import { app, BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { IpcChannel } from '../shared/ipc'
import type { TerminalSpawnResult } from '../shared/types'
import { getSettings } from './settings'

/*
 * Interactive terminal (#2) — a real PTY per session.
 *
 * A live pseudo-terminal (via `@lydell/node-pty`) is spawned in the MAIN process and
 * kept keyed by sessionId. This is deliberate: the xterm.js frontend can unmount and
 * remount freely (the user flips the Terminal/Preview tab, or preview takes the shared
 * layout slot) without ever killing the shell. Each session keeps a rolling output
 * buffer; {@link spawnTerminal} returns that buffer so a freshly-mounted xterm replays
 * scrollback and the shell simply continues — no second layout slot needed.
 *
 * SECURITY: this shell runs commands with NO per-call approval — it bypasses Cowork's
 * permission tiers entirely and is scoped only to its cwd. So {@link spawnTerminal}
 * refuses unless the user has flipped the sticky `cowork.terminalConsent` opt-in; the
 * renderer shows a consent panel in place of the shell until then.
 *
 * TESTABILITY: the native node-pty binary must never load under vitest (a killed
 * headless PTY never fires onExit — see the conpty-kill-no-exit note). So the spawn is
 * behind an injectable {@link PtyBackend} seam; the default backend lazy-imports the
 * native module INSIDE spawn (never at module load), and tests inject a fake.
 */

/** Rolling per-session output buffer (chars) replayed into a re-mounted xterm. */
const BUFFER_CAP = 200_000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** The slice of node-pty's `IPty` this manager uses — the seam tests fake. */
export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): void
  onExit(callback: (event: { exitCode: number }) => void): void
}

/** Spawns a {@link PtyProcess}. The default backend wraps `@lydell/node-pty`. */
export interface PtyBackend {
  spawn(
    file: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }
  ): PtyProcess
}

let backendOverride: PtyBackend | null = null
let realBackend: PtyBackend | null = null

/** Test seam: swap in a fake PTY backend (pass null to restore the native one). */
export function __setPtyBackendForTest(backend: PtyBackend | null): void {
  backendOverride = backend
}

/**
 * Resolve the PTY backend. The native module is imported lazily HERE — the first time
 * a real spawn happens — so merely importing this file (as vitest does) never touches
 * the native binary.
 */
async function loadBackend(): Promise<PtyBackend> {
  if (backendOverride) return backendOverride
  if (realBackend) return realBackend
  const pty = (await import('@lydell/node-pty')) as typeof import('@lydell/node-pty')
  realBackend = {
    spawn(file, args, options) {
      const proc = pty.spawn(file, args, {
        name: 'xterm-color',
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        env: options.env
      })
      return {
        get pid() {
          return proc.pid
        },
        write: (data) => proc.write(data),
        resize: (cols, rows) => proc.resize(cols, rows),
        kill: () => proc.kill(),
        onData: (callback) => {
          proc.onData(callback)
        },
        onExit: (callback) => {
          proc.onExit(({ exitCode }) => callback({ exitCode }))
        }
      }
    }
  }
  return realBackend
}

/** The bare interactive shell to spawn (NOT the `-c`/`/c` command-runner form). */
export function interactiveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: [] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

interface TerminalSession {
  proc: PtyProcess
  buffer: string
}

const sessions = new Map<string, TerminalSession>()

/** A positive integer grid dimension, or the fallback for a bogus/zero value. */
function clampDim(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Push a main→renderer event to every open window (the terminal has no target window). */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * Spawn the session's PTY, or re-attach to a running one. On re-attach the live PTY is
 * left untouched and its rolling buffer is returned for replay. Refuses without the
 * `cowork.terminalConsent` opt-in, or if the native backend fails to load.
 */
export async function spawnTerminal(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number
): Promise<TerminalSpawnResult> {
  const existing = sessions.get(sessionId)
  if (existing) return { ok: true, buffer: existing.buffer }

  if (!getSettings().cowork.terminalConsent) {
    return { ok: false, buffer: '', error: 'consent-required' }
  }

  try {
    const backend = await loadBackend()
    const shell = interactiveShell()
    const proc = backend.spawn(shell.file, shell.args, {
      cwd: cwd && cwd.trim() ? cwd : homedir(),
      cols: clampDim(cols, DEFAULT_COLS),
      rows: clampDim(rows, DEFAULT_ROWS),
      env: { ...process.env, TERM: 'xterm-color' }
    })
    const session: TerminalSession = { proc, buffer: '' }
    sessions.set(sessionId, session)

    proc.onData((data) => {
      // Keep only the newest BUFFER_CAP chars so a long-lived shell can't grow forever.
      session.buffer = (session.buffer + data).slice(-BUFFER_CAP)
      broadcast(IpcChannel.TerminalData, { sessionId, data })
    })
    proc.onExit(({ exitCode }) => {
      sessions.delete(sessionId)
      broadcast(IpcChannel.TerminalExit, { sessionId, exitCode })
    })

    return { ok: true, buffer: '' }
  } catch (error) {
    return {
      ok: false,
      buffer: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Feed keystrokes / pasted text to the session's PTY (no-op if none). */
export function writeTerminal(sessionId: string, data: string): void {
  sessions.get(sessionId)?.proc.write(data)
}

/** Resize the session's PTY to match the visible xterm grid (guards bad dims). */
export function resizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId)
  if (!session) return
  try {
    session.proc.resize(clampDim(cols, DEFAULT_COLS), clampDim(rows, DEFAULT_ROWS))
  } catch {
    /* a resize can throw if the pty is already gone — harmless */
  }
}

/** Kill the session's PTY (explicit restart / cleanup). The exit handler deletes it. */
export function killTerminal(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  try {
    session.proc.kill()
  } catch {
    /* already gone */
  }
}

/** Kill every live PTY (app quit). */
function killAll(): void {
  for (const session of sessions.values()) {
    try {
      session.proc.kill()
    } catch {
      /* already gone */
    }
  }
  sessions.clear()
}

let quitHookInstalled = false
function installQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  app?.on?.('before-quit', killAll)
}

/** Register the interactive-terminal IPC handlers. Called once from whenReady. */
export function registerTerminalIpc(): void {
  ipcMain.handle(
    IpcChannel.TerminalSpawn,
    (_event, sessionId: string, cwd: string, cols: number, rows: number) =>
      spawnTerminal(sessionId, cwd, cols, rows)
  )
  ipcMain.on(IpcChannel.TerminalWrite, (_event, sessionId: string, data: string) =>
    writeTerminal(sessionId, data)
  )
  ipcMain.on(IpcChannel.TerminalResize, (_event, sessionId: string, cols: number, rows: number) =>
    resizeTerminal(sessionId, cols, rows)
  )
  ipcMain.on(IpcChannel.TerminalKill, (_event, sessionId: string) => killTerminal(sessionId))
  installQuitHook()
}

/** Test-only: forget all live sessions between cases (does not touch electron). */
export function __resetTerminalsForTest(): void {
  sessions.clear()
}
