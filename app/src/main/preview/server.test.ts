import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IPty } from '@lydell/node-pty'
import { contextManager } from '@main/context/manager'
import { __setPtyBackendForTest } from '@main/terminal/pty'
import type { PreviewEvent, PreviewStartResult } from '@shared/types'
import {
  DEV_SERVER_RE,
  devServerLogs,
  extractDevUrl,
  looksLikeDevServer,
  resolveDevCommand,
  setPreviewEmitter,
  startAuto,
  startDev,
  startStatic,
  stopPreview
} from '@main/preview/server'

/**
 * The preview back-end resolves everything relative to `contextManager.getRoot()`
 * (via the same sandbox check the file tools use), so each test points the
 * singleton at a fresh temp dir and tears the server down afterward. The
 * dev-server detection tests are pure and need no root.
 */
let root: string
let originalRoot: string
/** Lifecycle events pushed at the renderer during a case. */
let events: PreviewEvent[]

beforeEach(() => {
  originalRoot = contextManager.getRoot()
  root = mkdtempSync(join(tmpdir(), 'sylor-preview-'))
  contextManager.setRoot(root)
  events = []
  setPreviewEmitter((event) => events.push(event))
})

afterEach(() => {
  // Free the port + file watcher before the next case; then restore the root.
  stopPreview()
  setPreviewEmitter(() => {})
  contextManager.setRoot(originalRoot)
  rmSync(root, { recursive: true, force: true })
})

describe('looksLikeDevServer (dev-server command detection)', () => {
  it('matches long-running dev servers that never exit', () => {
    for (const command of [
      'npm run dev',
      'npm start',
      'pnpm dev',
      'yarn dev',
      'bun run dev',
      'npm run serve',
      'npm run preview',
      'vite',
      'npx vite',
      'vite preview',
      'next dev',
      'next start',
      'astro dev'
    ]) {
      expect(looksLikeDevServer(command), command).toBe(true)
    }
  })

  it('does NOT match one-shot commands, including framework builds', () => {
    // `vite build` / `next build` are one-shot: they must run through the normal
    // runner, not startDev (which would wait for a dev URL that never prints).
    for (const command of [
      'npm run build',
      'vite build',
      'next build',
      'astro build',
      'npm test',
      'npm install',
      'git status',
      'ls -la',
      'tsc --noEmit'
    ]) {
      expect(looksLikeDevServer(command), command).toBe(false)
    }
  })

  it('is stateless across calls (no global-flag lastIndex bug)', () => {
    // A `/g` regex would alternate true/false on repeated .test() calls; DEV_SERVER_RE
    // must not, since the engine tests each proposed command independently.
    expect(DEV_SERVER_RE.test('npm run dev')).toBe(true)
    expect(DEV_SERVER_RE.test('npm run dev')).toBe(true)
  })
})

describe('extractDevUrl (scraping the address out of pty output)', () => {
  it('does not let an erase-line escape become part of the URL', () => {
    // The reported bug, verbatim shape: Vite prints the URL followed by `\x1b[K`,
    // and the address bar read `http://localhost:8080/[K`.
    expect(extractDevUrl('  ➜  Local:   http://localhost:8080/\x1b[K\r\n')).toBe(
      'http://localhost:8080/'
    )
    expect(extractDevUrl('http://localhost:3000\x1b[2K\x1b[1G\r\n')).toBe('http://localhost:3000')
    expect(extractDevUrl('\x1b]0;vite\x07  Local: http://localhost:5173/\r\n')).toBe(
      'http://localhost:5173/'
    )
  })

  it('keeps the coloured, decorated line a bundler actually prints', () => {
    expect(
      extractDevUrl('  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:4321/\x1b[39m\r\n')
    ).toBe('http://localhost:4321/')
  })

  it('rewrites hosts a webview cannot load to loopback', () => {
    expect(extractDevUrl('Serving on http://0.0.0.0:8000/\n')).toBe('http://127.0.0.1:8000/')
    expect(extractDevUrl('ready on http://[::1]:5000/\n')).toBe('http://127.0.0.1:5000/')
    expect(extractDevUrl('Local: http://127.0.0.1:1234/\n')).toBe('http://127.0.0.1:1234/')
  })

  it('drops the punctuation a log line puts after a URL', () => {
    expect(extractDevUrl('Serving HTTP on port 8000 (http://0.0.0.0:8000/) ...\n')).toBe(
      'http://127.0.0.1:8000/'
    )
    expect(extractDevUrl('open http://localhost:9000/index.html.\n')).toBe(
      'http://localhost:9000/index.html'
    )
  })

  it('finds nothing in output that has no URL yet', () => {
    expect(extractDevUrl('\x1b[36mvite\x1b[39m v7.0.0 starting...\r\n')).toBeNull()
    expect(extractDevUrl('')).toBeNull()
    // A remote URL is not a preview target; only localhost forms match.
    expect(extractDevUrl('see https://vite.dev/config/\n')).toBeNull()
  })
})

describe('startStatic (built-output entry resolution)', () => {
  it('serves nothing when no built HTML exists (silent no-op)', async () => {
    const result = await startStatic()
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.url).toBeUndefined()
  })

  it('auto-serves dist/index.html when only a built output is present', async () => {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>built</title>')

    const result = await startStatic()
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    expect(result.url).toMatch(/\/dist\/index\.html$/)
  })

  it('prefers a root index.html over a built output', async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>root</title>')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>built</title>')

    const result = await startStatic()
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/\/index\.html$/)
    expect(result.url).not.toMatch(/\/dist\//)
  })

  it('serves an explicit entry verbatim', async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    const result = await startStatic('nested/page.html')
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/\/nested\/page\.html$/)
  })
})

/** Write the project's package.json for the case under test. */
function writePkg(pkg: unknown): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
}

describe('resolveDevCommand (finding the project dev server)', () => {
  it('finds nothing when the project has no package.json', () => {
    expect(resolveDevCommand()).toBeNull()
  })

  it('drives the dev script through npm by default', () => {
    writePkg({ scripts: { dev: 'vite' } })
    expect(resolveDevCommand()).toBe('npm run dev')
  })

  it('uses whichever package manager the lockfile names', () => {
    writePkg({ scripts: { dev: 'vite' } })
    for (const [lockfile, manager] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun']
    ]) {
      const abs = join(root, lockfile)
      writeFileSync(abs, '')
      expect(resolveDevCommand(), lockfile).toBe(`${manager} run dev`)
      rmSync(abs)
    }
  })

  it('prefers dev, then falls back through start/serve/preview', () => {
    writePkg({ scripts: { preview: 'vite preview', start: 'next start', dev: 'next dev' } })
    expect(resolveDevCommand()).toBe('npm run dev')

    writePkg({ scripts: { preview: 'vite preview', start: 'next start' } })
    expect(resolveDevCommand()).toBe('npm run start')

    writePkg({ scripts: { preview: 'vite preview', serve: 'ng serve' } })
    expect(resolveDevCommand()).toBe('npm run serve')

    writePkg({ scripts: { preview: 'vite preview' } })
    expect(resolveDevCommand()).toBe('npm run preview')
  })

  it('finds nothing when no script could start a server', () => {
    writePkg({ scripts: { build: 'vite build', test: 'vitest' } })
    expect(resolveDevCommand()).toBeNull()
  })

  it('ignores a script entry that is blank or not a string', () => {
    // A malformed script must not become the command `npm run dev`, which would
    // then fail in a pty for reasons the user can't see.
    writePkg({ scripts: { dev: '   ', start: 'next start' } })
    expect(resolveDevCommand()).toBe('npm run start')

    writePkg({ scripts: { dev: { run: 'vite' } } })
    expect(resolveDevCommand()).toBeNull()
  })

  it('survives a package.json the agent left half-written', () => {
    // Auto-preview fires right after a write, so it can land mid-edit.
    writeFileSync(join(root, 'package.json'), '{ "scripts": { "dev": ')
    expect(resolveDevCommand()).toBeNull()

    writePkg(['not', 'an', 'object'])
    expect(resolveDevCommand()).toBeNull()

    writePkg({ scripts: 'dev' })
    expect(resolveDevCommand()).toBeNull()
  })
})

/**
 * The blank-screen fix. `startAuto` routes a bundler app to its dev server and
 * everything else to the static serve. The dev-server branch is proven through
 * {@link resolveDevCommand} above rather than here, because taking it would spawn
 * a real long-running pty — so every case below deliberately has no dev script.
 */
describe('startAuto (previewing a project the way it actually renders)', () => {
  it('serves a self-contained page statically, with no toolchain needed', async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html><script>alert(1)</script>')
    const result = await startAuto('index.html')
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/\/index\.html$/)
  })

  it('still serves a page whose script points at a built bundle', async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html><script src="app.js"></script>')
    const result = await startAuto('index.html')
    expect(result.ok).toBe(true)
  })

  it('refuses to serve unbuilt source as a blank page, and says what to do', async () => {
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><script type="module" src="/src/main.tsx"></script>'
    )

    const result = await startAuto('index.html')
    expect(result.ok).toBe(false)
    expect(result.url).toBeUndefined()
    // Actionable, not just "failed": name the two ways out.
    expect(result.error).toMatch(/dev server/i)
    expect(result.error).toMatch(/build/i)
    // And the panel is told, so the failure isn't silent.
    expect(events.some((e) => e.phase === 'error')).toBe(true)
  })

  it('falls back to resolving a built output when given no entry', async () => {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>built</title>')

    const result = await startAuto()
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/\/dist\/index\.html$/)
  })

  it('does not mistake a non-HTML entry for something needing a bundler', async () => {
    writeFileSync(join(root, 'notes.md'), '# hello')
    const result = await startAuto('notes.md')
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/\/notes\.md$/)
  })
})

/**
 * Deliberately placed before the spawning cases below: the log is module state, so
 * "no dev server has ever run" is only true until the first {@link startDev}.
 */
describe('devServerLogs (before any dev server has run)', () => {
  it('reports that nothing was watching, rather than an empty log', async () => {
    // A static serve has no server output to be missing — a different answer from
    // "it ran and printed nothing", which the caller must be able to tell apart.
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>static</title>')
    await startStatic()

    const logs = devServerLogs()
    expect(logs.watching).toBe(false)
    expect(logs.command).toBeNull()
    expect(logs.lines).toEqual([])
    expect(logs.total).toBe(0)
  })
})

/** A fake pty the test drives by hand, mirroring the harness in `pty.test.ts`. */
interface FakePty {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (ev: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  fireData: (data: string) => void
  fireExit: (code: number) => void
}

function makeFakePty(): FakePty {
  let dataCb: (data: string) => void = () => {}
  let exitCb: (ev: { exitCode: number }) => void = () => {}
  return {
    onData: (cb) => {
      dataCb = cb
    },
    onExit: (cb) => {
      exitCb = cb
    },
    write: () => {},
    resize: () => {},
    kill: () => {},
    fireData: (data) => dataCb(data),
    fireExit: (code) => exitCb({ exitCode: code })
  }
}

/**
 * The dev server's own output — the answer to "why is the preview blank?", which
 * the guest console cannot give because in exactly that case nothing loaded. A
 * real pty is impossible here (it would need a real project and a real server), so
 * these drive the backend seam: `startDev` reaches `spawnCommandPty` synchronously
 * when the project has no `package.json` to install, so the fake exists the moment
 * the call returns and every case settles the start it began.
 */
describe('devServerLogs (what the running dev server said)', () => {
  let spawned: FakePty[]

  beforeEach(() => {
    spawned = []
    __setPtyBackendForTest({
      spawn: (): IPty => {
        const p = makeFakePty()
        spawned.push(p)
        return p as unknown as IPty
      }
    })
  })

  afterEach(() => {
    __setPtyBackendForTest(null)
  })

  /** Start a dev server and hand back its fake pty plus the pending start. */
  function start(command = 'npm run dev'): { pty: FakePty; done: Promise<PreviewStartResult> } {
    const done = startDev(command)
    expect(spawned).toHaveLength(1)
    return { pty: spawned[0], done }
  }

  it('keeps the boot output, ANSI-stripped, and names the command', async () => {
    const { pty, done } = start()
    pty.fireData('\x1b[36mvite\x1b[39m v7.0.0 \x1b[32mready in 312 ms\x1b[39m\r\n')
    pty.fireData('  \x1b[32m➜\x1b[39m  Local:   http://localhost:5173/\x1b[K\r\n')
    await expect(done).resolves.toMatchObject({ ok: true, url: 'http://localhost:5173/' })

    const logs = devServerLogs()
    expect(logs.watching).toBe(true)
    expect(logs.command).toBe('npm run dev')
    expect(logs.lines).toContain('vite v7.0.0 ready in 312 ms')
    // The whole log is plain text: an escape that reached the model would read as
    // corruption, and one inside a URL is the `[K` bug all over again.
    const all = logs.lines.join('\n')
    expect(all).not.toContain('\x1b')
    expect(all).not.toContain('[K')
  })

  it('does not let an escape split across two chunks survive as text', async () => {
    // Stripping per chunk would leave the orphaned `[K` in the line, because the
    // `\x1b` that introduces it arrived in the chunk before.
    const { pty, done } = start()
    pty.fireData('  Local:   http://localhost:5173/')
    pty.fireData('\x1b')
    pty.fireData('[K\r\n')
    await expect(done).resolves.toMatchObject({ ok: true })

    // Leading indentation is kept (a bundler's output is aligned on purpose); only
    // the trailing `\r` and the escape go.
    expect(devServerLogs().lines).toContain('  Local:   http://localhost:5173/')
  })

  it('filters to the lines that explain a failure', async () => {
    const { pty, done } = start()
    pty.fireData('  Local:   http://localhost:5173/\r\n')
    await done
    pty.fireData('Failed to compile.\r\n')
    pty.fireData('./src/App.tsx:3:10: ERROR: Could not resolve "./missing"\r\n')
    pty.fireData('warning: deprecated option\r\n')
    pty.fireData('page reload src/App.tsx\r\n')

    const errors = devServerLogs('error').lines.join('\n')
    expect(errors).toMatch(/Failed to compile/)
    expect(errors).toMatch(/Could not resolve/)
    // A chatty line is not a failure; showing it would bury the two that are.
    expect(errors).not.toMatch(/page reload/)
    expect(errors).not.toMatch(/deprecated/)

    expect(devServerLogs('warn').lines.join('\n')).toMatch(/deprecated/)
    // Filtering hides lines, it never drops them: `total` is the whole log.
    expect(devServerLogs('error').total).toBe(devServerLogs().lines.length)
  })

  it('keeps the output of a server that died before printing a URL', async () => {
    // The case that needs the log most: there is no page, so there is no console.
    const { pty, done } = start()
    pty.fireData('Error: listen EADDRINUSE: address already in use :::5173\r\n')
    pty.fireExit(1)
    await expect(done).resolves.toMatchObject({ ok: false })

    const logs = devServerLogs()
    // The command survives the process, so the log still says what was run.
    expect(logs.command).toBe('npm run dev')
    expect(logs.watching).toBe(true)
    expect(logs.lines.join('\n')).toMatch(/EADDRINUSE/)
    expect(logs.lines).toContain('[sylor] dev server exited (code 1)')
  })

  it('includes the last line even when it never got its newline', async () => {
    const { pty, done } = start()
    pty.fireData('  Local:   http://localhost:5173/\r\n')
    await done
    // A crash mid-line: the tail sits in the partial buffer, unterminated.
    pty.fireData('Fatal: out of memory')

    expect(devServerLogs().lines).toContain('Fatal: out of memory')
  })

  it('holds a bounded tail of a chatty server, newest kept', async () => {
    const { pty, done } = start()
    pty.fireData('  Local:   http://localhost:5173/\r\n')
    await done
    pty.fireData(`${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}\n`)

    const logs = devServerLogs()
    expect(logs.lines).toHaveLength(400)
    expect(logs.lines[399]).toBe('line 499')
    expect(logs.lines[0]).toBe('line 100')
  })

  it('starts a fresh log for the next dev server', async () => {
    const first = start()
    first.pty.fireData('  Local:   http://localhost:5173/\r\n')
    await first.done
    first.pty.fireData('stale output from the old server\r\n')

    // A different command replaces the running server; its log replaces the old one.
    const done = startDev('npm run start')
    expect(spawned).toHaveLength(2)
    spawned[1].fireData('  Local:   http://localhost:3000/\r\n')
    await done

    const logs = devServerLogs()
    expect(logs.command).toBe('npm run start')
    expect(logs.lines.join('\n')).not.toMatch(/stale output/)
  })
})
