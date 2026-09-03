/**
 * The browsing session Sylor's in-app page view uses — and why it is a *separate*
 * partition from the app's own.
 *
 * Two independent reasons, both load-bearing:
 *
 *   1. **CSP.** The strict app policy (`default-src 'self'`) is installed on
 *      `session.defaultSession` in `main/window.ts`. A view on the default session
 *      could not load a single real website. This partition has no such policy.
 *   2. **Identity.** Electron advertises itself in two places that Google (and a few
 *      other sign-in flows) read as "this browser or app may not be secure":
 *      the User-Agent string (`AppName/x`, `Electron/x` tokens) and the `Sec-CH-UA`
 *      client hints (an `"Electron"` brand). Both are stripped here so the session
 *      presents the plain Google-Chrome build it actually is — same Chromium engine,
 *      same version. We remove the embedded-app tokens; we do NOT fake a different
 *      browser or version. Nothing here weakens sandboxing, reads credentials, or
 *      touches the permission gate.
 *
 * The partition string is deliberately still `persist:sylorium`: renaming it would
 * orphan the cookies and logins the user already has in that profile.
 *
 * Measured limit (do not re-litigate): this is NOT enough for a Google *account*
 * sign-in, and no amount of further identity work makes it enough. With the UA fully
 * clean *and* `navigator.userAgentData` overridden via CDP so the JS-visible brands
 * read exactly `Chromium` + `Google Chrome` (and `navigator.webdriver` false), Google
 * still answers the identifier step with `/signin/rejected`. That is why Sylor also
 * drives the user's real Chrome (`chromeAdapter.ts`) and hands sign-in over to it.
 */
import { app, session } from 'electron'

/**
 * The partition the in-app page view browses in. Unchanged from when this shipped as
 * "Sylorium" — the string is a storage key, so it must survive the rename.
 */
export const BROWSER_PARTITION = 'persist:sylorium'

/** Drop the Electron + app-name tokens from a UA, leaving a clean Chrome UA. */
function cleanChromeUserAgent(ua: string): string {
  return ua
    .replace(/ Electron\/[^\s]+/g, '')
    .replace(new RegExp(` ${app.getName()}\\/[^\\s]+`, 'gi'), '')
    .replace(/ Sylor\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** First capture group of `re` against `ua`, or `fallback`. */
function pick(ua: string, re: RegExp, fallback: string): string {
  const m = ua.match(re)
  return m ? m[1] : fallback
}

let configured = false

/**
 * Configure the browsing partition so its traffic looks like ordinary desktop
 * Chrome. Idempotent and best-effort — any failure leaves the default behaviour
 * untouched (browsing still works; some sign-ins may just complain).
 */
export function configureBrowserSession(): void {
  if (configured) return
  configured = true
  try {
    const sess = session.fromPartition(BROWSER_PARTITION)
    const ua = cleanChromeUserAgent(sess.getUserAgent() || app.userAgentFallback)
    sess.setUserAgent(ua)

    // Truthful Chrome client hints (same version as the real Chromium engine), with
    // the "Electron" brand removed — that brand is the main "not secure" trigger.
    const major = pick(ua, /Chrome\/(\d+)/, '')
    const full = pick(ua, /Chrome\/([\d.]+)/, '')
    const brands = major
      ? `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`
      : ''
    const fullList = full
      ? `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not.A/Brand";v="99.0.0.0"`
      : ''

    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (lower === 'user-agent') {
          headers[key] = ua
        } else if (lower === 'sec-ch-ua' && brands) {
          headers[key] = brands
        } else if (lower === 'sec-ch-ua-full-version-list' && fullList) {
          headers[key] = fullList
        }
      }
      callback({ requestHeaders: headers })
    })
  } catch (err) {
    console.error('[sylor] failed to configure the browsing session:', err)
  }
}
