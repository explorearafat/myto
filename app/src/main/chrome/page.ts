/**
 * Drive one real-Chrome tab over CDP, exposing exactly the surface Sylor already
 * uses to drive its embedded `<webview>`: navigate / evaluate / screenshot / url /
 * title / loading / history. Matching that surface is the point — the permission gate
 * (`controller.ts`), the perception pass and the agent loop are all written against
 * those primitives, so aiming them at real Chrome becomes an adapter rather than a
 * rewrite.
 *
 * `url`, `title` and `loading` are mirrored state, updated from events
 * (`Target.targetInfoChanged` on the browser connection, `Page.frame*Loading` in the
 * tab's own session) rather than fetched on demand: Sylor's settle loop reads
 * `loading` every 50ms, so reading it has to be free.
 */
import type { CdpClient } from './cdp'

/** The page facts the renderer mirrors, so its getters can stay synchronous. */
export interface PageState {
  url: string
  title: string
  loading: boolean
}

interface EvaluateAnswer {
  result?: { value?: unknown }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

interface TargetInfo {
  targetId?: string
  url?: string
  title?: string
}

/** One attached tab. Create it with {@link openPage}. */
export class ChromePage {
  private readonly listeners = new Set<(state: PageState) => void>()
  private readonly offs: Array<() => void> = []
  private state: PageState = { url: '', title: '', loading: false }
  private closed = false

  constructor(
    private readonly client: CdpClient,
    readonly targetId: string,
    readonly sessionId: string,
    private mainFrameId: string
  ) {
    this.offs.push(
      client.on('Target.targetInfoChanged', (event) => {
        const info = (event.params as { targetInfo?: TargetInfo }).targetInfo
        if (!info || info.targetId !== this.targetId) return
        this.patch({ url: info.url ?? this.state.url, title: info.title ?? this.state.title })
      }),
      client.on('Page.frameStartedLoading', (event) => {
        if (this.isMainFrame(event.params)) this.patch({ loading: true })
      }),
      client.on('Page.frameStoppedLoading', (event) => {
        if (this.isMainFrame(event.params)) this.patch({ loading: false })
      }),
      client.on('Page.frameNavigated', (event) => {
        const frame = (event.params as { frame?: { id?: string; url?: string; parentId?: string } })
          .frame
        if (!frame || frame.parentId) return
        // A cross-process navigation hands the main frame a new id.
        if (frame.id) this.mainFrameId = frame.id
        if (frame.url) this.patch({ url: frame.url })
      })
    )
  }

  private isMainFrame(params: Record<string, unknown>): boolean {
    return (params as { frameId?: string }).frameId === this.mainFrameId
  }

  private patch(next: Partial<PageState>): void {
    const merged = { ...this.state, ...next }
    if (
      merged.url === this.state.url &&
      merged.title === this.state.title &&
      merged.loading === this.state.loading
    ) {
      return
    }
    this.state = merged
    for (const listener of [...this.listeners]) {
      try {
        listener(merged)
      } catch (err) {
        console.error('[sylor] a Chrome page listener threw:', err)
      }
    }
  }

  /** Current mirrored state (a copy, so callers can't edit ours). */
  get snapshot(): PageState {
    return { ...this.state }
  }

  /** Subscribe to state changes; returns the unsubscribe. */
  onStateChange(listener: (state: PageState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Seed the mirrored state at attach time (before any event has fired). */
  setInitialState(state: Partial<PageState>): void {
    this.patch(state)
  }

  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId)
  }

  /** Go to `url`. Rejects with Chrome's own reason when the load is refused. */
  async navigate(url: string): Promise<void> {
    this.patch({ loading: true })
    const answer = await this.call<{ errorText?: string; frameId?: string }>('Page.navigate', {
      url
    })
    if (answer.errorText) throw new Error(`${url} could not be loaded: ${answer.errorText}`)
    if (answer.frameId) this.mainFrameId = answer.frameId
  }

  /**
   * Run `expression` in the page and resolve with its value. Throws on a page-side
   * exception, which is what the `<webview>` version does — the controller's try/catch
   * relies on it.
   */
  async evaluate<T = unknown>(expression: string, userGesture = true): Promise<T> {
    const answer = await this.call<EvaluateAnswer>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture
    })
    const failure = answer.exceptionDetails
    if (failure) {
      throw new Error(failure.exception?.description ?? failure.text ?? 'The page threw an error.')
    }
    return answer.result?.value as T
  }

  /** PNG data URL of the visible page — the vision fallback perception uses. */
  async screenshot(): Promise<string> {
    const answer = await this.call<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    if (!answer.data) throw new Error('Chrome returned an empty screenshot.')
    return `data:image/png;base64,${answer.data}`
  }

  async reload(ignoreCache = false): Promise<void> {
    this.patch({ loading: true })
    await this.call('Page.reload', { ignoreCache })
  }

  async stop(): Promise<void> {
    await this.call('Page.stopLoading')
    this.patch({ loading: false })
  }

  /**
   * Step through history. `delta` is -1 for back, +1 for forward; resolves false when
   * there is nowhere to go (so the caller can keep `canGoBack`-style UI honest).
   */
  async go(delta: number): Promise<boolean> {
    const history = await this.call<{
      currentIndex?: number
      entries?: Array<{ id?: number }>
    }>('Page.getNavigationHistory')
    const entries = history.entries ?? []
    const index = (history.currentIndex ?? 0) + delta
    const entry = entries[index]
    if (index < 0 || index >= entries.length || typeof entry?.id !== 'number') return false
    this.patch({ loading: true })
    await this.call('Page.navigateToHistoryEntry', { entryId: entry.id })
    return true
  }

  /** Bring this tab to the front — used when the user has to sign in themselves. */
  async focus(): Promise<void> {
    await this.client.send('Target.activateTarget', { targetId: this.targetId })
  }

  /** Close the tab and stop listening. Safe to call twice. */
  async close(): Promise<void> {
    for (const off of this.offs) off()
    this.offs.length = 0
    this.listeners.clear()
    if (this.closed) return
    this.closed = true
    try {
      await this.client.send('Target.closeTarget', { targetId: this.targetId })
    } catch {
      /* the tab or the whole browser is already gone */
    }
  }
}

export interface OpenPageOptions {
  /** First url. `about:blank` keeps the tab quiet until Sylor navigates. */
  url?: string
  /** Adopt this existing tab instead of creating one. */
  targetId?: string
}

/**
 * Create (or adopt) a tab and attach to it.
 *
 * Target discovery is turned on so `Target.targetInfoChanged` keeps url and title
 * mirrored for free, and `Page` is enabled inside the tab's own session for the loading
 * events. `flatten: true` multiplexes that session over the single browser socket,
 * which is why every later command simply carries a `sessionId`.
 */
export async function openPage(
  client: CdpClient,
  options: OpenPageOptions = {}
): Promise<ChromePage> {
  await client.send('Target.setDiscoverTargets', { discover: true })
  const targetId =
    options.targetId ??
    (
      await client.send<{ targetId?: string }>('Target.createTarget', {
        url: options.url ?? 'about:blank'
      })
    ).targetId
  if (!targetId) throw new Error('Chrome did not open a tab.')

  const attached = await client.send<{ sessionId?: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  })
  if (!attached.sessionId) throw new Error('Sylor could not attach to the Chrome tab.')

  await client.send('Page.enable', undefined, attached.sessionId)
  const tree = await client.send<{ frameTree?: { frame?: { id?: string; url?: string } } }>(
    'Page.getFrameTree',
    undefined,
    attached.sessionId
  )
  const info = await client.send<{ targetInfo?: TargetInfo }>('Target.getTargetInfo', { targetId })

  const page = new ChromePage(client, targetId, attached.sessionId, tree.frameTree?.frame?.id ?? '')
  page.setInitialState({
    url: info.targetInfo?.url ?? tree.frameTree?.frame?.url ?? options.url ?? '',
    title: info.targetInfo?.title ?? ''
  })
  return page
}


