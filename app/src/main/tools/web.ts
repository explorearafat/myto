import { httpFetch, httpJson } from '../providers/http'
import type { ToolDef } from './registry'

/**
 * The three read-only web tools: {@link webFetchTool}, {@link webSearchTool}, and
 * {@link wikiSearchTool}. Each returns a compact plain-text result the model reads
 * back on its next turn — no API keys, no native function-calling (see
 * ./toolParser.ts for how a call is pulled out of the stream).
 *
 * The HTML→text and result-formatting helpers are pure and exported so the tests
 * can exercise the tricky parsing without hitting the network; the tools
 * themselves only add the fetch + input-validation shell around them.
 */

/** Identifies the client to endpoints (Wikipedia asks for a descriptive UA). */
const UA = 'MytoChat/0.2 (+https://sylorcode.vercel.app)'

/**
 * A real-browser User-Agent for web search. DuckDuckGo's HTML endpoints serve a
 * stripped/challenge page (no results) when the request looks like a bot — which
 * is exactly why the old bare-GET scraper came back empty. A browser UA on a POST
 * gets the normal results page. See {@link webSearchTool}.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

/** Largest readable-text payload handed back to the model, in characters. */
const FETCH_CAP = 8000

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…'
}

/** Decode the handful of HTML entities that survive tag-stripping in real pages. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m)
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/** Strip tags + entities from a small HTML fragment (titles, snippets). */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * Reduce a full HTML document to readable text: drop scripts/styles/comments,
 * turn block boundaries into newlines so paragraphs survive, strip the remaining
 * tags, decode entities, collapse runs of whitespace, and cap the length.
 */
export function htmlToText(html: string, cap = FETCH_CAP): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // Preserve structure: close-tags of block elements and <br> become newlines.
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[^\S\n]+/g, ' ') // collapse spaces/tabs but keep newlines
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()
  if (s.length > cap) s = s.slice(0, cap).trimEnd() + '\n…[truncated]'
  return s
}

/** One web-search hit. */
export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Pull the real destination out of a DuckDuckGo redirect href. */
function decodeDdgHref(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return href
    }
  }
  return href.startsWith('//') ? `https:${href}` : href
}

/**
 * Scrape the top results out of the DuckDuckGo HTML endpoint. Titles/links and
 * snippets are captured separately (each result carries one of each, in order)
 * and zipped by index — resilient to markup drift between the two. Attribute
 * quotes may be single or double, so the regexes are quote-agnostic.
 */
export function parseDuckDuckGo(html: string, limit = 6): SearchResult[] {
  const anchorRe = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi

  const snippets: string[] = []
  let m: RegExpExecArray | null
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]))

  const results: SearchResult[] = []
  let i = 0
  while ((m = anchorRe.exec(html)) && results.length < limit) {
    const title = stripTags(m[2])
    if (title) results.push({ title, url: decodeDdgHref(m[1]), snippet: snippets[i] ?? '' })
    i++
  }
  return results
}

/**
 * Parse the DuckDuckGo Lite page (`lite.duckduckgo.com/lite/`) — a plain table
 * layout used as a last-resort fallback when the main HTML endpoint returns
 * nothing. Result links carry `class="result-link"` with href BEFORE the class,
 * so the regex matches that attribute order (unlike the html endpoint's
 * class-then-href) and is quote-agnostic.
 */
export function parseDuckDuckGoLite(html: string, limit = 6): SearchResult[] {
  const linkRe = /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi

  const snippets: string[] = []
  let m: RegExpExecArray | null
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]))

  const results: SearchResult[] = []
  let i = 0
  while ((m = linkRe.exec(html)) && results.length < limit) {
    const title = stripTags(m[2])
    if (title) results.push({ title, url: decodeDdgHref(m[1]), snippet: snippets[i] ?? '' })
    i++
  }
  return results
}

/** Format search hits as a numbered plain-text list for the model. */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (!results.length) return `No web results for "${query}".`
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n')
}

interface WikiSearchResp {
  query?: { search?: Array<{ title: string; snippet: string }> }
}
interface WikiExtractResp {
  query?: { pages?: Record<string, { title: string; extract?: string }> }
}

/** Format Wikipedia hits + the lead paragraph of the best match. */
export function formatWiki(
  query: string,
  hits: Array<{ title: string; snippet: string }>,
  intro: string
): string {
  const list = hits.map((h, i) => `${i + 1}. ${h.title} — ${stripTags(h.snippet)}`).join('\n')
  const lead = intro ? `\n\n${hits[0].title}:\n${intro.slice(0, 4000)}` : ''
  return `Wikipedia results for "${query}":\n${list}${lead}`
}

/** Read a validated http/https URL out of a tool `input`, or null. */
function readUrl(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).url : undefined
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Read a non-empty `query` string out of a tool `input`, or null. */
function readQuery(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).query : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  description: 'Fetch a web page and return its readable text.',
  usage: '{"url": "https://example.com/article"}',
  available: () => true,
  async run(input, ctx) {
    const url = readUrl(input)
    if (!url) return 'web_fetch needs a JSON input like {"url": "https://…"} with an http/https URL.'
    const res = await httpFetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain' },
      timeoutMs: 20_000,
      signal: ctx.signal
    })
    if (!res.ok) return `Fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`
    const contentType = res.headers.get('content-type') ?? ''
    const body = await res.text()
    const text = /html|xml/i.test(contentType) ? htmlToText(body) : body.slice(0, FETCH_CAP)
    return text.trim() || '(the page had no readable text)'
  }
}

/**
 * Fetch a search endpoint with browser-like headers. When `form` is given it's a
 * POST with a url-encoded body (DuckDuckGo's `/html/` endpoint is far more reliable
 * via POST `q=…` than a GET query string); otherwise a plain GET. The browser UA
 * is what gets the normal results page instead of a bot challenge.
 */
async function fetchSearch(
  url: string,
  form: Record<string, string> | null,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': BROWSER_UA,
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9'
  }
  if (!form) return httpFetch(url, { headers, timeoutMs: 20_000, signal })
  return httpFetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 20_000,
    signal
  })
}

export const webSearchTool: ToolDef = {
  name: 'web_search',
  description: 'Search the web and return the top results (titles, links, snippets).',
  usage: '{"query": "your search terms"}',
  available: () => true,
  async run(input, ctx) {
    const query = readQuery(input)
    if (!query) return 'web_search needs a JSON input like {"query": "…"}.'

    // DuckDuckGo's HTML endpoint is picky: a bare GET with a non-browser UA often
    // returns an empty/challenge page — which is why search "ran" but came back with
    // nothing. Try three resilient strategies in order and use the first that yields
    // results:
    //   1. POST form to html.duckduckgo.com/html/ (most reliable).
    //   2. GET the same endpoint (some networks/edges prefer it).
    //   3. GET the Lite endpoint, which has its own simpler layout.
    const attempts: Array<() => Promise<SearchResult[]>> = [
      async () => {
        const r = await fetchSearch('https://html.duckduckgo.com/html/', { q: query }, ctx.signal)
        return r.ok ? parseDuckDuckGo(await r.text()) : []
      },
      async () => {
        const r = await fetchSearch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          null,
          ctx.signal
        )
        return r.ok ? parseDuckDuckGo(await r.text()) : []
      },
      async () => {
        const r = await fetchSearch('https://lite.duckduckgo.com/lite/', { q: query }, ctx.signal)
        return r.ok ? parseDuckDuckGoLite(await r.text()) : []
      }
    ]

    for (const attempt of attempts) {
      if (ctx.signal.aborted) return 'web_search was cancelled.'
      let results: SearchResult[] = []
      try {
        results = await attempt()
      } catch {
        // A single endpoint hiccup shouldn't fail the whole search — try the next.
        continue
      }
      if (results.length) return formatSearchResults(query, results)
    }
    return `No web results for "${query}" (the search endpoint returned nothing). Try rephrasing the query, or use wiki_search for an encyclopedic answer.`
  }
}

export const wikiSearchTool: ToolDef = {
  name: 'wiki_search',
  description: 'Search Wikipedia and return the top matches with the lead paragraph of the best one.',
  usage: '{"query": "Ada Lovelace"}',
  available: () => true,
  async run(input, ctx) {
    const query = readQuery(input)
    if (!query) return 'wiki_search needs a JSON input like {"query": "…"}.'
    const base = 'https://en.wikipedia.org/w/api.php'
    const searchUrl = `${base}?action=query&format=json&list=search&srlimit=5&srsearch=${encodeURIComponent(query)}`
    const data = await httpJson<WikiSearchResp>(searchUrl, {
      headers: { 'user-agent': UA },
      timeoutMs: 20_000,
      signal: ctx.signal
    })
    const hits = data.query?.search ?? []
    if (!hits.length) return `No Wikipedia results for "${query}".`

    // The lead paragraph of the best match is the useful bit; the list is a
    // fallback if the extract call fails, so its error must not sink the tool.
    let intro = ''
    try {
      const extractUrl = `${base}?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(hits[0].title)}`
      const ex = await httpJson<WikiExtractResp>(extractUrl, {
        headers: { 'user-agent': UA },
        timeoutMs: 20_000,
        signal: ctx.signal
      })
      const first = Object.values(ex.query?.pages ?? {})[0]
      intro = first?.extract?.trim() ?? ''
    } catch {
      // Keep the search list; the intro is best-effort.
    }
    return formatWiki(query, hits, intro)
  }
}
