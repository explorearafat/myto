import { describe, it, expect } from 'vitest'
import { BrowserSession, type CdpTransport } from './cowork-browser-cdp'
import type { AXNode } from './cowork-browser'

/** Terse AXNode builder — mirrors the helper in cowork-browser.test.ts. */
function ax(
  nodeId: string,
  role: string,
  opts: { name?: string; value?: string; childIds?: string[]; backendDOMNodeId?: number } = {}
): AXNode {
  return {
    nodeId,
    role: { value: role },
    name: opts.name === undefined ? undefined : { value: opts.name },
    value: opts.value === undefined ? undefined : { value: opts.value },
    childIds: opts.childIds,
    backendDOMNodeId: opts.backendDOMNodeId
  }
}

/** A small page: root with a button and a textbox, each carrying a backendDOMNodeId. */
const PAGE: AXNode[] = [
  ax('1', 'RootWebArea', { name: 'Home', childIds: ['2', '3'] }),
  ax('2', 'button', { name: 'Sign in', backendDOMNodeId: 42 }),
  ax('3', 'textbox', { name: 'Email', backendDOMNodeId: 43 })
]

interface FakeOpts {
  nodes?: AXNode[]
  innerText?: string
  /** null → DOM.resolveNode yields no objectId (element gone). */
  objectId?: string | null
}

/** Records every CDP command and answers the handful of methods the session reads. */
class FakeCdp implements CdpTransport {
  calls: { method: string; params?: Record<string, unknown> }[] = []
  loadWaited = 0
  constructor(private opts: FakeOpts = {}) {}
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    switch (method) {
      case 'Accessibility.getFullAXTree':
        return { nodes: this.opts.nodes ?? [] }
      case 'DOM.resolveNode':
        return this.opts.objectId === null ? {} : { object: { objectId: this.opts.objectId ?? 'obj-1' } }
      case 'Runtime.evaluate':
        return { result: { value: this.opts.innerText ?? '' } }
      default:
        return {}
    }
  }
  async waitForLoad(): Promise<void> {
    this.loadWaited++
  }
  methods(): string[] {
    return this.calls.map((c) => c.method)
  }
  params(method: string): Record<string, unknown> | undefined {
    return this.calls.find((c) => c.method === method)?.params
  }
}
describe('BrowserSession.navigate', () => {
  it('refuses a non-http(s) URL without touching the page', async () => {
    const cdp = new FakeCdp()
    const out = await new BrowserSession(cdp).navigate('file:///etc/passwd')
    expect(out).toMatch(/only opens http/)
    expect(cdp.methods()).not.toContain('Page.navigate')
  })

  it('normalizes a bare host, waits for load, and returns a fresh snapshot', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const out = await new BrowserSession(cdp).navigate('example.com')
    expect(out).toContain('Opened https://example.com/')
    expect(out).toContain('button "Sign in"')
    expect(cdp.params('Page.navigate')).toEqual({ url: 'https://example.com/' })
    expect(cdp.loadWaited).toBe(1)
  })
})

describe('BrowserSession.snapshot', () => {
  it('renders the AX tree as a ref-tagged outline', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const out = await new BrowserSession(cdp).snapshot()
    expect(out).toContain('- button "Sign in" [ref=e1]')
    expect(out).toContain('- textbox "Email" [ref=e2]')
    expect(cdp.methods()).toContain('Accessibility.getFullAXTree')
  })
})

describe('BrowserSession.readText', () => {
  it('returns the page text', async () => {
    const cdp = new FakeCdp({ innerText: 'Hello world' })
    expect(await new BrowserSession(cdp).readText()).toBe('Hello world')
  })
  it('gives a placeholder when the page has no text', async () => {
    const cdp = new FakeCdp({ innerText: '   ' })
    expect(await new BrowserSession(cdp).readText()).toMatch(/no readable text/)
  })
  it('truncates very long text', async () => {
    const cdp = new FakeCdp({ innerText: 'x'.repeat(9000) })
    const out = await new BrowserSession(cdp).readText()
    expect(out).toMatch(/truncated at 8000 characters/)
  })
})
describe('BrowserSession.click', () => {
  it('asks for a fresh snapshot when the ref is unknown', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const session = new BrowserSession(cdp)
    await session.snapshot()
    expect(await session.click({ ref: 'e9' })).toMatch(/Unknown ref/)
  })

  it('resolves the ref, scrolls+clicks it, and reports what it clicked', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const session = new BrowserSession(cdp)
    await session.snapshot()
    const out = await session.click({ ref: 'e1' })
    expect(out).toMatch(/Clicked button "Sign in"/)
    expect(cdp.params('DOM.resolveNode')).toEqual({ backendNodeId: 42 })
    const fn = cdp.params('Runtime.callFunctionOn')
    expect(String(fn?.functionDeclaration)).toContain('this.click()')
  })

  it('reports a stale element when the node can no longer be resolved', async () => {
    const cdp = new FakeCdp({ nodes: PAGE, objectId: null })
    const session = new BrowserSession(cdp)
    await session.snapshot()
    expect(await session.click({ ref: 'e1' })).toMatch(/no longer on the page/)
  })
})

describe('BrowserSession.type', () => {
  it('requires text (or submit)', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const session = new BrowserSession(cdp)
    await session.snapshot()
    expect(await session.type({ ref: 'e2' })).toMatch(/needs/)
  })

  it('focuses the field and types the text in-page (value + events), not via Input.insertText', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const session = new BrowserSession(cdp)
    await session.snapshot()
    const out = await session.type({ ref: 'e2', text: 'a@b.com' })
    expect(out).toMatch(/Typed into textbox "Email"/)
    // Typing now happens in-page through callFunctionOn with the text as an argument, so it
    // fires the input/change events framework/contenteditable fields need (Input.insertText did not).
    const p = cdp.params('Runtime.callFunctionOn')
    expect(String(p?.functionDeclaration)).toContain('this.focus()')
    expect(p?.arguments).toEqual([{ value: 'a@b.com' }])
    expect(cdp.methods()).not.toContain('Input.insertText')
  })

  it('presses Enter when submit is set', async () => {
    const cdp = new FakeCdp({ nodes: PAGE })
    const session = new BrowserSession(cdp)
    await session.snapshot()
    const out = await session.type({ ref: 'e2', text: 'query', submit: true })
    expect(out).toMatch(/pressed Enter/)
    const keyEvents = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent')
    expect(keyEvents).toHaveLength(2)
    expect(keyEvents[0].params).toMatchObject({ type: 'keyDown', key: 'Enter' })
  })
})
