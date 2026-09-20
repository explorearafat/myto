import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the HTTP layer so the tools never touch the network. Declared with
// vi.hoisted so the mock functions exist before the vi.mock factory runs.
const { httpFetch, httpJson } = vi.hoisted(() => ({
  httpFetch: vi.fn(),
  httpJson: vi.fn()
}))
vi.mock('../providers/http', () => ({ httpFetch, httpJson }))

import {
  decodeEntities,
  htmlToText,
  parseDuckDuckGo,
  formatSearchResults,
  formatWiki,
  webFetchTool,
  webSearchTool,
  wikiSearchTool
} from './web'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'

const ctx = {
  signal: new AbortController().signal,
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'chat' as const,
  workspaceDir: null
}

/** Build a minimal Response-like object for httpFetch to resolve with. */
function fakeResponse(body: string, init?: { ok?: boolean; status?: number; contentType?: string }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.status === 404 ? 'Not Found' : 'OK',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? (init?.contentType ?? 'text/html') : null) },
    text: async () => body
  } as unknown as Response
}

beforeEach(() => {
  httpFetch.mockReset()
  httpJson.mockReset()
})

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;q&#39; &#x2764;')).toBe("a & b <c> 'q' ❤")
  })
  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&unknownthing;')).toBe('&unknownthing;')
  })
})

describe('htmlToText', () => {
  it('drops scripts and styles and keeps readable text', () => {
    const html = '<html><head><style>.x{color:red}</style></head><body><h1>Hi</h1><script>evil()</script><p>Body text.</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Hi')
    expect(text).toContain('Body text.')
    expect(text).not.toContain('evil')
    expect(text).not.toContain('color:red')
  })
  it('turns block boundaries into newlines', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo')
  })
  it('caps very long output', () => {
    const text = htmlToText('<p>' + 'a'.repeat(20000) + '</p>', 100)
    expect(text.length).toBeLessThan(200)
    expect(text).toContain('…[truncated]')
  })
})

describe('parseDuckDuckGo', () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First <b>Title</b></a>
      <a class="result__snippet" href="#">First snippet text.</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Second Title</a>
      <a class="result__snippet" href="#">Second snippet.</a>
    </div>`
  it('extracts titles, decoded urls, and snippets', () => {
    const r = parseDuckDuckGo(html)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({ title: 'First Title', url: 'https://example.com/a', snippet: 'First snippet text.' })
    expect(r[1].url).toBe('https://example.com/b')
  })
  it('respects the limit', () => {
    expect(parseDuckDuckGo(html, 1)).toHaveLength(1)
  })
})

describe('formatSearchResults', () => {
  it('reports no results', () => {
    expect(formatSearchResults('q', [])).toContain('No web results')
  })
  it('numbers the results', () => {
    const out = formatSearchResults('q', [{ title: 'T', url: 'https://u', snippet: 'S' }])
    expect(out).toContain('1. T')
    expect(out).toContain('https://u')
    expect(out).toContain('S')
  })
})

describe('formatWiki', () => {
  it('lists hits and appends the intro of the top one', () => {
    const out = formatWiki('Ada', [{ title: 'Ada Lovelace', snippet: 'was a <b>mathematician</b>' }], 'She was a writer.')
    expect(out).toContain('1. Ada Lovelace')
    expect(out).toContain('mathematician')
    expect(out).toContain('She was a writer.')
  })
})

describe('webFetchTool', () => {
  it('rejects a non-url input without fetching', async () => {
    expect(await webFetchTool.run({ q: 'nope' }, ctx)).toMatch(/needs a JSON input/)
    expect(httpFetch).not.toHaveBeenCalled()
  })
  it('rejects a non-http protocol', async () => {
    expect(await webFetchTool.run({ url: 'file:///etc/passwd' }, ctx)).toMatch(/needs a JSON input/)
    expect(httpFetch).not.toHaveBeenCalled()
  })
  it('returns readable text on success', async () => {
    httpFetch.mockResolvedValue(fakeResponse('<h1>Title</h1><p>Hello.</p>'))
    const out = await webFetchTool.run({ url: 'https://example.com' }, ctx)
    expect(out).toContain('Title')
    expect(out).toContain('Hello.')
  })
  it('reports an HTTP error', async () => {
    httpFetch.mockResolvedValue(fakeResponse('nope', { ok: false, status: 404 }))
    expect(await webFetchTool.run({ url: 'https://example.com' }, ctx)).toMatch(/HTTP 404/)
  })
})

describe('webSearchTool', () => {
  it('needs a query', async () => {
    expect(await webSearchTool.run({}, ctx)).toMatch(/needs a JSON input/)
  })
  it('formats parsed results', async () => {
    httpFetch.mockResolvedValue(
      fakeResponse('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.dev">X</a>')
    )
    const out = await webSearchTool.run({ query: 'x' }, ctx)
    expect(out).toContain('1. X')
    expect(out).toContain('https://x.dev')
  })
})

describe('wikiSearchTool', () => {
  it('needs a query', async () => {
    expect(await wikiSearchTool.run({}, ctx)).toMatch(/needs a JSON input/)
  })
  it('combines search hits with the top intro', async () => {
    httpJson
      .mockResolvedValueOnce({ query: { search: [{ title: 'Ada Lovelace', snippet: 'pioneer' }] } })
      .mockResolvedValueOnce({ query: { pages: { '1': { title: 'Ada Lovelace', extract: 'Lead paragraph.' } } } })
    const out = await wikiSearchTool.run({ query: 'Ada' }, ctx)
    expect(out).toContain('Ada Lovelace')
    expect(out).toContain('Lead paragraph.')
  })
  it('still returns the list when the intro fetch fails', async () => {
    httpJson
      .mockResolvedValueOnce({ query: { search: [{ title: 'Ada Lovelace', snippet: 'pioneer' }] } })
      .mockRejectedValueOnce(new Error('boom'))
    const out = await wikiSearchTool.run({ query: 'Ada' }, ctx)
    expect(out).toContain('Ada Lovelace')
    expect(out).not.toContain('Lead paragraph.')
  })
  it('reports no results', async () => {
    httpJson.mockResolvedValueOnce({ query: { search: [] } })
    expect(await wikiSearchTool.run({ query: 'zzz' }, ctx)).toMatch(/No Wikipedia results/)
  })
})
