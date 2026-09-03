/**
 * Find the user's REAL browser — the one Sylor drives when it needs a page that
 * only works in a genuine Chrome.
 *
 * Sylor's own `<webview>` is Chromium, but it is *embedded* Chromium, and Google
 * (plus a few other identity providers) refuse account sign-in from an embedded
 * browser no matter how truthfully it presents itself — measured, see
 * `sylorium-session.ts`. The way to run those web apps is therefore not to disguise
 * the webview but to use the real browser the user already has installed, sign in
 * there once, and drive that.
 *
 * This module is the boring half of that: locate the executable. It takes the
 * platform, the environment, and a filesystem predicate as parameters so it can be
 * unit tested for every platform from any machine.
 */

/** What `locateBrowser` needs from the outside world (injected, so it's testable). */
export interface LocateDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** True when `path` exists and is a file we could execute. */
  exists: (path: string) => boolean
  /** An explicit path from settings, which always wins when it exists. */
  override?: string
  /** Home directory, for the per-user install locations. */
  home?: string
}

/** A browser we can drive over the DevTools protocol. */
export interface FoundBrowser {
  /** Absolute path to the executable. */
  path: string
  /** Display name for the UI ("Google Chrome", "Microsoft Edge"…). */
  name: string
}

/**
 * Candidates in preference order. Chrome first because it is what the user means by
 * "works in Chrome"; Edge next because it is a fully supported browser for the same
 * sign-in flows; unbranded Chromium last, since some providers treat it the same way
 * they treat an embedded browser.
 */
function windowsCandidates(env: Record<string, string | undefined>): FoundBrowser[] {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(
    (r): r is string => Boolean(r)
  )
  const join = (root: string, rest: string): string => `${root.replace(/[\\/]+$/, '')}\\${rest}`
  const out: FoundBrowser[] = []
  for (const root of roots) {
    out.push({ path: join(root, 'Google\\Chrome\\Application\\chrome.exe'), name: 'Google Chrome' })
  }
  for (const root of roots) {
    out.push({ path: join(root, 'Microsoft\\Edge\\Application\\msedge.exe'), name: 'Microsoft Edge' })
  }
  for (const root of roots) {
    out.push({ path: join(root, 'Chromium\\Application\\chrome.exe'), name: 'Chromium' })
  }
  return out
}

function macCandidates(home: string): FoundBrowser[] {
  const app = (dir: string, bundle: string, bin: string): string =>
    `${dir}/${bundle}.app/Contents/MacOS/${bin}`
  return [
    { path: app('/Applications', 'Google Chrome', 'Google Chrome'), name: 'Google Chrome' },
    {
      path: app(`${home}/Applications`, 'Google Chrome', 'Google Chrome'),
      name: 'Google Chrome'
    },
    { path: app('/Applications', 'Microsoft Edge', 'Microsoft Edge'), name: 'Microsoft Edge' },
    { path: app('/Applications', 'Chromium', 'Chromium'), name: 'Chromium' }
  ]
}

function linuxCandidates(): FoundBrowser[] {
  return [
    { path: '/usr/bin/google-chrome', name: 'Google Chrome' },
    { path: '/usr/bin/google-chrome-stable', name: 'Google Chrome' },
    { path: '/opt/google/chrome/chrome', name: 'Google Chrome' },
    { path: '/usr/bin/microsoft-edge', name: 'Microsoft Edge' },
    { path: '/usr/bin/chromium', name: 'Chromium' },
    { path: '/usr/bin/chromium-browser', name: 'Chromium' },
    { path: '/snap/bin/chromium', name: 'Chromium' }
  ]
}

/** Every place we would look, in preference order (exposed for diagnostics/tests). */
export function browserCandidates(deps: LocateDeps): FoundBrowser[] {
  const home = deps.home ?? deps.env.HOME ?? deps.env.USERPROFILE ?? ''
  if (deps.platform === 'win32') return windowsCandidates(deps.env)
  if (deps.platform === 'darwin') return macCandidates(home)
  return linuxCandidates()
}

/**
 * The browser to drive, or null when none is installed (the UI then explains that
 * instead of failing silently).
 */
export function locateBrowser(deps: LocateDeps): FoundBrowser | null {
  const override = deps.override?.trim()
  if (override && deps.exists(override)) return { path: override, name: 'Chosen browser' }
  for (const candidate of browserCandidates(deps)) {
    if (deps.exists(candidate.path)) return candidate
  }
  return null
}
