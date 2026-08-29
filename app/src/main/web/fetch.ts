/**
 * Native web fetch — the `web_fetch` tool's implementation.
 *
 * Sylor is offline-first: the app never needs the network to run. This tool is
 * the deliberate, opt-in exception — the analogue of Claude Code's WebFetch — so
 * the agent can read a doc page, an error explanation, or an API reference when a
 * task genuinely needs the outside world. Because it reaches the network, it is
 * permission-gated in the engine (never auto-approved except in the explicit
 * hands-free `autonomous` mode) and requires the `web` capability for a scoped
 * subagent — the lead is unrestricted.
 *
 * Safety posture:
 *  - Only `http:`/`https:` URLs; anything else (file:, data:, ftp:, …) is refused.
 *  - Obvious internal targets — loopback, link-local, and RFC-1918 private ranges,
 *    plus bare `localhost` — are blocked to blunt SSRF, since the URL is often
 *    chosen by the model from untrusted page/tool content. This is a literal-host
 *    check (no DNS resolution), so it is a guard, not a guarantee.
 *  - Hard timeout and byte cap so a slow or huge response can't hang or flood the
 *    turn; HTML is reduced to readable text and the result is clipped to a
 *    context-safe size.
 */

/** Longest text handed back to the model (≈4k tokens). */
const MAX_OUTPUT_CHARS = 16_000
/** Hard cap on bytes read off the wire before we stop and convert. */
const MAX_FETCH_BYTES = 2_000_000
/** Request timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000

/** The bounded outcome of a fetch, shaped like the other tool results. */
export interface FetchOutcome {
  ok: boolean
  output: string
  truncated: boolean
  error?: string
}

/** Whether a hostname points at a loopback / link-local / private address. */
function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true
  // IPv4 loopback / private / link-local ranges.
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  return false
}

/** Extracts a `<title>` for a short context header, if present. */
function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return null
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  return title || null
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

/**
 * Reduces an HTML document to readable plain text: drops script/style/noscript
 * bodies, strips tags, decodes entities, and collapses runs of blank lines. Not a
 * full renderer — just enough to feed the model the words on the page instead of
 * markup.
 */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Turn block boundaries into newlines so structure survives tag removal.
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Clips text to {@link MAX_OUTPUT_CHARS}, reporting whether it had to. */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (content clipped)`, truncated: true }
}

/**
 * Fetches `rawUrl` and returns its readable text, bounded and safe. Never throws
 * — a bad URL, a blocked host, a network error, or a timeout all come back as a
 * failed {@link FetchOutcome} with a message written for the model to read and
 * correct. `signal` lets the engine abort the fetch when the run is cancelled.
 */
export async function fetchUrl(rawUrl: string, signal?: AbortSignal): Promise<FetchOutcome> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, output: '', truncated: false, error: `Not a valid URL: ${rawUrl}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      output: '',
      truncated: false,
      error: `Only http/https URLs are allowed (got ${url.protocol}).`
    }
  }
  if (isInternalHost(url.hostname)) {
    return {
      ok: false,
      output: '',
      truncated: false,
      error: `Refusing to fetch an internal/loopback address (${url.hostname}).`
    }
  }

  // Own timeout, linked to the run's abort signal so cancelling the turn aborts here too.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout

  try {
    const res = await fetch(url, {
      signal: composite,
      redirect: 'follow',
      headers: { accept: 'text/html,text/plain,application/json,*/*', 'user-agent': 'Sylor/1.0' }
    })
    if (!res.ok) {
      return { ok: false, output: '', truncated: false, error: `HTTP ${res.status} ${res.statusText}` }
    }

    // Read up to the byte cap without buffering an unbounded body.
    const reader = res.body?.getReader()
    let raw = ''
    let bytes = 0
    let overCap = false
    if (reader) {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        raw += decoder.decode(value, { stream: true })
        if (bytes >= MAX_FETCH_BYTES) {
          overCap = true
          await reader.cancel()
          break
        }
      }
      raw += decoder.decode()
    } else {
      raw = await res.text()
    }

    const contentType = res.headers.get('content-type') ?? ''
    const isHtml = /html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(raw)
    const title = isHtml ? extractTitle(raw) : null
    const text = isHtml ? htmlToText(raw) : raw.trim()
    const header = `URL: ${url.href}${title ? `\nTitle: ${title}` : ''}\n\n`
    const { text: clipped, truncated } = clip(text || '(empty response)')
    return { ok: true, output: header + clipped, truncated: truncated || overCap }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, output: '', truncated: false, error: message }
  }
}
