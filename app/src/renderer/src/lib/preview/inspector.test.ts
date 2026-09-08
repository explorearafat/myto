/**
 * The renderer half of `preview_inspect`, driven the way the engine drives it:
 * through the IPC handler {@link initPreviewInspector} registers, with a fake
 * `<webview>` standing in for the guest page.
 *
 * The focus is the three actions that make the pane a real browser — `eval`,
 * `navigate` and reload — plus the loopback rule that keeps the pane pointed at the
 * user's own app. The fixed read actions run their scan against a real page in
 * `perception`'s own tests, so they are not repeated here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewInspectRequest, PreviewInspectResponse } from '@shared/types'
import type { WebviewElement } from '@renderer/types/webview'
import { useAppStore } from '@renderer/store/useAppStore'
import { initPreviewInspector, setPreviewWebview } from '@renderer/lib/preview/inspector'

/** The mocked preview IPC surface from the renderer test setup. */
const previewApi = window.sylor.preview as unknown as {
  onInspectRequest: ReturnType<typeof vi.fn>
  respondInspect: ReturnType<typeof vi.fn>
}

/**
 * The engine's only way in. Captured at init (which is idempotent, so it happens
 * once for the whole file) and called by hand in place of the IPC hop.
 */
let handler: (req: PreviewInspectRequest) => void = () => {}
previewApi.onInspectRequest.mockImplementation((cb: (req: PreviewInspectRequest) => void) => {
  handler = cb
  return () => {}
})
initPreviewInspector()

/** Post one request and wait for the reply the handler sends back. */
async function ask(req: Omit<PreviewInspectRequest, 'requestId'>): Promise<PreviewInspectResponse> {
  const before = previewApi.respondInspect.mock.calls.length
  handler({ requestId: 'r1', ...req })
  await vi.waitFor(
    () => {
      if (previewApi.respondInspect.mock.calls.length <= before) throw new Error('no reply yet')
    },
    { timeout: 4_000, interval: 20 }
  )
  return previewApi.respondInspect.mock.calls.at(-1)?.[0] as PreviewInspectResponse
}

/** A stand-in for the guest element, with the calls it received on show. */
interface FakeWebview extends WebviewElement {
  /** Every script the inspector injected, newest last. */
  js: string[]
  /** How many times a reload was asked for. */
  reloads: number
  /** What an injected script resolves to — or throws, to fail in the page. */
  answer: (code: string) => unknown
}

function fakeWebview(url = 'http://localhost:5173/', title = 'My App'): FakeWebview {
  // A real element, so the console listeners setPreviewWebview attaches work.
  const el = document.createElement('div') as unknown as FakeWebview
  el.js = []
  el.reloads = 0
  el.answer = () => ({ ok: true, text: 'ok' })
  el.getURL = () => url
  el.getTitle = () => title
  el.isLoading = () => false
  el.reload = () => {
    el.reloads += 1
  }
  el.executeJavaScript = async (code: string) => {
    el.js.push(code)
    return el.answer(code)
  }
  return el
}

/** Where the store was told to aim the pane, in order. */
let navigated: string[]

beforeEach(() => {
  setPreviewWebview(null)
  previewApi.respondInspect.mockClear()
  navigated = []
  useAppStore.setState({
    previewUrl: null,
    showLocalPreviewUrl: (url: string) => {
      navigated.push(url)
    }
  })
})

describe('preview_inspect eval (the escape hatch)', () => {
  it('runs the expression in the guest and reports the value it produced', async () => {
    const el = fakeWebview()
    el.answer = () => ({ ok: true, text: 'My App' })
    setPreviewWebview(el)

    const reply = await ask({ action: 'eval', expression: 'document.title' })
    expect(reply.ok).toBe(true)
    expect(reply.output).toBe('My App')
    expect(reply.summary).toBe('My App')
    // The model's code is what ran, inside the formatting wrapper.
    expect(el.js).toHaveLength(1)
    expect(el.js[0]).toContain('document.title')
  })

  it('reports an expression that threw as a failure, not as a value', async () => {
    const el = fakeWebview()
    el.answer = () => ({ ok: false, text: "TypeError: Cannot read properties of null\n  at <anonymous>" })
    setPreviewWebview(el)

    const reply = await ask({ action: 'eval', expression: 'document.querySelector("#x").value' })
    expect(reply.ok).toBe(false)
    expect(reply.summary).toBe('threw')
    expect(reply.output).toContain('TypeError')
    // The first line is the error, so the card says what broke without expanding.
    expect(reply.error).toBe('TypeError: Cannot read properties of null')
  })

  it('retries a statement body as a function when the expression wrapper cannot parse it', async () => {
    // `const x = …; return x` is only a *syntax* error in the expression wrapper,
    // which is the tool's problem to solve rather than the model's mistake.
    const el = fakeWebview()
    el.answer = (code) => {
      if (!code.includes('async function () {\nconst rows')) {
        throw new Error('SyntaxError: Unexpected token const')
      }
      return { ok: true, text: '3' }
    }
    setPreviewWebview(el)

    const reply = await ask({
      action: 'eval',
      expression: 'const rows = document.querySelectorAll("li"); return rows.length'
    })
    expect(reply.ok).toBe(true)
    expect(reply.output).toBe('3')
    expect(el.js).toHaveLength(2)
  })

  it('says the pane is empty rather than evaluating against nothing', async () => {
    const reply = await ask({ action: 'eval', expression: 'document.title' })
    expect(reply.ok).toBe(false)
    expect(reply.output).toMatch(/no page loaded/i)
  })
})

describe('preview_inspect navigate (walking the app, loopback only)', () => {
  /**
   * Aiming the pane goes through the store, and the panel answers by remounting the
   * guest (`key={url}`) — so the store stand-in swaps the element the way the real
   * panel does, which is the swap the inspector waits for.
   */
  function remountOnNavigate(title = 'About'): void {
    useAppStore.setState({
      showLocalPreviewUrl: (url: string) => {
        navigated.push(url)
        setPreviewWebview(fakeWebview(url, title))
      }
    })
  }

  it('sends the pane to another local page and reports where it landed', async () => {
    setPreviewWebview(fakeWebview())
    useAppStore.setState({ previewUrl: 'http://localhost:5173/' })
    remountOnNavigate()

    const reply = await ask({ action: 'navigate', url: 'http://localhost:5173/about' })
    expect(navigated).toEqual(['http://localhost:5173/about'])
    expect(reply.ok).toBe(true)
    expect(reply.output).toContain('Navigated to http://localhost:5173/about.')
    expect(reply.output).toContain('title: About')
    expect(reply.summary).toBe('About')
  })

  it('resolves a bare path against the page already loaded', async () => {
    // What a model naturally writes when walking the routes of the app it built.
    setPreviewWebview(fakeWebview('http://localhost:5173/dashboard'))
    useAppStore.setState({ previewUrl: 'http://localhost:5173/dashboard' })
    remountOnNavigate()

    await ask({ action: 'navigate', url: '/settings' })
    expect(navigated).toEqual(['http://localhost:5173/settings'])
  })

  it('refuses the open web by name, and never asks the store to load it', async () => {
    setPreviewWebview(fakeWebview())
    remountOnNavigate()

    const reply = await ask({ action: 'navigate', url: 'https://example.com/login' })
    expect(reply.ok).toBe(false)
    expect(reply.summary).toBe('refused')
    // Named, not silently dropped — and it points at the tool that can do it.
    expect(reply.output).toContain('example.com')
    expect(reply.output).toMatch(/browse tool/)
    expect(navigated).toEqual([])
  })

  it('refuses an address that is not a page at all', async () => {
    setPreviewWebview(fakeWebview())
    remountOnNavigate()

    const reply = await ask({ action: 'navigate', url: 'file:///C:/Windows/win.ini' })
    expect(reply.ok).toBe(false)
    expect(reply.output).toMatch(/only loads http/i)
    expect(navigated).toEqual([])
  })

  it('rewrites a bind address the guest cannot load to loopback', async () => {
    setPreviewWebview(fakeWebview())
    remountOnNavigate()

    await ask({ action: 'navigate', url: 'http://0.0.0.0:8000/' })
    expect(navigated).toEqual(['http://127.0.0.1:8000/'])
  })

  it('reloads in place when no url is given (the refresh after a rebuild)', async () => {
    const el = fakeWebview()
    setPreviewWebview(el)
    remountOnNavigate()

    const reply = await ask({ action: 'navigate' })
    expect(el.reloads).toBe(1)
    expect(navigated).toEqual([])
    expect(reply.ok).toBe(true)
    expect(reply.summary).toBe('reloaded')
    expect(reply.output).toContain('http://localhost:5173/')
  })

  it('treats asking for the page already loaded as a refresh', async () => {
    // Aiming the store at an unchanged URL would remount nothing to wait for.
    const el = fakeWebview()
    setPreviewWebview(el)
    useAppStore.setState({ previewUrl: 'http://localhost:5173/' })
    remountOnNavigate()

    const reply = await ask({ action: 'navigate', url: 'http://localhost:5173/' })
    expect(el.reloads).toBe(1)
    expect(navigated).toEqual([])
    expect(reply.summary).toBe('reloaded')
  })

  it('still aims the pane when nothing is loaded yet', async () => {
    // navigate is exactly what you do when the pane is empty, so the
    // "no page loaded" guard must not reach it.
    remountOnNavigate('Home')

    const reply = await ask({ action: 'navigate', url: 'http://localhost:5173/' })
    expect(navigated).toEqual(['http://localhost:5173/'])
    expect(reply.ok).toBe(true)
    expect(reply.summary).toBe('Home')
  })

  it('says to start the preview when asked to reload nothing', async () => {
    const reply = await ask({ action: 'navigate' })
    expect(reply.ok).toBe(false)
    expect(reply.output).toMatch(/start the preview first/i)
  })
})
