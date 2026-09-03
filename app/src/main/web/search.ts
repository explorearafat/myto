/**
 * Native web search — the `web_search` tool's implementation.
 *
 * The sibling of `web_fetch` (see ./fetch.ts): where fetch reads ONE known URL,
 * search turns a natural-language query into a ranked list of {title, url,
 * snippet} results the agent can then fetch. Same posture — Sylor is
 * offline-first, so this is the deliberate, opt-in, permission-gated exception
 * that lets the agent DISCOVER current, real sources instead of guessing URLs
 * from memory (the analogue of Claude Code's WebSearch).
 *
 * It queries DuckDuckGo's no-JavaScript HTML endpoint (no API key, privacy
 * respecting) and parses the result list out of the returned markup. Like
 * {@link import('./fetch').fetchUrl} it never throws: a network error, a
 * timeout, or unparseable markup all come back as a bounded {@link FetchOutcome}
 * written for the model to read. The request targets a single fixed host, so
 * there is no per-URL SSRF surface to guard here (unlike web_fetch).
 */
import type { FetchOutcome } from './fetch'

/** DuckDuckGo's no-JavaScript HTML results endpoint (no API key required). */
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
/** Most results parsed out of one page — plenty for the model to choose from. */
const MAX_RESULTS = 10
/** Longest text handed back to the model (result lists are compact). */
const MAX_OUTPUT_CHARS = 8_000
/** Hard cap on bytes read off the wire before we stop and parse. */
const MAX_FETCH_BYTES = 2_000_000
/** Request timeout in milliseconds. */
const SEARCH_TIMEOUT_MS = 15_000
/**
 * A desktop-Chrome User-Agent: the no-JS endpoint serves plain, parseable
 * results to a normal browser identity (a bare bot UA is more likely to be
 * rate-limited or served a challenge page).
 */
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** One parsed search result. */
interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** Decodes the handful of HTML entities that matter for readability. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
}

/** Strips tags, decodes entities, and collapses whitespace in a fragment of HTML. */
function toText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolves a DuckDuckGo result href to the real destination URL. DDG wraps most
 * links as `//duckduckgo.com/l/?uddg=<encoded-target>`; a few are already direct
 * `http(s)` links. Returns null when nothing usable can be recovered.
 */
function resolveHref(href: string): string | null {
  let h = href.trim()
  if (!h) return null
  const uddg = /[?&]uddg=([^&]+)/.exec(h)
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1])
    } catch {
      return null
    }
  }
  if (h.startsWith('//')) h = `https:${h}`
  return /^https?:\/\//i.test(h) ? h : null
}

/**
 * Parses DuckDuckGo HTML into an ordered list of result hits. The endpoint emits
 * one `result__a` anchor (title + link) and one `result__snippet` per result, in
 * rank order, so the two lists are zipped by index — a result missing a snippet
 * still surfaces (empty snippet) rather than dropping out.
 */
function parseResults(html: string): SearchHit[] {
  const snippetRe =
    /<(?:a|div)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi
  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(toText(m[1] ?? ''))
  }

  const anchorRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const hits: SearchHit[] = []
  let index = 0
  for (let m = anchorRe.exec(html); m !== null && hits.length < MAX_RESULTS; m = anchorRe.exec(html)) {
    const url = resolveHref(m[1])
    const title = toText(m[2])
    if (url && title) hits.push({ title, url, snippet: snippets[index] ?? '' })
    index++
  }
  return hits
}

/** Renders the hits as a compact, model-readable list, clipped to the char cap. */
function render(query: string, hits: SearchHit[]): { output: string; truncated: boolean } {
  const header = `Search results for "${query}":\n\n`
  const body = hits
    .map((h, n) => `${n + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
    .join('\n\n')
  const full = header + body
  if (full.length <= MAX_OUTPUT_CHARS) return { output: full, truncated: false }
  return { output: `${full.slice(0, MAX_OUTPUT_CHARS)}\n… (results clipped)`, truncated: true }
}

/**
 * Searches the web for `query` and returns a bounded, ranked list of results.
 * Never throws — a network error, a timeout, or a blocked/empty response all come
 * back as a {@link FetchOutcome} (a failed one, or a successful "(no results
 * found)"). `signal` lets the engine abort the search when the run is cancelled.
 */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<FetchOutcome> {
  const q = query.trim()
  if (!q) return { ok: false, output: '', truncated: false, error: 'Empty search query.' }

  // Own timeout, linked to the run's abort signal so cancelling the turn aborts here too.
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout
  const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`

  try {
    const res = await fetch(url, {
      signal: composite,
      redirect: 'follow',
      headers: { accept: 'text/html', 'user-agent': SEARCH_UA }
    })
    if (!res.ok) {
      return { ok: false, output: '', truncated: false, error: `HTTP ${res.status} ${res.statusText}` }
    }

    // Read up to the byte cap without buffering an unbounded body.
    const reader = res.body?.getReader()
    let raw = ''
    let bytes = 0
    if (reader) {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        raw += decoder.decode(value, { stream: true })
        if (bytes >= MAX_FETCH_BYTES) {
          await reader.cancel()
          break
        }
      }
      raw += decoder.decode()
    } else {
      raw = await res.text()
    }

    const hits = parseResults(raw)
    if (hits.length === 0) {
      // A reachable endpoint that yielded nothing parseable is a *successful* empty
      // search, not an error — the model can refine the query or fetch a URL instead.
      return { ok: true, output: `Search results for "${q}":\n\n(no results found)`, truncated: false }
    }
    const { output, truncated } = render(q, hits)
    return { ok: true, output, truncated }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s.`
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, output: '', truncated: false, error: message }
  }
}
