import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import type { PreviewEvent } from '@shared/types'
import {
  DEV_SERVER_RE,
  looksLikeDevServer,
  resolveDevCommand,
  setPreviewEmitter,
  startAuto,
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
