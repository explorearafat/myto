/**
 * A {@link BrowserTarget} over the user's real Chrome.
 *
 * The window itself is owned by {@link ChromeManager} (launched with a Sylor-only
 * profile, driven over a loopback DevTools port); this file is only the six-primitive
 * shim that lets perception and the action bodies drive it exactly as they drive the
 * in-app view. Nothing about the browser's lifecycle lives here.
 *
 * Two details that are not obvious:
 *
 *   - `getURL`/`getTitle`/`isLoading` must be **synchronous** (the settle loop polls
 *     them), and they can be, because `ChromeManager.status()` reads a cached
 *     `pageState` kept up to date by CDP page events.
 *   - `loadURL` sets a local `loading` flag *before* awaiting `navigate`. Without it
 *     there is a window where the settle loop sees `loading === false` for the page it
 *     is replacing and declares a navigation finished that never started.
 */
import type { ChromeManager } from '../chrome/manager'
import { imageFromDataUrl, type BrowserTarget } from './target'

/** Wrap a manager as a target. Pure — the manager is injected, so this unit-tests. */
export function chromeBrowserTarget(manager: ChromeManager): BrowserTarget {
  /** Set while our own navigate is in flight, so a settle loop never reads the old page. */
  let navigating = false

  return {
    loadURL: async (url) => {
      navigating = true
      try {
        await manager.navigate(url)
      } finally {
        navigating = false
      }
    },
    getURL: () => manager.status().url,
    getTitle: () => manager.status().title,
    isLoading: () => navigating || manager.status().loading,
    executeJavaScript: (code, userGesture) => manager.evaluate(code, userGesture ?? true),
    capturePage: async () => {
      try {
        return imageFromDataUrl(await manager.screenshot())
      } catch {
        // An empty capture makes perception skip the vision path rather than send
        // the model a blank image.
        return imageFromDataUrl('')
      }
    }
  }
}
