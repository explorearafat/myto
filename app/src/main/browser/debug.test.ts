/**
 * Page-debug read tests.
 *
 * These drive `debug.ts` through a fake {@link BrowserTarget} whose
 * `executeJavaScript` answers by looking at the injected source, so the whole
 * module is exercised with no browser: the recorder handshake, the honest
 * "nothing was watching" path, the `performance` fallback, and the rule that a
 * resource timing is never reported as a failure.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  installRecorder,
  inspectElement,
  readConsole,
  readNetwork
} from '@main/browser/debug'
import type { BrowserTarget } from '@main/browser/target'

/** Which read a piece of injected source is. */
function kindOf(code: string): 'recorder' | 'console' | 'network' | 'inspect' | 'other' {
  if (code.includes("return 'installed'")) return 'recorder'
  if (code.includes('s.logs.slice()')) return 'console'
  if (code.includes('getEntriesByType')) return 'network'
  if (code.includes('querySelector')) return 'inspect'
  return 'other'
}

/** A target whose page answers each read from `replies` (undefined → not present). */
function fake(replies: Partial<Record<ReturnType<typeof kindOf>, unknown>>): {
  target: BrowserTarget
  codes: string[]
} {
  const codes: string[] = []
  const target: BrowserTarget = {
    loadURL: async () => {},
    getURL: () => 'https://example.com/app',
    getTitle: () => 'App',
    isLoading: () => false,
    executeJavaScript: async (code: string) => {
      codes.push(code)
      const kind = kindOf(code)
      const reply = replies[kind]
      if (reply instanceof Error) throw reply
      return kind === 'recorder' ? (reply ?? 'installed') : (reply ?? null)
    },
    capturePage: async () => ({ toDataURL: () => '', isEmpty: () => true })
  }
  return { target, codes }
}

describe('installRecorder', () => {
  it('accepts both a fresh install and an already-present recorder', async () => {
    expect(await installRecorder(fake({ recorder: 'installed' }).target)).toBe(true)
    expect(await installRecorder(fake({ recorder: 'present' }).target)).toBe(true)
  })

  it('never throws when the page refuses the injection', async () => {
    expect(await installRecorder(fake({ recorder: 'failed' }).target)).toBe(false)
    expect(await installRecorder(fake({ recorder: new Error('CSP') }).target)).toBe(false)
  })
})

describe('readConsole', () => {
  const logs = [
    { level: 'log', text: 'booted', at: 5 },
    { level: 'warn', text: 'deprecated api', at: 10 },
    { level: 'error', text: 'Uncaught TypeError: x is not a function', at: 20 }
  ]

  it('reports every message with its level', async () => {
    const report = await readConsole(fake({ console: logs }).target)
    expect(report.text).toContain('CONSOLE (all, 3 recorded)')
    expect(report.text).toContain('[error] Uncaught TypeError: x is not a function')
    expect(report.count).toBe(3)
    expect(report.truncated).toBe(false)
  })

  it('keeps errors when asked for warnings (a warning rarely explains itself)', async () => {
    const warn = await readConsole(fake({ console: logs }).target, 'warn')
    expect(warn.text).toContain('deprecated api')
    expect(warn.text).toContain('Uncaught TypeError')
    expect(warn.text).not.toContain('booted')
    const errors = await readConsole(fake({ console: logs }).target, 'error')
    expect(errors.count).toBe(1)
    expect(errors.text).not.toContain('deprecated api')
  })

  it('says nothing was watching rather than implying the page is clean', async () => {
    const report = await readConsole(fake({ console: null }).target)
    expect(report.text).toContain('No console recorder is active')
    expect(report.text).toMatch(/read the console again/)
    expect(report.count).toBe(0)
  })

  it('distinguishes an empty buffer from a missing one', async () => {
    const report = await readConsole(fake({ console: [] }).target)
    expect(report.text).toBe('CONSOLE (all): no messages recorded.')
  })

  it('installs the recorder before reading, so the next read has a buffer', async () => {
    const { target, codes } = fake({ console: [] })
    await readConsole(target)
    expect(codes.map(kindOf)).toEqual(['recorder', 'console'])
  })

  it('caps the report and flags it as truncated', async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ level: 'log', text: `m${i}`, at: i }))
    const report = await readConsole(fake({ console: many }).target)
    expect(report.count).toBe(90)
    expect(report.truncated).toBe(true)
    // The tail is what matters when a page is spamming, so the oldest go first.
    expect(report.text).toContain('m89')
    expect(report.text).not.toContain('[log] m5\n')
  })

  it('clips one enormous message instead of flooding the turn', async () => {
    const huge = [{ level: 'error', text: 'x'.repeat(5_000), at: 1 }]
    const report = await readConsole(fake({ console: huge }).target)
    expect(report.text.length).toBeLessThan(700)
    expect(report.text).toContain('…')
  })

  it('reports a page-side failure instead of throwing', async () => {
    const report = await readConsole(fake({ console: new Error('detached') }).target)
    expect(report.text).toContain('Could not read the console')
  })
})

describe('readNetwork', () => {
  const recorded = {
    source: 'recorder',
    items: [
      { method: 'get', url: '/api/ok', status: 200, ms: 12, failed: false },
      { method: 'POST', url: '/api/save', status: 500, ms: 40, failed: true },
      { method: 'GET', url: '/api/dead', status: 0, ms: 3, failed: true }
    ]
  }

  it('reports method, status and timing from the recorder', async () => {
    const report = await readNetwork(fake({ network: recorded }).target)
    expect(report.text).toContain('NETWORK (all, 3 recorded)')
    expect(report.text).toContain('GET 200 12ms /api/ok')
    expect(report.text).toContain('POST 500 40ms /api/save')
    // A request that never got a response reads as failed, not as status 0.
    expect(report.text).toContain('GET failed 3ms /api/dead')
  })

  it('narrows to the failures when asked', async () => {
    const report = await readNetwork(fake({ network: recorded }).target, 'failed')
    expect(report.count).toBe(2)
    expect(report.text).not.toContain('/api/ok')
  })

  it('never claims a failure it cannot know about from a resource timing', async () => {
    const timings = {
      source: 'timings',
      items: [{ method: 'GET', url: '/main.js', status: 0, ms: 8, failed: false }]
    }
    const report = await readNetwork(fake({ network: timings }).target, 'failed')
    expect(report.text).toContain('/main.js')
    expect(report.text).toContain('GET — 8ms')
    expect(report.text).toContain('resource timings')
    // The header must not pass these off as the failures it was asked for.
    expect(report.text).toContain('NETWORK (failures unknown, showing all')
    expect(report.text).not.toMatch(/GET failed/)
  })

  it('admits an empty buffer and says how to get one', async () => {
    const report = await readNetwork(fake({ network: { source: 'none', items: [] } }).target)
    expect(report.text).toContain('no requests recorded')
    expect(report.text).toContain('reload or interact')
  })

  it('reports no failures without inventing any', async () => {
    const clean = { source: 'recorder', items: [{ method: 'GET', url: '/a', status: 204, ms: 1 }] }
    const report = await readNetwork(fake({ network: clean }).target, 'failed')
    expect(report.text).toBe('NETWORK (failed): no failed requests recorded.')
    expect(report.count).toBe(0)
  })

  it('reports a page-side failure instead of throwing', async () => {
    const report = await readNetwork(fake({ network: new Error('detached') }).target)
    expect(report.text).toContain('Could not read the network')
  })
})

describe('inspectElement', () => {
  const element = {
    tag: 'h1',
    id: 'title',
    className: 'hero big',
    text: 'Welcome',
    box: { x: 12, y: 40, w: 300, h: 48 },
    visible: true,
    count: 1,
    styles: { color: 'rgb(255, 0, 0)', 'font-size': '32px', display: 'block', margin: '' }
  }

  it('reports the element, its box and its computed styles', async () => {
    const report = await inspectElement(fake({ inspect: element }).target, '.hero h1')
    expect(report.text).toContain('ELEMENT .hero h1 → <h1 id="title" class="hero big">')
    expect(report.text).toContain('box: 300×48 at (12, 40)')
    expect(report.text).toContain('text: "Welcome"')
    expect(report.text).toContain('color: rgb(255, 0, 0)')
    expect(report.text).toContain('font-size: 32px')
    // An empty computed value is noise, not a finding.
    expect(report.text).not.toContain('margin:')
  })

  it('asks the page for the caller’s extra properties too', async () => {
    const { target, codes } = fake({ inspect: element })
    await inspectElement(target, '#x', ['z-index', '  ', 'gap'])
    const code = codes.find((c) => kindOf(c) === 'inspect') ?? ''
    expect(code).toContain('"z-index"')
    expect(code).toContain('"gap"')
    expect(code).toContain('"color"')
  })

  it('flags a selector that matches nothing', async () => {
    const report = await inspectElement(fake({ inspect: null }).target, '#nope')
    expect(report.text).toBe('No element matches "#nope" on this page.')
  })

  it('flags an invalid selector distinctly from a miss', async () => {
    const report = await inspectElement(fake({ inspect: { bad: true } }).target, ':::')
      expect(report.text).toBe('":::" is not a valid CSS selector.')
  })

  it('notes when several elements match and marks a hidden one', async () => {
    const hidden = { ...element, visible: false, count: 4 }
    const report = await inspectElement(fake({ inspect: hidden }).target, 'li')
    expect(report.text).toContain('(4 match, showing the first)')
    expect(report.text).toContain('NOT visible')
    expect(report.count).toBe(4)
  })

  it('does not install the recorder — reading a style changes nothing', async () => {
    const { target, codes } = fake({ inspect: element })
    await inspectElement(target, 'h1')
    expect(codes.map(kindOf)).toEqual(['inspect'])
  })

  it('reports a page-side failure instead of throwing', async () => {
    const report = await inspectElement(fake({ inspect: new Error('gone') }).target, 'h1')
    expect(report.text).toContain('Could not inspect "h1"')
  })
})

describe('the injected recorder', () => {
  it('is ES5-only, because it runs in whatever the page is', async () => {
    const { target, codes } = fake({})
    await installRecorder(target)
    const source = codes[0]
    expect(source).not.toMatch(/=>/)
    expect(source).not.toMatch(/`/)
    expect(source).not.toMatch(/\?\./)
    expect(source).not.toMatch(/\blet\b|\bconst\b/)
  })

  it('guards on a version marker so a second install is a no-op', async () => {
    const seen = vi.fn()
    const target = fake({}).target
    target.executeJavaScript = async (code) => {
      seen(code)
      return 'present'
    }
    expect(await installRecorder(target)).toBe(true)
    expect(seen.mock.calls[0][0]).toContain('__sylorDebug.v === 1')
  })
})
