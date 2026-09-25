import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'

/*
 * terminal-ipc tests drive the PTY manager against an INJECTED fake backend — the
 * native @lydell/node-pty binary must never load under vitest (a killed headless PTY
 * never fires onExit; see the conpty-kill-no-exit note). The fake's kill() fires exit
 * synchronously so the lifecycle (kill → exit → session forgotten) is observable.
 */

// electron is imported for app/BrowserWindow/ipcMain; stub it. `send` captures the
// main→renderer broadcasts; `settings` is mutable so a test can revoke consent.
const h = vi.hoisted(() => ({
  send: vi.fn(),
  settings: { cowork: { terminalConsent: true } }
}))
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: h.send } }] }
}))
vi.mock('./settings', () => ({ getSettings: () => h.settings }))

import { IpcChannel } from '../shared/ipc'
import {
  spawnTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  interactiveShell,
  __setPtyBackendForTest,
  __resetTerminalsForTest,
  type PtyBackend,
  type PtyProcess
} from './terminal-ipc'

/** A fake PTY whose emit* hooks let a test push data / exit into the manager. */
class FakeProc implements PtyProcess {
  pid = 4321
  file = ''
  args: string[] = []
  opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv } = {
    cwd: '',
    cols: 0,
    rows: 0,
    env: {}
  }
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  killed = false
  private dataCb?: (d: string) => void
  private exitCb?: (e: { exitCode: number }) => void
  write(d: string): void {
    this.writes.push(d)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }
  kill(): void {
    // Unlike a headless native PTY, the fake fires exit on kill so lifecycle is testable.
    this.killed = true
    this.exitCb?.({ exitCode: 0 })
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb
  }
  emitData(d: string): void {
    this.dataCb?.(d)
  }
  emitExit(code: number): void {
    this.exitCb?.({ exitCode: code })
  }
}

function makeBackend(): { backend: PtyBackend; created: FakeProc[] } {
  const created: FakeProc[] = []
  const backend: PtyBackend = {
    spawn(file, args, opts) {
      const p = new FakeProc()
      p.file = file
      p.args = args
      p.opts = opts
      created.push(p)
      return p
    }
  }
  return { backend, created }
}

// PLACEHOLDER_TESTS

beforeEach(() => {
  h.send.mockReset()
  h.settings.cowork.terminalConsent = true
  __resetTerminalsForTest()
})
afterEach(() => {
  __setPtyBackendForTest(null)
})

function dataCalls(): Array<{ sessionId: string; data: string }> {
  return h.send.mock.calls
    .filter(([ch]) => ch === IpcChannel.TerminalData)
    .map(([, payload]) => payload as { sessionId: string; data: string })
}
function exitCalls(): Array<{ sessionId: string; exitCode: number }> {
  return h.send.mock.calls
    .filter(([ch]) => ch === IpcChannel.TerminalExit)
    .map(([, payload]) => payload as { sessionId: string; exitCode: number })
}

describe('spawnTerminal', () => {
  it('refuses without consent and never touches the backend', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    h.settings.cowork.terminalConsent = false

    const res = await spawnTerminal('s1', '/work', 80, 24)
    expect(res).toEqual({ ok: false, buffer: '', error: 'consent-required' })
    expect(created).toHaveLength(0)
  })

  it('starts a PTY, returns an empty buffer, and passes cwd/dims through', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)

    const res = await spawnTerminal('s1', '/work', 100, 30)
    expect(res).toEqual({ ok: true, buffer: '' })
    expect(created).toHaveLength(1)
    expect(created[0].opts.cwd).toBe('/work')
    expect(created[0].opts.cols).toBe(100)
    expect(created[0].opts.rows).toBe(30)
  })

  it('falls back to the home dir and default dims for empty/bogus inputs', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)

    await spawnTerminal('s1', '   ', 0, -5)
    expect(created[0].opts.cwd).toBe(homedir())
    expect(created[0].opts.cols).toBe(80)
    expect(created[0].opts.rows).toBe(24)
  })

  it('buffers PTY output and broadcasts each chunk to the renderer', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('s1', '/work', 80, 24)

    created[0].emitData('hello ')
    created[0].emitData('world')
    expect(dataCalls()).toEqual([
      { sessionId: 's1', data: 'hello ' },
      { sessionId: 's1', data: 'world' }
    ])
  })

  it('re-attaches to a live PTY, replaying its rolling buffer without respawning', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('s1', '/work', 80, 24)
    created[0].emitData('abc')
    created[0].emitData('def')

    const res = await spawnTerminal('s1', '/work', 80, 24)
    expect(res).toEqual({ ok: true, buffer: 'abcdef' })
    expect(created).toHaveLength(1)
  })

  it('surfaces a backend spawn failure as an error result', async () => {
    __setPtyBackendForTest({
      spawn() {
        throw new Error('native load failed')
      }
    })
    const res = await spawnTerminal('s1', '/work', 80, 24)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/native load failed/)
  })
})

// PLACEHOLDER_TESTS_2

describe('writeTerminal / resizeTerminal', () => {
  it('forwards keystrokes to the session PTY', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('s1', '/work', 80, 24)

    writeTerminal('s1', 'ls -la\n')
    expect(created[0].writes).toEqual(['ls -la\n'])
  })

  it('ignores writes/resizes for an unknown session (no throw)', () => {
    expect(() => writeTerminal('nope', 'x')).not.toThrow()
    expect(() => resizeTerminal('nope', 80, 24)).not.toThrow()
  })

  it('resizes the PTY, clamping bogus dimensions to defaults', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('s1', '/work', 80, 24)

    resizeTerminal('s1', 120, 40)
    resizeTerminal('s1', 0, 0)
    expect(created[0].resizes).toEqual([
      { cols: 120, rows: 40 },
      { cols: 80, rows: 24 }
    ])
  })
})

describe('killTerminal / exit lifecycle', () => {
  it('kill fires exit, broadcasts it, and forgets the session so the next spawn is fresh', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('s1', '/work', 80, 24)

    killTerminal('s1')
    expect(created[0].killed).toBe(true)
    expect(exitCalls()).toEqual([{ sessionId: 's1', exitCode: 0 }])

    // Session was deleted on exit, so a re-spawn makes a brand-new PTY.
    await spawnTerminal('s1', '/work', 80, 24)
    expect(created).toHaveLength(2)
  })

  it('a PTY exiting on its own broadcasts the code and drops the session', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('s1', '/work', 80, 24)

    created[0].emitExit(3)
    expect(exitCalls()).toEqual([{ sessionId: 's1', exitCode: 3 }])

    const res = await spawnTerminal('s1', '/work', 80, 24)
    expect(res.buffer).toBe('') // fresh session, no replay
    expect(created).toHaveLength(2)
  })

  it('routes data/exit under the right sessionId when several shells run at once', async () => {
    const { backend, created } = makeBackend()
    __setPtyBackendForTest(backend)
    await spawnTerminal('a', '/work', 80, 24)
    await spawnTerminal('b', '/work', 80, 24)

    created[0].emitData('from-a')
    created[1].emitData('from-b')
    expect(dataCalls()).toEqual([
      { sessionId: 'a', data: 'from-a' },
      { sessionId: 'b', data: 'from-b' }
    ])
  })
})

describe('interactiveShell', () => {
  it('resolves a bare interactive shell (no command-runner args)', () => {
    const shell = interactiveShell()
    expect(typeof shell.file).toBe('string')
    expect(shell.file.length).toBeGreaterThan(0)
    expect(shell.args).toEqual([])
  })
})


