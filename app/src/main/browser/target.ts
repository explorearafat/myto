/**
 * The browser surface the `browse` tool drives.
 *
 * Two very different things sit behind it:
 *
 *   1. the **in-app page view** — a `WebContentsView` the main process owns and draws
 *      over the renderer (`view.ts`). Instant and in-window, but it is still an
 *      embedded browser, so it cannot sign in to Google and friends (measured; see
 *      `session.ts`);
 *   2. the user's **real** Chrome, launched by Sylor and driven over the DevTools
 *      protocol (`chromeAdapter.ts`) — a genuine browser, so every logged-in web app
 *      they already use works.
 *
 * Both reduce to these six primitives, which is why perception, the action bodies and
 * the engine's tool executor are written once and work against either.
 */
export interface BrowserTarget {
  /** Load a URL and resolve when the navigation has been accepted. */
  loadURL(url: string): Promise<void>
  /** Current URL — must be cheap; the settle loop reads it repeatedly. */
  getURL(): string
  /** Current page title. */
  getTitle(): string
  /** True while the page is loading. Polled by the settle loop, so it must be free. */
  isLoading(): boolean
  /** Run JS in the page and resolve with its value; rejects on a page-side error. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  /** Screenshot for the vision path (canvas apps, cross-origin frames). */
  capturePage(): Promise<{ toDataURL(): string; isEmpty(): boolean }>
}

/**
 * Which of the two is being driven right now.
 *
 * Defined in `shared/types.ts` because the panel's driver control and the engine both
 * need it; re-exported here so the browser module reads as one unit.
 */
export type { BrowserDriver } from '@shared/types'

/** The minimum a capture has to look like for the vision path to use it. */
export interface CapturedImage {
  toDataURL(): string
  isEmpty(): boolean
}

/** Wrap a PNG data URL in the {@link CapturedImage} shape perception expects. */
export function imageFromDataUrl(dataUrl: string): CapturedImage {
  const value = typeof dataUrl === 'string' ? dataUrl : ''
  return {
    toDataURL: () => value,
    // A data URL with no payload after the comma is an empty capture, and the
    // vision path must skip it rather than send the model a blank image.
    isEmpty: () => !value || !value.includes(',') || value.split(',')[1].length === 0
  }
}
