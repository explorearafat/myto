/**
 * Start the user's real browser with a DevTools endpoint Sylor can drive.
 *
 * Security shape of this, deliberately (a debugging endpoint is a capability, so it is
 * worth being explicit about what it can reach):
 *
 *   - **A dedicated profile.** We always pass our own `--user-data-dir`, never the
 *     user's normal Chrome profile. Chrome 136+ refuses `--remote-debugging-port` for
 *     the default profile anyway, and this keeps the automated window's cookies in a
 *     store of its own. The user signs in there once — but *not* in this window: a
 *     debugging port makes Google reject the sign-in, so that happens in a clean window
 *     on the same profile ({@link launchForSignIn}) and the session persists on disk.
 *   - **An unguessable port.** We ask for port `0` and read the port Chrome actually
 *     chose out of `DevToolsActivePort` in that profile. Nothing needs to guess, and
 *     two Sylor runs can't collide.
 *   - **Loopback only.** Chrome binds the debugging port to localhost; we never pass
 *     `--remote-debugging-address`. Any local process could still attach to it while
 *     it is open, so the window is opened on demand and killed when Sylor quits.
 *   - **No weakened browser.** No `--disable-web-security`, no cookie-store reading,
 *     no extension injection. It is a stock browser with a debugger attached.
 *
 * Everything the outside world provides — spawning, reading the port file, the clock —
 * is injected, so the readiness handshake is unit tested without launching Chrome.
 */
import type { FoundBrowser } from './locate'

/** The bit of a child process we depend on. */
export interface LaunchedProcess {
  pid?: number
  kill(): void
  on(event: 'exit', listener: () => void): void
}

export interface LaunchDeps {
  browser: FoundBrowser
  /** Sylor's own profile directory. Never the user's default Chrome profile. */
  userDataDir: string
  spawn: (path: string, args: string[]) => LaunchedProcess
  /** Read a file as text, or null when it isn't there yet. */
  readFile: (path: string) => string | null
  /** Delete the stale port file from a previous run, so we can't read its port. */
  removeFile?: (path: string) => void
  /** Page to open first. `about:blank` keeps the launch quiet. */
  startUrl?: string
  /** Extra flags — a settings escape hatch, not used by default. */
  extraArgs?: string[]
  /** How long Chrome gets to publish its port before we give up. */
  timeoutMs?: number
  delay?: (ms: number) => Promise<void>
  now?: () => number
}

/** A browser that is up, with a DevTools endpoint to connect to. */
export interface RunningBrowser {
  browser: FoundBrowser
  port: number
  /** `ws://127.0.0.1:<port>/devtools/browser/<id>` */
  webSocketDebuggerUrl: string
  process: LaunchedProcess
}

/** How often we look for Chrome's port file while it starts up. */
const POLL_MS = 50

/**
 * The file Chrome writes into its profile once the debugging endpoint is listening:
 * the port on line 1, the browser WebSocket path on line 2.
 *
 * The separator is derived from the directory itself rather than taken from `path`, so
 * a Windows path behaves the same when these tests run on Linux CI.
 */
export function activePortFile(userDataDir: string): string {
  const trimmed = userDataDir.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') ? '\\' : '/'
  return `${trimmed}${sep}DevToolsActivePort`
}

/** Parse `DevToolsActivePort`, or null while it is absent/half-written. */
export function parseActivePort(contents: string): { port: number; wsPath: string } | null {
  const [portLine, pathLine] = contents.split(/\r?\n/)
  const port = Number.parseInt((portLine ?? '').trim(), 10)
  const wsPath = (pathLine ?? '').trim()
  if (!Number.isInteger(port) || port <= 0 || !wsPath.startsWith('/')) return null
  return { port, wsPath }
}

/**
 * The command line. Enough to make Chrome automatable and quiet on first run, and
 * nothing that weakens it.
 *
 * `debuggable: false` drops the debugging port and nothing else — the browser is then
 * a stock Chrome that Sylor cannot drive. That mode exists for one reason: Google
 * refuses to sign in to a browser with a debugging port open (the same check that
 * blocks the embedded webview), so the sign-in itself has to happen with nothing
 * attached. See {@link launchForSignIn}.
 */
export function chromeArgs(
  userDataDir: string,
  startUrl = 'about:blank',
  extraArgs: string[] = [],
  debuggable = true
): string[] {
  return [
    ...(debuggable ? ['--remote-debugging-port=0'] : []),
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    ...extraArgs,
    startUrl
  ]
}

/**
 * Open a plain window on the same profile for the user to sign in with.
 *
 * There is no handshake to wait for here — that is the whole point. Nothing is
 * attached, no port is opened, so there is no `DevToolsActivePort` to read and nothing
 * for a site to object to. The caller watches the returned process: when the user
 * closes the window, their session is on disk in that profile and the controlled
 * window can be reopened over it.
 *
 * The controlled window must already be closed, because Chrome allows a single process
 * per `--user-data-dir` — a second launch would simply hand the URL to the browser that
 * still holds it, debugging port and all.
 */
export function launchForSignIn(deps: {
  browser: FoundBrowser
  userDataDir: string
  spawn: (path: string, args: string[]) => LaunchedProcess
  startUrl?: string
  extraArgs?: string[]
}): LaunchedProcess {
  const { browser, userDataDir, spawn, startUrl = 'about:blank', extraArgs = [] } = deps
  return spawn(browser.path, chromeArgs(userDataDir, startUrl, extraArgs, false))
}

/**
 * Launch the browser and wait until its DevTools endpoint is published. Rejects if
 * Chrome exits first or never publishes a port — the caller then tells the user, rather
 * than leaving a half-started browser behind.
 */
export async function launchBrowser(deps: LaunchDeps): Promise<RunningBrowser> {
  const {
    browser,
    userDataDir,
    spawn,
    readFile,
    removeFile,
    startUrl,
    extraArgs,
    timeoutMs = 30_000,
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now()
  } = deps

  const portFile = activePortFile(userDataDir)
  // A leftover file would hand us the previous run's port, which is either dead or
  // belongs to a browser we don't control.
  if (removeFile) {
    try {
      removeFile(portFile)
    } catch {
      /* not there, or held open — the staleness check below still protects us */
    }
  }

  const child = spawn(browser.path, chromeArgs(userDataDir, startUrl, extraArgs))
  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const deadline = now() + timeoutMs
  for (;;) {
    let contents: string | null = null
    try {
      contents = readFile(portFile)
    } catch {
      contents = null // still being written
    }
    const parsed = contents ? parseActivePort(contents) : null
    if (parsed) {
      return {
        browser,
        port: parsed.port,
        webSocketDebuggerUrl: `ws://127.0.0.1:${parsed.port}${parsed.wsPath}`,
        process: child
      }
    }
    if (exited) {
      throw new Error(`${browser.name} closed before it was ready to be controlled.`)
    }
    if (now() >= deadline) {
      try {
        child.kill()
      } catch {
        /* nothing we can do */
      }
      throw new Error(`${browser.name} did not open a debugging port within ${timeoutMs}ms.`)
    }
    await delay(POLL_MS)
  }
}


