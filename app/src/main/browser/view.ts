/**
 * The in-app page view: a `WebContentsView` the MAIN process owns and draws over
 * the renderer.
 *
 * Why main and not a renderer `<webview>`: the engine's `browse` tool lives in main,
 * so it drives this view with a direct `webContents` call. The live-preview
 * `preview_inspect` tool needs a main → renderer → main round-trip only because the
 * renderer owns that guest. Here there is no round-trip at all.
 *
 * The renderer's only jobs are telling us **where** to put it (`setBounds`, driven by
 * a `ResizeObserver` over a placeholder div) and **whether** it shows (`setVisible`).
 * That second one matters: a native view is composited above the DOM, so a panel that
 * closes — or a modal that opens — has to hide it or it covers the app.
 *
 * Security shape: `contextIsolation`, `sandbox`, no node integration, and the
 * dedicated {@link BROWSER_PARTITION} session (see `session.ts` — the strict app CSP
 * on the default session would block every real site). Popups are handed to the OS
 * browser rather than opened as unmanaged child windows.
 */
import { WebContentsView, shell, type BrowserWindow } from 'electron'
import type { BrowserBounds, BrowserViewStatus } from '@shared/types'
import { normalizeUrl } from './actions'
import { BROWSER_PARTITION, configureBrowserSession } from './session'
import { imageFromDataUrl, type BrowserTarget } from './target'

/** The page loaded when the panel is opened with no url of its own. */
export const BROWSER_HOME = 'https://duckduckgo.com/'

/** Everything about the live view, or the empty status when there isn't one. */
const DETACHED: BrowserViewStatus = {
  attached: false,
  visible: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

let host: BrowserWindow | null = null
let view: WebContentsView | null = null
let bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
let visible = false
let lastError: string | null = null
let onChange: ((status: BrowserViewStatus) => void) | null = null

/**
 * Hand the view module the window it draws into, and a callback for status pushes.
 * Called once from `app.whenReady()` after `createWindow()`.
 */
export function attachBrowserHost(
  window: BrowserWindow,
  notify: (status: BrowserViewStatus) => void
): void {
  host = window
  onChange = notify
  window.on('closed', () => {
    host = null
    destroyBrowserView()
  })
}

/** True when a live view exists. */
export function hasBrowserView(): boolean {
  return !!view && !view.webContents.isDestroyed()
}

/** Current status — cheap, and creates nothing. */
export function browserStatus(): BrowserViewStatus {
  if (!hasBrowserView()) return { ...DETACHED, error: lastError }
  const wc = view!.webContents
  return {
    attached: true,
    visible,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    error: lastError
  }
}

function push(): void {
  try {
    onChange?.(browserStatus())
  } catch {
    // A dead renderer must not take the view down with it.
  }
}

/**
 * Create the view if it doesn't exist yet, attach it to the window, and wire its
 * lifecycle to status pushes. Returns null when there is no window to attach to.
 */
function ensureView(): WebContentsView | null {
  if (hasBrowserView()) return view
  if (!host || host.isDestroyed()) return null
  configureBrowserSession()

  view = new WebContentsView({
    webPreferences: {
      // Required, not cosmetic: the strict app CSP is installed on the DEFAULT
      // session, so a default-session view could not load any real website.
      partition: BROWSER_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  const wc = view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    // Keep target=_blank inside the same view when it is a normal http(s) link, so
    // a "open in new tab" link doesn't dead-end; anything else goes to the OS.
    if (/^https?:\/\//i.test(url)) {
      void wc.loadURL(url).catch(() => undefined)
    } else {
      void shell.openExternal(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })
  wc.on('did-start-loading', push)
  wc.on('did-stop-loading', push)
  wc.on('page-title-updated', push)
  wc.on('did-navigate', () => {
    lastError = null
    push()
  })
  wc.on('did-navigate-in-page', push)
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which every ordinary in-page navigation raises.
    if (isMainFrame && code !== -3) lastError = `${description || 'Navigation failed'} (${url})`
    push()
  })

  host.contentView.addChildView(view)
  view.setBounds(bounds)
  view.setVisible(visible)
  return view
}

/** Create-if-needed and load a url. Bare hosts become https, prose becomes a search. */
export async function openBrowserView(url?: string): Promise<BrowserViewStatus> {
  const target = ensureView()
  if (!target) return { ...DETACHED, error: 'The app window is not available.' }
  visible = true
  target.setVisible(true)
  const wanted = url ? normalizeUrl(url) : target.webContents.getURL() || BROWSER_HOME
  if (wanted) {
    lastError = null
    try {
      await target.webContents.loadURL(wanted)
    } catch (err) {
      // loadURL rejects on ERR_ABORTED for ordinary redirects; did-fail-load has
      // already recorded anything that actually matters.
      void err
    }
  }
  push()
  return browserStatus()
}

/** Position the view. Ignored (but remembered) when no view exists yet. */
export function setBrowserBounds(next: BrowserBounds): void {
  bounds = {
    x: Math.round(next.x) || 0,
    y: Math.round(next.y) || 0,
    width: Math.max(0, Math.round(next.width) || 0),
    height: Math.max(0, Math.round(next.height) || 0)
  }
  if (hasBrowserView()) view!.setBounds(bounds)
}

/** Show/hide without destroying the page, so reopening the panel is instant. */
export function setBrowserVisible(next: boolean): void {
  visible = next
  if (hasBrowserView()) view!.setVisible(next)
  push()
}

/** Destroy the view and its page. */
export function destroyBrowserView(): BrowserViewStatus {
  if (view) {
    try {
      if (host && !host.isDestroyed()) host.contentView.removeChildView(view)
    } catch {
      // Already detached — nothing to undo.
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // Already gone.
    }
  }
  view = null
  visible = false
  lastError = null
  push()
  return browserStatus()
}

export async function reloadBrowserView(ignoreCache = false): Promise<void> {
  if (!hasBrowserView()) return
  const wc = view!.webContents
  if (ignoreCache) wc.reloadIgnoringCache()
  else wc.reload()
}

export function stopBrowserView(): void {
  if (hasBrowserView()) view!.webContents.stop()
}

/** Step history by `delta`; false when there is nowhere to go that way. */
export function goBrowserView(delta: number): boolean {
  if (!hasBrowserView() || !delta) return false
  const history = view!.webContents.navigationHistory
  if (delta < 0) {
    if (!history.canGoBack()) return false
    history.goBack()
    return true
  }
  if (!history.canGoForward()) return false
  history.goForward()
  return true
}

/**
 * A {@link BrowserTarget} over the in-app view, creating and revealing it on demand
 * so the agent's first `browse` needs no setup step from the user. Returns null only
 * when there is no window to attach to (headless CLI, window closed mid-run).
 */
export function appBrowserTarget(): BrowserTarget | null {
  const target = ensureView()
  if (!target) return null
  visible = true
  target.setVisible(true)
  push()
  const wc = target.webContents
  return {
    loadURL: async (url) => {
      lastError = null
      try {
        await wc.loadURL(url)
      } catch (err) {
        void err
      }
      push()
    },
    getURL: () => wc.getURL(),
    getTitle: () => wc.getTitle(),
    isLoading: () => wc.isLoading(),
    executeJavaScript: (code, userGesture) => wc.executeJavaScript(code, userGesture ?? true),
    capturePage: async () => {
      const image = await wc.capturePage()
      return imageFromDataUrl(image.isEmpty() ? '' : image.toDataURL())
    }
  }
}
