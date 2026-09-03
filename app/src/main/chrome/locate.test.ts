/**
 * The browser locator has to be right on machines we cannot test on, so every
 * platform is exercised here with an injected filesystem predicate.
 */
import { describe, it, expect } from 'vitest'
import { browserCandidates, locateBrowser, type LocateDeps } from './locate'

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)'
}

/** Deps whose `exists` answers true only for the listed paths. */
function deps(partial: Partial<LocateDeps> & { present?: string[] }): LocateDeps {
  const present = new Set(partial.present ?? [])
  return {
    platform: partial.platform ?? 'win32',
    env: partial.env ?? WIN_ENV,
    exists: partial.exists ?? ((p) => present.has(p)),
    override: partial.override,
    home: partial.home
  }
}

describe('locateBrowser', () => {
  it('finds Chrome in Program Files on Windows', () => {
    const found = locateBrowser(
      deps({ present: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] })
    )
    expect(found).toEqual({
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      name: 'Google Chrome'
    })
  })

  it('prefers Chrome over Edge even when Edge is listed in an earlier root', () => {
    const found = locateBrowser(
      deps({
        present: [
          'C:\\Users\\A\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        ]
      })
    )
    expect(found?.name).toBe('Google Chrome')
  })

  it('falls back to Edge when no Chrome is installed', () => {
    const found = locateBrowser(
      deps({ present: ['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'] })
    )
    expect(found?.name).toBe('Microsoft Edge')
  })

  it('takes Chromium only as a last resort', () => {
    const found = locateBrowser(
      deps({ present: ['C:\\Program Files\\Chromium\\Application\\chrome.exe'] })
    )
    expect(found?.name).toBe('Chromium')
  })

  it('returns null when nothing is installed', () => {
    expect(locateBrowser(deps({ present: [] }))).toBeNull()
  })

  it('lets an explicit override win over an installed Chrome', () => {
    const found = locateBrowser(
      deps({
        present: [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'D:\\portable\\brave.exe'
        ],
        override: '  D:\\portable\\brave.exe  '
      })
    )
    expect(found).toEqual({ path: 'D:\\portable\\brave.exe', name: 'Chosen browser' })
  })

  it('ignores an override that does not exist', () => {
    const found = locateBrowser(
      deps({
        present: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
        override: 'D:\\gone.exe'
      })
    )
    expect(found?.name).toBe('Google Chrome')
  })

  it('ignores a blank override', () => {
    const found = locateBrowser(
      deps({
        present: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
        override: '   '
      })
    )
    expect(found?.name).toBe('Google Chrome')
  })

  it('finds Chrome in /Applications on macOS', () => {
    const found = locateBrowser(
      deps({
        platform: 'darwin',
        env: {},
        present: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      })
    )
    expect(found?.name).toBe('Google Chrome')
  })

  it('finds a per-user macOS install via $HOME', () => {
    const found = locateBrowser(
      deps({
        platform: 'darwin',
        env: { HOME: '/Users/a' },
        present: ['/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      })
    )
    expect(found?.path).toBe('/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('finds the usual Linux paths', () => {
    expect(
      locateBrowser(deps({ platform: 'linux', env: {}, present: ['/usr/bin/google-chrome'] }))?.name
    ).toBe('Google Chrome')
    expect(
      locateBrowser(deps({ platform: 'linux', env: {}, present: ['/snap/bin/chromium'] }))?.name
    ).toBe('Chromium')
  })
})

describe('browserCandidates', () => {
  it('skips Windows roots the environment does not define', () => {
    const paths = browserCandidates(
      deps({ env: { PROGRAMFILES: 'C:\\Program Files' } })
    ).map((c) => c.path)
    expect(paths).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Chromium\\Application\\chrome.exe'
    ])
  })

  it('does not double the separator when a root has a trailing slash', () => {
    const paths = browserCandidates(deps({ env: { PROGRAMFILES: 'C:\\Program Files\\' } })).map(
      (c) => c.path
    )
    expect(paths[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('prefers USERPROFILE when HOME is absent on macOS', () => {
    const paths = browserCandidates(
      deps({ platform: 'darwin', env: { USERPROFILE: '/Users/b' } })
    ).map((c) => c.path)
    expect(paths).toContain('/Users/b/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })
})
