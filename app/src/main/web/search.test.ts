import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchWeb } from '@main/web/search'

/**
 * searchWeb is a network egress path, so the tests pin two things: a real
 * DuckDuckGo HTML page is reduced to a bounded, ranked, readable list (with the
 * DDG redirect hrefs decoded to real URLs), and every failure mode — empty
 * query, non-2xx, timeout, network error — comes back as an outcome rather than
 * a throw. `fetch` is stubbed so nothing actually hits the wire.
 */

/** Builds a minimal Response-like object; a null body takes the `.text()` path. */
function mockResponse(opts: {
  ok?: boolean
  status?: number
  statusText?: string
  body?: string
}): Response {
  const { ok = true, status = 200, statusText = 'OK', body = '' } = opts
  return {
    ok,
    status,
    statusText,
    headers: { get: () => 'text/html' },
    body: null,
    text: async () => body
  } as unknown as Response
}

/** One DuckDuckGo HTML result block (redirect-wrapped href, like the real page). */
function ddgResult(target: string, title: string, snippet: string): string {
  const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=deadbeef`
  return (
    `<div class="result results_links results_links_deep web-result">` +
    `<div class="links_main">` +
    `<a rel="nofollow" class="result__a" href="${href}">${title}</a>` +
    `<a class="result__snippet" href="${href}">${snippet}</a>` +
    `</div></div>`
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchWeb — query handling', () => {
  it('rejects an empty query without calling fetch', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const out = await searchWeb('   ')
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/empty/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('sends the query to the DuckDuckGo HTML endpoint, url-encoded', async () => {
    const spy = vi.fn().mockResolvedValue(mockResponse({ body: '' }))
    vi.stubGlobal('fetch', spy)
    await searchWeb('vite base path')
    expect(spy).toHaveBeenCalledTimes(1)
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('html.duckduckgo.com/html/')
    expect(url).toContain('q=vite%20base%20path')
  })
})

describe('searchWeb — result parsing', () => {
  it('parses ranked results, decoding the DDG redirect to the real URL', async () => {
    const html =
      '<html><body>' +
      ddgResult('https://react.dev/', 'React Docs', 'The library for web and native UIs.') +
      ddgResult('https://vitejs.dev/guide/', 'Vite Guide', 'Next generation frontend tooling.') +
      '</body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ body: html })))
    const out = await searchWeb('react')
    expect(out.ok).toBe(true)
    expect(out.output).toContain('1. React Docs')
    expect(out.output).toContain('https://react.dev/')
    expect(out.output).toContain('The library for web and native UIs.')
    expect(out.output).toContain('2. Vite Guide')
    expect(out.output).toContain('https://vitejs.dev/guide/')
    // The DDG wrapper host must never leak through as the result URL.
    expect(out.output).not.toContain('duckduckgo.com/l/')
  })

  it('treats a page with no parseable results as a successful empty search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ body: '<html><body>nope</body></html>' })))
    const out = await searchWeb('asldkfjqwoeiruzzz')
    expect(out.ok).toBe(true)
    expect(out.output).toMatch(/no results/i)
  })
})

describe('searchWeb — failure modes (never throws)', () => {
  it('surfaces a non-2xx status as a readable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse({ ok: false, status: 429, statusText: 'Too Many Requests' }))
    )
    const out = await searchWeb('rate limited')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('HTTP 429 Too Many Requests')
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
    const out = await searchWeb('slow')
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/timed out/i)
  })

  it('never throws on a network error — returns a failed outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND')
      })
    )
    const out = await searchWeb('offline')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('ENOTFOUND')
  })
})
