import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '@shared/types'

/**
 * The OS sandbox (Principle 7 #3) is unit-tested at its PURE seams: the Seatbelt
 * profile string, the bwrap argv, and the mode/availability logic. The actual spawn
 * is a thin composition over {@link spawnCommandPty} (mocked here) and the OS
 * `sandbox-exec`/`bwrap` binaries, which a unit test can't meaningfully exercise —
 * the confinement itself is a manual/integration concern noted in the design.
 *
 * `./pty` is mocked so the suite never loads node-pty or spawns a real process. The
 * Linux `bwrap` presence check is driven through the module's injectable probe
 * ({@link __setBwrapProbe}) rather than a `node:child_process` mock: vitest does not
 * reliably redirect a `node:` builtin's binding INSIDE the source module (only inside
 * the test file), so a module mock leaves sandbox.ts calling the real `execFileSync`.
 * The injectable seam sidesteps that and drives both branches deterministically.
 */
vi.mock('./pty', () => ({
  spawnCommandPty: vi.fn(() => ({ pid: 1234 }))
}))

import {
  buildBwrapArgv,
  buildSeatbeltProfile,
  sandboxAvailable,
  sandboxModeFor,
  __resetSandboxProbes,
  __setBwrapProbe,
  type SandboxMode
} from './sandbox'

/** Temporarily pretend to be on a given platform; restored after each test. */
const realPlatform = process.platform
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  __resetSandboxProbes()
})

afterEach(() => {
  __resetSandboxProbes()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('sandboxModeFor', () => {
  it('maps plan → read-only and every other mode → workspace-write', () => {
    expect(sandboxModeFor('plan')).toBe('read-only')
    const writers: PermissionMode[] = ['ask', 'auto-edit', 'autonomous']
    for (const m of writers) expect(sandboxModeFor(m)).toBe('workspace-write')
  })
})

describe('buildSeatbeltProfile', () => {
  const ROOT = '/Users/me/project'

  it('always denies by default and allows reads broadly', () => {
    // Reads must be open — a real command reads dylibs, /etc, node itself.
    for (const mode of ['read-only', 'workspace-write'] as SandboxMode[]) {
      const p = buildSeatbeltProfile(ROOT, mode)
      expect(p).toContain('(version 1)')
      expect(p).toContain('(deny default)')
      expect(p).toContain('(allow file-read*)')
    }
  })

  it('workspace-write allows writes under the root (+ temp, /dev/null) and network', () => {
    const p = buildSeatbeltProfile(ROOT, 'workspace-write')
    expect(p).toContain('(allow file-write*')
    expect(p).toContain(`(subpath "${ROOT}")`)
    expect(p).toContain('(subpath "/tmp")')
    expect(p).toContain('(literal "/dev/null")')
    expect(p).toContain('(allow network*)')
    // It must NOT also deny writes/network — those are the read-only clauses.
    expect(p).not.toContain('(deny file-write*)')
    expect(p).not.toContain('(deny network*)')
  })

  it('read-only denies all writes and network, and grants no write subpath', () => {
    const p = buildSeatbeltProfile(ROOT, 'read-only')
    expect(p).toContain('(deny file-write*)')
    expect(p).toContain('(deny network*)')
    expect(p).not.toContain('(allow file-write*')
    expect(p).not.toContain('(allow network*)')
  })

  it('escapes a double-quote in the workspace root so the profile stays well-formed', () => {
    const p = buildSeatbeltProfile('/Users/od"d/project', 'workspace-write')
    expect(p).toContain('(subpath "/Users/od\\"d/project")')
  })
})

describe('buildBwrapArgv', () => {
  const ROOT = '/home/me/project'
  const CMD = 'echo hi'

  it('binds the whole fs read-only, a minimal dev/proc/tmp, and dies with the parent', () => {
    const argv = buildBwrapArgv(ROOT, 'workspace-write', CMD)
    expect(argv.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
    expect(argv).toContain('--die-with-parent')
    // The command is always the final `sh -c <command>`.
    expect(argv.slice(-3)).toEqual(['sh', '-c', CMD])
  })

  it('workspace-write re-binds the workspace read-write and keeps the network', () => {
    const argv = buildBwrapArgv(ROOT, 'workspace-write', CMD)
    const i = argv.indexOf('--bind')
    expect(i).toBeGreaterThan(-1)
    expect(argv.slice(i, i + 3)).toEqual(['--bind', ROOT, ROOT])
    expect(argv).not.toContain('--unshare-net')
  })

  it('read-only unshares the network and never re-binds the workspace writable', () => {
    const argv = buildBwrapArgv(ROOT, 'read-only', CMD)
    expect(argv).toContain('--unshare-net')
    expect(argv).not.toContain('--bind')
  })
})

describe('sandboxAvailable', () => {
  it('is always true on macOS (sandbox-exec ships with the OS)', () => {
    setPlatform('darwin')
    // No probe needed on darwin: if the probe were consulted it would flip this.
    __setBwrapProbe(() => false)
    expect(sandboxAvailable()).toBe(true)
  })

  it('is false on Windows — no OS confinement without a native addon (the honest fail-safe)', () => {
    setPlatform('win32')
    // Windows never consults the bwrap probe; even a "present" probe can't make it true.
    __setBwrapProbe(() => true)
    expect(sandboxAvailable()).toBe(false)
  })

  it('on Linux, tracks whether bwrap is installed', () => {
    setPlatform('linux')
    // bwrap present → available.
    __setBwrapProbe(() => true)
    expect(sandboxAvailable()).toBe(true)

    // bwrap absent → not available.
    __setBwrapProbe(() => false)
    expect(sandboxAvailable()).toBe(false)
  })

  it('memoizes the Linux bwrap probe — a second call does not re-run the check', () => {
    setPlatform('linux')
    let calls = 0
    __setBwrapProbe(() => {
      calls += 1
      return true
    })
    expect(sandboxAvailable()).toBe(true)
    expect(sandboxAvailable()).toBe(true)
    expect(calls).toBe(1)
  })
})
