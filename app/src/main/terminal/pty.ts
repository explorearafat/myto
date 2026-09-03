import { createRequire } from 'node:module'
import type { IPty } from '@lydell/node-pty'
import { contextManager } from '../context/manager'

/**
 * `@lydell/node-pty` is a prebuilt native (N-API) addon shipped as CommonJS.
 * We load it via `require` inside a try/catch so that a load failure — an ABI
 * mismatch with the running Electron, or a corrupted `.node` binary (a real
 * OneDrive risk here) — degrades terminal features gracefully instead of
 * crashing the whole app. Everything else in this module checks {@link
 * ptyAvailable} before touching it.
 */
interface NodePtyModule {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string | undefined>
    }
  ) => IPty
}

let ptyModule: NodePtyModule | null = null
let loadError: string | null = null

try {
  const nodeRequire = createRequire(import.meta.url)
  ptyModule = nodeRequire('@lydell/node-pty') as NodePtyModule
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  console.error('[sylor] node-pty failed to load; terminal disabled:', loadError)
}

/** Whether the native pty backend loaded successfully. */
export function ptyAvailable(): boolean {
  return ptyModule !== null
}

/** The reason the pty backend failed to load, if it did. */
export function ptyLoadError(): string | null {
  return loadError
}

/**
 * Test-only seam: swap the native pty backend for a controllable fake. The real
 * ConPTY backend does not deliver an exit event for a *killed* session under the
 * headless test runner, so the identity-guard race — a replaced session's delayed
 * exit must not evict its replacement — can only be reproduced deterministically
 * with a fake whose exit callback the test fires by hand. Never used in
 * production. Real end-to-end pty I/O is covered against an actual pty elsewhere.
 */
export function __setPtyBackendForTest(backend: unknown): void {
  ptyModule = backend as NodePtyModule | null
  loadError = backend ? null : 'Terminal backend unavailable (test)'
}

/**
 * The interactive shell to spawn: PowerShell on Windows, `$SHELL` elsewhere,
 * with sensible fallbacks. Sessions open in the active project root so a fresh
 * terminal lands where the user's code is.
 */
function resolveShell(): { file: string; cwd: string } {
  const cwd = contextManager.getRoot()
  if (process.platform === 'win32') {
    const file = process.env.COMSPEC?.toLowerCase().includes('powershell')
      ? process.env.COMSPEC
      : 'powershell.exe'
    return { file, cwd }
  }
  return { file: process.env.SHELL || '/bin/bash', cwd }
}

/** Callbacks a session forwards its lifecycle to (wired to IPC by the caller). */
export interface PtyHandlers {
  onData: (data: string) => void
  onExit: (exitCode: number) => void
}

/** Live interactive sessions, keyed by the renderer-generated ptyId. */
const sessions = new Map<string, IPty>()

/**
 * Spawns an interactive shell session for `id`, streaming output through
 * `handlers`. Returns an error string if the pty backend is unavailable or the
 * shell fails to spawn; returns null on success.
 */
export function createPty(
  id: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers
): string | null {
  if (!ptyModule) return loadError ?? 'Terminal backend unavailable'
  // Replace any prior session on this id (renderer remount, etc.).
  killPty(id)

  const { file, cwd } = resolveShell()
  try {
    const term = ptyModule.spawn(file, [], {
      name: 'xterm-color',
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      cwd,
      env: process.env
    })
    term.onData((data) => handlers.onData(data))
    term.onExit(({ exitCode }) => {
      // Delete/forward by identity, not just id: a replaced session's exit fires
      // asynchronously and could otherwise evict its own replacement (and emit a
      // spurious exit for a terminal the renderer has already moved on from).
      if (sessions.get(id) !== term) return
      sessions.delete(id)
      handlers.onExit(exitCode)
    })
    sessions.set(id, term)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Forwards user input to a live session (no-op if unknown). */
export function writePty(id: string, data: string): void {
  sessions.get(id)?.write(data)
}

/** Resizes a live session to match the xterm viewport (no-op if unknown). */
export function resizePty(id: string, cols: number, rows: number): void {
  const term = sessions.get(id)
  if (term) {
    try {
      term.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      // A resize can race a just-exited pty; ignore.
    }
  }
}

/** Terminates a live session and drops it from the registry (no-op if unknown). */
export function killPty(id: string): void {
  const term = sessions.get(id)
  if (!term) return
  sessions.delete(id)
  try {
    term.kill()
  } catch {
    // Already gone.
  }
}

/** Kills every live session. Called on app shutdown. */
export function killAllPtys(): void {
  for (const term of sessions.values()) {
    try {
      term.kill()
    } catch {
      // Already gone.
    }
  }
  sessions.clear()
}

/**
 * Spawns a one-shot command pty (not tracked in the interactive registry) and
 * returns the raw {@link IPty}. Used by the agent command runner. Throws if the
 * pty backend is unavailable — callers guard with {@link ptyAvailable}.
 *
 * `extraEnv` is merged over `process.env` (its values win), letting callers pass
 * context to a subprocess — e.g. the `SYLOR_*` variables an automation hook
 * reads. Omitted for ordinary commands, which inherit the plain environment.
 */
export function spawnCommandPty(
  command: string,
  cols = 120,
  rows = 30,
  extraEnv?: Record<string, string | undefined>
): IPty {
  if (!ptyModule) throw new Error(loadError ?? 'Terminal backend unavailable')
  const cwd = contextManager.getRoot()

  let file: string
  let args: string[]
  if (process.platform === 'win32') {
    file =
      process.env.COMSPEC?.toLowerCase().includes('powershell') ? process.env.COMSPEC : 'powershell.exe'
    args = ['-NoLogo', '-NoProfile', '-Command', command]
  } else {
    file = process.env.SHELL || '/bin/bash'
    args = ['-c', command]
  }

  return ptyModule.spawn(file, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env
  })
}
