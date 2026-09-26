import { describe, it, expect } from 'vitest'
import {
  buildPageSnapshot,
  normalizeNavigationUrl,
  resolveRef,
  BROWSER_TARGETS,
  resolveBrowserTarget,
  browserToolsEnabled,
  requiresRealChromeConsent,
  describeBrowserTarget,
  chromeCandidates,
  chromeUserAgent,
  type AXNode,
  type ElementRef
} from './cowork-browser'

/** Terse AXNode builder — only the fields buildPageSnapshot reads. */
function ax(
  nodeId: string,
  role: string,
  opts: { name?: string; value?: string; childIds?: string[]; ignored?: boolean; backendDOMNodeId?: number } = {}
): AXNode {
  return {
    nodeId,
    role: { value: role },
    name: opts.name === undefined ? undefined : { value: opts.name },
    value: opts.value === undefined ? undefined : { value: opts.value },
    childIds: opts.childIds,
    ignored: opts.ignored,
    backendDOMNodeId: opts.backendDOMNodeId
  }
}

describe('buildPageSnapshot', () => {
  it('hoists generic wrappers so div soup does not add indentation', () => {
    const { outline, refs } = buildPageSnapshot([
      ax('1', 'RootWebArea', { name: 'Home', childIds: ['2'] }),
      ax('2', 'generic', { childIds: ['3'] }),
      ax('3', 'button', { name: 'Sign in', backendDOMNodeId: 42 })
    ])
    expect(outline).not.toContain('generic')
    // Button sits one level under the root, not two — the generic wrapper added no depth.
    expect(outline).toContain('\n  - button "Sign in" [ref=e1]')
    expect(refs.e1).toMatchObject({ role: 'button', name: 'Sign in', backendDOMNodeId: 42, nodeId: '3' })
  })

  it('gives a [ref] only to interactive roles, not headings or text', () => {
    const { outline, refs } = buildPageSnapshot([
      ax('1', 'RootWebArea', { childIds: ['2', '3', '4', '5'] }),
      ax('2', 'heading', { name: 'Welcome' }),
      ax('3', 'button', { name: 'Go' }),
      ax('4', 'link', { name: 'Docs' }),
      ax('5', 'paragraph', { name: 'some prose' })
    ])
    expect(Object.keys(refs)).toEqual(['e1', 'e2'])
    expect(refs.e1).toMatchObject({ role: 'button', name: 'Go' })
    expect(refs.e2).toMatchObject({ role: 'link', name: 'Docs' })
    expect(outline).toContain('- heading "Welcome"')
    expect(outline).not.toContain('heading "Welcome" [ref')
  })

  it('renders a field value and clips an over-long name', () => {
    const long = 'x'.repeat(200)
    const { outline, refs } = buildPageSnapshot([
      ax('1', 'RootWebArea', { childIds: ['2', '3'] }),
      ax('2', 'textbox', { name: 'Email', value: 'a@b.com' }),
      ax('3', 'heading', { name: long })
    ])
    expect(outline).toContain('- textbox "Email" = "a@b.com" [ref=e1]')
    expect(refs.e1.name).toBe('Email')
    expect(outline).toContain('…')
    // Clipped to the 120-char bound (119 chars + ellipsis).
    const headingLine = outline.split('\n').find((l) => l.includes('heading'))!
    expect(headingLine.length).toBeLessThan(140)
  })

  it('skips ignored nodes', () => {
    const { outline, refs } = buildPageSnapshot([
      ax('1', 'RootWebArea', { childIds: ['2', '3'] }),
      ax('2', 'button', { name: 'hidden', ignored: true }),
      ax('3', 'button', { name: 'visible' })
    ])
    expect(outline).not.toContain('hidden')
    expect(Object.keys(refs)).toEqual(['e1'])
    expect(refs.e1.name).toBe('visible')
  })

  it('returns a placeholder for an empty or content-free tree', () => {
    expect(buildPageSnapshot([]).outline).toBe('(no visible, actionable content on the page)')
    const allChrome = buildPageSnapshot([ax('1', 'generic', { childIds: ['2'] }), ax('2', 'generic')])
    expect(allChrome.outline).toBe('(no visible, actionable content on the page)')
    expect(allChrome.refs).toEqual({})
  })

  it('bounds a huge page and flags the truncation', () => {
    const kids = Array.from({ length: 250 }, (_, i) => `b${i}`)
    const nodes: AXNode[] = [ax('root', 'RootWebArea', { childIds: kids })]
    for (const id of kids) nodes.push(ax(id, 'button', { name: id }))
    const { outline, refs } = buildPageSnapshot(nodes)
    expect(outline).toContain('snapshot truncated')
    expect(Object.keys(refs).length).toBeLessThanOrEqual(200)
    expect(refs.e250).toBeUndefined()
  })
})

describe('normalizeNavigationUrl', () => {
  it('prepends https to a bare host', () => {
    expect(normalizeNavigationUrl('example.com')).toEqual({ url: 'https://example.com/' })
  })
  it('keeps an explicit http/https URL', () => {
    expect(normalizeNavigationUrl('http://x.org/a?b=1')).toEqual({ url: 'http://x.org/a?b=1' })
  })
  it('refuses non-web schemes', () => {
    expect(normalizeNavigationUrl('file:///etc/passwd')).toMatchObject({ error: expect.stringMatching(/file:/) })
    expect(normalizeNavigationUrl('javascript:alert(1)')).toMatchObject({ error: expect.stringMatching(/Refused/) })
  })
  it('rejects empty and unparseable input', () => {
    expect(normalizeNavigationUrl('')).toMatchObject({ error: expect.stringMatching(/needs a JSON input/) })
    expect(normalizeNavigationUrl('http://')).toMatchObject({ error: expect.stringMatching(/Not a valid URL/) })
  })
})

describe('resolveRef', () => {
  const refs: Record<string, ElementRef> = { e1: { ref: 'e1', role: 'button', name: 'Go', nodeId: '3' } }
  it('resolves a known ref to its element', () => {
    expect(resolveRef({ ref: 'e1' }, refs)).toMatchObject({ role: 'button', name: 'Go' })
  })
  it('asks for a ref when one is missing', () => {
    expect(resolveRef({}, refs)).toMatch(/browser_snapshot/)
  })
  it('reports an unknown ref', () => {
    expect(resolveRef({ ref: 'e9' }, refs)).toMatch(/Unknown ref/)
  })
})

describe('browser target selection', () => {
  it('lists the three user-selectable targets, off first', () => {
    expect(BROWSER_TARGETS).toEqual(['off', 'in-app', 'system-chrome'])
  })
  it('coalesces an undefined or unknown stored value to the safe default', () => {
    expect(resolveBrowserTarget(undefined)).toBe('off')
    expect(resolveBrowserTarget('nonsense' as never)).toBe('off')
    expect(resolveBrowserTarget('in-app')).toBe('in-app')
  })
  it('enables the tools for any target except off', () => {
    expect(browserToolsEnabled('off')).toBe(false)
    expect(browserToolsEnabled(undefined)).toBe(false)
    expect(browserToolsEnabled('in-app')).toBe(true)
    expect(browserToolsEnabled('system-chrome')).toBe(true)
  })
  it('requires the extra consent only for the real-Chrome target', () => {
    expect(requiresRealChromeConsent('system-chrome')).toBe(true)
    expect(requiresRealChromeConsent('in-app')).toBe(false)
    expect(requiresRealChromeConsent('off')).toBe(false)
  })
  it('describes each target for the UI and prompt', () => {
    expect(describeBrowserTarget('in-app')).toMatch(/sandboxed/i)
    expect(describeBrowserTarget('system-chrome')).toMatch(/real Chrome/i)
    expect(describeBrowserTarget('off')).toMatch(/off/i)
  })
})

describe('chromeCandidates', () => {
  it('uses the Windows Program Files env vars and includes an Edge fallback', () => {
    const paths = chromeCandidates('win32', {
      ProgramFiles: 'C:\\PF',
      'ProgramFiles(x86)': 'C:\\PFx86',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
    })
    expect(paths[0]).toBe('C:\\PF\\Google\\Chrome\\Application\\chrome.exe')
    expect(paths).toContain('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    expect(paths.some((p) => p.includes('Microsoft\\Edge\\Application\\msedge.exe'))).toBe(true)
  })
  it('drops the LOCALAPPDATA candidate when that env var is missing', () => {
    const paths = chromeCandidates('win32', {})
    expect(paths.some((p) => p.includes('AppData'))).toBe(false)
    expect(paths.every((p) => typeof p === 'string' && p.length > 0)).toBe(true)
  })
  it('returns macOS app-bundle paths', () => {
    const paths = chromeCandidates('darwin', { HOME: '/Users/me' })
    expect(paths[0]).toMatch(/Google Chrome\.app/)
    expect(paths).toContain('/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })
  it('returns Linux binary paths', () => {
    const paths = chromeCandidates('linux')
    expect(paths).toContain('/usr/bin/google-chrome')
    expect(paths).toContain('/snap/bin/chromium')
  })
})

describe('chromeUserAgent', () => {
  it('is a plain Chrome UA with no Electron or Myto tokens (so UA-sniffing sites accept it)', () => {
    const ua = chromeUserAgent('win32')
    expect(ua).toContain('Chrome/')
    expect(ua).toContain('Safari/537.36')
    expect(ua).not.toMatch(/Electron/i)
    expect(ua).not.toMatch(/Myto/i)
  })
  it('reflects the OS in the platform token', () => {
    expect(chromeUserAgent('win32')).toContain('Windows NT 10.0')
    expect(chromeUserAgent('darwin')).toContain('Macintosh')
    expect(chromeUserAgent('linux')).toContain('Linux')
  })
})
