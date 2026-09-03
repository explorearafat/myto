/**
 * Own the lifetime of the one real-Chrome window Sylor drives.
 *
 * Everything expensive happens lazily and exactly once: the browser is located,
 * launched with its own profile, connected to over CDP, and given one tab. Concurrent
 * callers share a single in-flight start (`ensure` is single-flight), and when the user
 * closes that window — or the tab, or the whole browser — the manager resets so the
 * next request starts it cleanly instead of talking to a corpse.
 *
 * The browser runs as its own visible window rather than being mirrored inside Sylor:
 * it *is* the user's real Chrome, which is the entire reason it can reach the webapps
 * the embedded webview cannot (see `sylorium-session.ts`), and not streaming frames back
 * is also what keeps it fast.
 *
 * Signing in is the one thing the driven window cannot do: Google refuses any browser
 * with a debugging port open. So {@link ChromeManager.signIn} lets go of the profile and
 * opens a stock window on it instead, and the controlled window returns once that one
 * closes — see the method for why the handover is driven by process exit.
 *
 * Every dependency is injected, so the lifecycle is unit tested with no browser.
 */
import type { ChromeStatus } from '@shared/types'
import type { CdpClient } from './cdp'
import type { FoundBrowser } from './locate'
import type { LaunchedProcess, RunningBrowser } from './launch'
import type { ChromePage, OpenPageOptions, PageState } from './page'

export type { ChromeStatus }

/** Where a user signs in when no page asked for somewhere more specific. */
export const SIGN_IN_URL = 'https://accounts.google.com/'

/**
 * How long to wait for the driven browser to actually exit before opening the
 * sign-in window on its profile. Chrome is single-instance per `--user-data-dir`:
 * start a second one while the first still holds the profile and it hands over its
 * url and exits immediately — which would look exactly like a sign-in window that
 * flashed and vanished. The cap is here so a browser that refuses to die cannot
 * strand the user with no window at all.
 */
const PROFILE_RELEASE_MS = 4000

/** A last beat after exit, for the singleton lock file to be released. */
export const PROFILE_SETTLE_MS = 400

export interface ManagerDeps {
  locate: () => FoundBrowser | null
  launch: (browser: FoundBrowser) => Promise<RunningBrowser>
  connect: (webSocketDebuggerUrl: string) => Promise<CdpClient>
  open: (client: CdpClient, options?: OpenPageOptions) => Promise<ChromePage>
  /**
   * Open a plain, undriven window on the same profile — the only way a Google sign-in
   * succeeds, since a debugging port makes the sign-in flow refuse the browser.
   */
  launchForSignIn?: (browser: FoundBrowser, url: string) => LaunchedProcess
  /** Sleep. Injected so the profile handover is testable without real timers. */
  wait?: (ms: number) => Promise<void>
  /** Called whenever the status changes, so main can push it to the renderer. */
  onStatus?: (status: ChromeStatus) => void
}

export class ChromeManager {
  private running: RunningBrowser | null = null
  private client: CdpClient | null = null
  private page: ChromePage | null = null
  private starting: Promise<ChromePage> | null = null
  private offs: Array<() => void> = []
  private lastError: string | null = null
  private pageState: PageState = { url: '', title: '', loading: false }
  /** The clean sign-in window, while one is open. Never driven. */
  private signInProcess: LaunchedProcess | null = null

  constructor(private readonly deps: ManagerDeps) {}

  /** The browser Sylor would drive, or null when none is installed. */
  private found(): FoundBrowser | null {
    try {
      return this.deps.locate()
    } catch {
      return null
    }
  }

  /** Sleep, through the injected clock when there is one. */
  private sleep(ms: number): Promise<void> {
    if (this.deps.wait) return this.deps.wait(ms)
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  status(): ChromeStatus {
    const browser = this.running?.browser ?? this.found()
    return {
      available: Boolean(browser),
      browserName: browser?.name ?? '',
      running: Boolean(this.page),
      url: this.pageState.url,
      title: this.pageState.title,
      loading: this.pageState.loading,
      signingIn: Boolean(this.signInProcess),
      error: this.lastError
    }
  }

  private announce(): void {
    this.deps.onStatus?.(this.status())
  }

  /**
   * The live tab, starting the browser if needed. Single-flight: parallel callers wait
   * on the same start rather than opening two windows.
   */
  async ensure(url?: string): Promise<ChromePage> {
    if (this.page) return this.page
    if (this.starting) return this.starting
    this.starting = this.start(url).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(url?: string): Promise<ChromePage> {
    const browser = this.found()
    if (!browser) {
      this.lastError =
        'No Chrome, Edge or Chromium was found on this computer, so Sylor has no real browser to drive.'
      this.announce()
      throw new Error(this.lastError)
    }
    try {
      this.lastError = null
      const running = await this.deps.launch(browser)
      const client = await this.deps.connect(running.webSocketDebuggerUrl)
      const page = await this.deps.open(client, url ? { url } : undefined)
      this.running = running
      this.client = client
      this.page = page
      this.pageState = page.snapshot
      // A tab or window the user closes must not leave us holding a dead handle.
      this.offs = [
        page.onStateChange((state) => {
          this.pageState = state
          this.announce()
        }),
        client.on('Inspector.detached', () => this.forget()),
        client.on('Target.detachedFromTarget', (event) => {
          if ((event.params as { sessionId?: string }).sessionId === page.sessionId) this.forget()
        })
      ]
      running.process.on('exit', () => this.forget())
      this.announce()
      return page
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.teardown()
      this.announce()
      throw err
    }
  }

  /** Drop every handle without trying to talk to the browser (it is already gone). */
  private teardown(): void {
    for (const off of this.offs) off()
    this.offs = []
    this.page = null
    this.client = null
    this.running = null
    this.pageState = { url: '', title: '', loading: false }
  }

  /** The browser went away on its own. */
  private forget(): void {
    if (!this.page && !this.client) return
    this.teardown()
    this.announce()
  }

  /**
   * Run something against the live tab, starting the browser first if needed. Action
   * failures are the caller's business (the permission gate turns them into a result),
   * so they are not recorded as lifecycle errors.
   */
  private async withPage<T>(fn: (page: ChromePage) => Promise<T>): Promise<T> {
    const page = await this.ensure()
    return fn(page)
  }

  navigate(url: string): Promise<void> {
    return this.withPage((page) => page.navigate(url))
  }

  evaluate<T = unknown>(expression: string, userGesture = true): Promise<T> {
    return this.withPage((page) => page.evaluate<T>(expression, userGesture))
  }

  screenshot(): Promise<string> {
    return this.withPage((page) => page.screenshot())
  }

  reload(ignoreCache = false): Promise<void> {
    return this.withPage((page) => page.reload(ignoreCache))
  }

  stopLoading(): Promise<void> {
    return this.withPage((page) => page.stop())
  }

  go(delta: number): Promise<boolean> {
    return this.withPage((page) => page.go(delta))
  }

  /** Bring the browser window forward — for sign-in, which the user does themselves. */
  focus(): Promise<void> {
    return this.withPage((page) => page.focus())
  }

  /**
   * Hand the profile to a clean window so the user can sign in.
   *
   * Google rejects a sign-in from any browser with a debugging port open, so this is
   * not a matter of presentation — the port has to go. The controlled window is closed
   * (Chrome also allows only one process per profile directory), a stock window opens
   * on that same profile, and when the user closes it their session is on disk and the
   * controlled window comes back over it.
   *
   * Reopening is driven by the window's own exit rather than a timer, so the browser
   * shuts down gracefully and has flushed the new cookies before we attach again.
   */
  async signIn(url: string = SIGN_IN_URL): Promise<void> {
    if (this.signInProcess) return // one at a time; the window is already open
    const launch = this.deps.launchForSignIn
    if (!launch) throw new Error('Signing in is not available in this build.')
    const browser = this.found()
    if (!browser) {
      this.lastError =
        'No Chrome, Edge or Chromium was found on this computer, so Sylor has no real browser to drive.'
      this.announce()
      throw new Error(this.lastError)
    }

    // Subscribe *before* closing: `close()` is what kills it, so attaching first is
    // what makes the handover race-free rather than "usually in time".
    const dying = this.running?.process ?? null
    const exited = dying
      ? new Promise<void>((resolve) => {
          dying.on('exit', () => resolve())
        })
      : null
    await this.close()
    if (exited) {
      await Promise.race([exited, this.sleep(PROFILE_RELEASE_MS)])
      await this.sleep(PROFILE_SETTLE_MS)
    }

    try {
      this.lastError = null
      const child = launch(browser, url)
      this.signInProcess = child
      child.on('exit', () => {
        if (this.signInProcess !== child) return
        this.signInProcess = null
        this.announce()
        // They are signed in (or gave up) — either way, take the profile back, once
        // this window has finished letting go of it.
        void this.sleep(PROFILE_SETTLE_MS)
          .then(() => this.ensure())
          .catch(() => {
            /* reopening is best-effort; status already carries the error */
          })
      })
      this.announce()
    } catch (err) {
      this.signInProcess = null
      this.lastError = err instanceof Error ? err.message : String(err)
      this.announce()
      throw err
    }
  }

  /**
   * Stop waiting for the sign-in window and go back to driving.
   *
   * The window is closed if it is still open: its `exit` handler is what reopens the
   * controlled one, so this stays a single path rather than two ways to resume.
   */
  async finishSignIn(): Promise<void> {
    const child = this.signInProcess
    if (!child) {
      await this.ensure()
      return
    }
    try {
      child.kill()
    } catch {
      /* already gone — its exit handler still runs */
    }
  }

  /**
   * Shut the browser down. Called on app quit, and by the user closing the pane: the
   * debugging port must not outlive Sylor.
   */
  async close(): Promise<void> {
    const page = this.page
    const client = this.client
    const running = this.running
    this.teardown()
    try {
      await page?.close()
    } catch {
      /* the tab may already be gone */
    }
    client?.close()
    try {
      running?.process.kill()
    } catch {
      /* already exited */
    }
    this.announce()
  }

  /**
   * Everything Sylor started, gone: the driven window *and* a sign-in window still
   * standing. Quit must not leave a browser behind that Sylor opened.
   */
  async shutdown(): Promise<void> {
    const child = this.signInProcess
    this.signInProcess = null
    try {
      child?.kill()
    } catch {
      /* already exited */
    }
    await this.close()
  }
}

