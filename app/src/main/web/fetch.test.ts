import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUrl } from '@main/web/fetch'

/**
 * fetchUrl is the network egress path, so the tests pin two things: the safety
 * gates fire BEFORE any request leaves (bad scheme, internal host), and a real
 * response is reduced to bounded, readable text. `fetch` is stubbed so nothing
 * actually hits the wire.
 */

/** Builds a minimal Response-like object; a null body takes the `.text()` path. */
function mockResponse(opts: {
  ok?: boolean
  status?: number
  statusText?: string
  contentType?: string
  body?: string
}): Response {
  const { ok = true, status = 200, statusText = 'OK', contentType = 'text/html', body = '' } = opts
  return {
    ok,
    status,
    statusText,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    body: null,
    text: async () => body
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchUrl — safety gates (no request leaves)', () => {
  it('rejects a non-URL without calling fetch', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const out = await fetchUrl('not a url')
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/valid URL/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses non-http(s) schemes', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    for (const url of ['file:///etc/passwd', 'ftp://host/x', 'data:text/html,x']) {
      const out = await fetchUrl(url)
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/http\/https/i)
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('blocks internal / loopback / private hosts (SSRF guard)', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const blocked = [
      'http://localhost/x',
      'http://app.localhost/x',
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://169.254.1.1/x',
      'http://172.16.0.1/x',
      'http://[::1]/x'
    ]
    for (const url of blocked) {
      const out = await fetchUrl(url)
      expect(out.ok, url).toBe(false)
      expect(out.error, url).toMatch(/internal|loopback/i)
    }
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('fetchUrl — response handling', () => {
  it('reduces HTML to readable text, extracts the title, and drops script/style', async () => {
    const html =
      '<html><head><title>Hello &amp; Bye</title><style>.x{color:red}</style></head>' +
      '<body><script>evil()</script><h1>Heading</h1><p>First&nbsp;line.</p><p>Second.</p></body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ body: html, contentType: 'text/html' })))
    const out = await fetchUrl('https://example.com/page')
    expect(out.ok).toBe(true)
    expect(out.output).toContain('Title: Hello & Bye')
    expect(out.output).toContain('URL: https://example.com/page')
    expect(out.output).toContain('Heading')
    expect(out.output).toContain('First line.')
    expect(out.output).toContain('Second.')
    expect(out.output).not.toMatch(/evil\(\)/)
    expect(out.output).not.toMatch(/color:red/)
    expect(out.output).not.toMatch(/</) // all tags gone
  })

  it('passes plain text through untouched (no title header)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse({ body: 'raw text body', contentType: 'text/plain' }))
    )
    const out = await fetchUrl('https://example.com/robots.txt')
    expect(out.ok).toBe(true)
    expect(out.output).toContain('raw text body')
    expect(out.output).not.toContain('Title:')
  })

  it('surfaces a non-2xx status as a readable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse({ ok: false, status: 404, statusText: 'Not Found' }))
    )
    const out = await fetchUrl('https://example.com/missing')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('HTTP 404 Not Found')
  })

  it('reports a timeout in words the model can act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted')
        e.name = 'TimeoutError'
        throw e
      })
    )
    const out = await fetchUrl('https://example.com/slow')
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/timed out/i)
  })

  it('never throws on a network error — returns a failed outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const out = await fetchUrl('https://example.com/down')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('ECONNREFUSED')
  })
})
