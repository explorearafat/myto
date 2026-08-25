import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { extname, join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { contextManager } from '../context/manager'
import { resolveSafe } from '../fs/operations'
import { spawnCommandPty } from '../terminal/pty'
import { runCommand } from '../terminal/runner'
import type { PreviewEvent, PreviewStartResult } from '../../shared/types'

/**
 * The right-side live preview back-end. Two sources feed one webview:
 *
 *  - **Static** — a tiny `node:http` server bound to `127.0.0.1:0` (ephemeral
 *    port) that serves files under the active project root, guarded by the same
 *    {@link resolveSafe} sandbox check the file tools use, so a crafted URL can
 *    never read outside the project. A debounced recursive `fs.watch` emits a
 *    `reload` so edits show up live.
 *  - **Dev server** — an arbitrary `command` (vite / next / `npm run dev`)
 *    spawned via {@link spawnCommandPty}; its `http://localhost:PORT` URL is
 *    scraped from stdout. The dev server drives its own HMR.
 *
 * Everything is localhost-only — no outbound network — consistent with the
 * offline sandbox model. Nothing here is created until the renderer asks for a
 * preview; {@link stopPreview} tears it all down on shutdown.
 */

/** MIME types for the handful of extensions a built site actually serves. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}

/** Directories whose churn must never trigger a preview reload. */
const IGNORE_RE =
  /(^|[/\\])(node_modules|\.git|dist|out|\.vite|\.next|\.turbo|coverage|release)([/\\]|$)/

/** Matches the first localhost dev-server URL a tool prints to stdout. */
const DEV_URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"]*)/i

/**
 * Matches shell commands that (re)start a long-running local dev/preview server —
 * `npm/pnpm/yarn/bun/npx run dev|start|serve|preview`, or a framework CLI's
 * dev/start/serve/preview subcommand (vite, next, astro, nuxt, remix), or a bare
 * `vite` (its default command is the dev server). Crucially it does NOT match
 * one-shot builds like `vite build` / `next build`: those exit on their own and
 * must go through the normal runner, not {@link startDev} (which would wait for a
 * URL that never comes and time out). Such commands never exit, so the engine
 * routes them to {@link startDev} — its own managed pty that scrapes the localhost
 * URL — instead of the blocking one-shot runner, which would hang the turn forever
 * with no result and no live preview.
 */
export const DEV_SERVER_RE =
  /(?:\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\b(?:vite|next|astro|nuxt|remix)\s+(?:dev|start|serve|preview)\b|\bvite\b(?!\s+build))/i

/** True when `command` looks like a long-running dev server (see {@link DEV_SERVER_RE}). */
export function looksLikeDevServer(command: string): boolean {
  return DEV_SERVER_RE.test(command)
}

/**
 * Built-output entry points to try, in preference order, when {@link startStatic}
 * is asked to serve "whatever was built" (no explicit entry). Covers the common
 * bundler output dirs so a `dist/index.html` (or `build/`, `out/`, …) previews
 * with no hand-written path.
 */
const STATIC_ENTRY_CANDIDATES = [
  'index.html',
  'dist/index.html',
  'build/index.html',
  'out/index.html',
  'public/index.html'
]

/**
 * Pick the entry to serve when the caller named none: the first candidate above
 * that actually exists under the project root. Returns `null` when nothing is
 * present, so an auto-preview attempt can be a silent no-op instead of a 404.
 */
function resolveDefaultEntry(): string | null {
  for (const candidate of STATIC_ENTRY_CANDIDATES) {
    try {
      if (existsSync(resolveSafe(candidate))) return candidate
    } catch {
      // resolveSafe never escapes the root for these literals; ignore and continue.
    }
  }
  return null
}

/** ANSI SGR color codes, stripped before URL-matching pty output. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

let staticServer: Server | null = null
let staticBaseUrl: string | null = null
let watcher: FSWatcher | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let devPty: IPty | null = null
let emitEvent: ((event: PreviewEvent) => void) | null = null

/** Wire the main→renderer event sink (set once by preview-ipc on registration). */
export function setPreviewEmitter(fn: (event: PreviewEvent) => void): void {
  emitEvent = fn
}

/** Push a lifecycle event to the renderer (no-op before the sink is wired). */
function push(event: PreviewEvent): void {
  emitEvent?.(event)
}

/** Content-type for a path, defaulting to a safe binary type. */
function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Serve one static request from under the project root. The URL path is
 * sandbox-checked with {@link resolveSafe}; anything resolving outside the root
 * (a `..` escape, an absolute path) is refused with 403. Missing files 404.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  let pathname: string
  try {
    // Parse against a dummy origin so query strings / fragments fall away.
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Bad request')
    return
  }

  let rel = pathname.replace(/^\/+/, '')
  if (rel === '') rel = 'index.html'

  let abs: string
  try {
    abs = resolveSafe(rel)
  } catch {
    // PathEscapeError — a URL that tried to climb out of the project root.
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  // A directory request serves its index.html (still inside the root).
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) abs = join(abs, 'index.html')
  } catch {
    // stat race — fall through to the existence check below.
  }

  if (!existsSync(abs)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType(abs),
    // Never cache: the whole point is that edits show up on reload.
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  })
  const stream = createReadStream(abs)
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Read error')
  })
  stream.pipe(res)
}

/** Normalize a project-relative entry into a URL path (encoded, no leading slash). */
function normalizeEntry(entry?: string): string {
  if (!entry) return 'index.html'
  const clean = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  const parts = clean.split('/').filter(Boolean).map(encodeURIComponent)
  return parts.length ? parts.join('/') : 'index.html'
}

/** Start the debounced recursive watcher once, emitting `reload` on real changes. */
function startWatcher(): void {
  if (watcher) return
  const root = contextManager.getRoot()
  const onChange = (_event: string, filename: string | Buffer | null): void => {
    const name = typeof filename === 'string' ? filename : (filename?.toString() ?? '')
    if (name && IGNORE_RE.test(name)) return
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => push({ phase: 'reload' }), 150)
  }
  try {
    watcher = watch(root, { recursive: true }, onChange)
  } catch {
    // Recursive watch is unsupported on some platforms; fall back to root-level.
    try {
      watcher = watch(root, {}, onChange)
    } catch {
      watcher = null
    }
  }
}

/**
 * Boot (or reuse) the static server and resolve with the URL for `entry`
 * (project-relative). When `entry` is omitted, serve the first built-output entry
 * that exists ({@link resolveDefaultEntry}); if nothing is built yet, resolve
 * `{ ok: false }` without booting the server or emitting an event, so an
 * auto-preview attempt is a silent no-op. Also emits a `ready` event so the panel
 * can react without threading the return value through.
 */
export function startStatic(entry?: string): Promise<PreviewStartResult> {
  return new Promise((resolve) => {
    // Resolve the target up front: an explicit entry is served verbatim; with
    // none, fall back to the first built-output entry present, or bail if none.
    let target = entry
    if (target === undefined) {
      const found = resolveDefaultEntry()
      if (found === null) {
        resolve({ ok: false, error: 'Nothing to preview yet — no built HTML found.' })
        return
      }
      target = found
    }

    const ready = (): void => {
      const url = `${staticBaseUrl}/${normalizeEntry(target)}`
      startWatcher()
      push({ phase: 'ready', url })
      resolve({ ok: true, url })
    }

    if (staticServer && staticBaseUrl) {
      ready()
      return
    }

    const server = createServer(handleRequest)
    server.once('error', (err: Error) => {
      push({ phase: 'error', message: err.message })
      resolve({ ok: false, error: err.message })
    })
    // Ephemeral port on loopback only — never reachable off the machine.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        staticServer = server
        staticBaseUrl = `http://127.0.0.1:${addr.port}`
        ready()
      } else {
        try {
          server.close()
        } catch {
          // ignore
        }
        resolve({ ok: false, error: 'Failed to bind the preview server.' })
      }
    })
  })
}

/** Kill the current dev-server pty, if any. */
function killDev(): void {
  if (!devPty) return
  try {
    devPty.kill()
  } catch {
    // Already gone.
  }
  devPty = null
}

/**
 * The install command for the project, or null when none is needed. A Node dev
 * server (Vite/Next/CRA/…) launched with no `node_modules` exits instantly —
 * "vite is not recognized" / "next: not found" — which the user experiences as
 * "React apps don't preview at all". So when the project has a `package.json`
 * but its deps aren't installed, install them first, picking the package manager
 * from the lockfile (npm otherwise). Returns null for non-Node projects and when
 * `node_modules` already exists, so a plain static site never triggers an install.
 */
function resolveInstallCommand(): string | null {
  let root: string
  try {
    root = contextManager.getRoot()
  } catch {
    return null
  }
  const has = (name: string): boolean => {
    try {
      return existsSync(join(root, name))
    } catch {
      return false
    }
  }
  if (!has('package.json')) return null
  if (has('node_modules')) return null
  if (has('pnpm-lock.yaml')) return 'pnpm install'
  if (has('yarn.lock')) return 'yarn install'
  if (has('bun.lockb') || has('bun.lock')) return 'bun install'
  return 'npm install'
}

/**
 * Spawn `command` and resolve once its localhost URL is printed. Split from
 * {@link startDev} so an optional dependency install can complete first. The wait
 * is generous (120s): a cold framework start — first-run dep optimization, an
 * initial compile — routinely runs well past the old 30s ceiling, and a premature
 * timeout looked exactly like "the preview never shows".
 */
function awaitDevUrl(command: string): Promise<PreviewStartResult> {
  return new Promise((resolve) => {
    let pty: IPty
    try {
      pty = spawnCommandPty(command)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      push({ phase: 'error', message })
      resolve({ ok: false, error: message })
      return
    }
    devPty = pty

    let settled = false
    let buffer = ''
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      const message = 'Timed out waiting for the dev server URL.'
      push({ phase: 'error', message })
      resolve({ ok: false, error: message })
      killDev()
    }, 120_000)

    pty.onData((data) => {
      if (settled) return
      buffer += data.replace(ANSI_RE, '')
      const match = buffer.match(DEV_URL_RE)
      if (match) {
        settled = true
        clearTimeout(timeout)
        // A webview can't load 0.0.0.0 or a bare IPv6 host; rewrite to loopback.
        const url = match[1].replace('0.0.0.0', '127.0.0.1').replace('[::1]', '127.0.0.1')
        push({ phase: 'ready', url })
        resolve({ ok: true, url })
        return
      }
      // Keep the scan buffer bounded on chatty servers.
      if (buffer.length > 64_000) buffer = buffer.slice(-8_000)
    })

    pty.onExit(({ exitCode }) => {
      if (settled) {
        if (devPty === pty) devPty = null
        return
      }
      settled = true
      clearTimeout(timeout)
      const message = `Dev server exited (code ${exitCode ?? 'null'}) before printing a URL.`
      push({ phase: 'error', message })
      resolve({ ok: false, error: message })
      if (devPty === pty) devPty = null
    })
  })
}

/**
 * Bring up a dev server for the live preview: when the project needs its
 * dependencies installed first ({@link resolveInstallCommand}), install them
 * (blocking) so the server can actually boot, then spawn `command` and scrape its
 * localhost URL. Replaces any prior dev server. A `starting` event fires
 * immediately; a `ready` (with URL) or `error` follows.
 */
export async function startDev(command: string): Promise<PreviewStartResult> {
  killDev()
  push({ phase: 'starting' })

  const install = resolveInstallCommand()
  if (install) {
    // Install output isn't streamed here (the panel shows its "starting"
    // placeholder); the pty runner never rejects and resolves on exit.
    const result = await runCommand(install, () => {})
    if (result.exitCode !== 0) {
      const message =
        'Could not install dependencies, so the dev server did not start. Check that Node.js/npm are installed and the project has a valid package.json.'
      push({ phase: 'error', message })
      return { ok: false, error: message }
    }
  }

  return awaitDevUrl(command)
}

/**
 * Tear everything down: kill the dev server, close the static server + watcher.
 * Emits `stopped`. Called on an explicit stop and on app shutdown (alongside
 * {@link import('../terminal/pty').killAllPtys}).
 */
export function stopPreview(): void {
  killDev()
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // Already closed.
    }
    watcher = null
  }
  if (staticServer) {
    try {
      staticServer.close()
    } catch {
      // Already closed.
    }
    staticServer = null
    staticBaseUrl = null
  }
  push({ phase: 'stopped' })
}
