// Link preview for Discover posts: fetch a public URL server-side and extract the
// Open Graph metadata (title, preview image, site name) so a text post that attaches
// a link can render the site's preview card. Runs as a Vercel Edge function
// (api/link-preview.ts) — the same trust posture as the chat gateway: same-origin
// guard for browsers, SSRF guard against private/loopback/metadata hosts, credentials
// never involved. The response is plain public metadata.
//
// The parser is pure and unit-tested; the handler is a thin fetch around it.

import { decodeEntities, isBlockedHost } from './tools';

export interface LinkMeta {
  title: string;
  image: string;
  site: string;
}

const FETCH_TIMEOUT_MS = 8000;
/** Cap the fetched HTML so a huge page can't blow the edge function's memory. */
const MAX_HTML_BYTES = 400_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Resolve `candidate` (possibly relative) against the page URL; '' when unusable. */
export function absoluteUrl(base: string, candidate: string): string {
  const raw = candidate.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** First match of any of the regexes, else ''. */
function firstMatch(html: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return '';
}

/** Strip tags + collapse whitespace + decode entities for a plain-text title. */
function cleanTitle(raw: string): string {
  const text = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.slice(0, 200);
}

/**
 * Extract Open Graph (with Twitter/fallbacks) metadata from an HTML document.
 * Returns null when the page carries nothing usable. Tolerates the messy quoting
 * and attribute order real-world pages emit: matches both `property=` and
 * `name=`, single/double/unquoted values, and both attribute orders
 * (`<meta property="og:x" content="…">` and `<meta content="…" name="og:x">`).
 * The content value is captured up to its closing quote — not to the next `>` —
 * so titles containing markup-like text don't truncate.
 */
export function parseOgMeta(html: string, baseUrl: string): LinkMeta | null {
  const metaContent = (key: string): string => {
    const esc = key.replace(/[:.]/g, '\\$&');
    const head = `<meta[^>]*?`;
    const keyPart = `(?:property|name)\\s*=\\s*["']?${esc}["']?`;
    return firstMatch(html, [
      new RegExp(`${head}${keyPart}[^>]*?content\\s*=\\s*"([^"]*)"`, 'i'),
      new RegExp(`${head}${keyPart}[^>]*?content\\s*=\\s*'([^']*)'`, 'i'),
      new RegExp(`${head}${keyPart}[^>]*?content\\s*=\\s*([^\\s>"']+)`, 'i'),
      // content-first attribute order
      new RegExp(`${head}content\\s*=\\s*"([^"]*)"[^>]*?${keyPart}`, 'i'),
      new RegExp(`${head}content\\s*=\\s*'([^']*)'[^>]*?${keyPart}`, 'i'),
      new RegExp(`${head}content\\s*=\\s*([^\\s>"']+)[^>]*?${keyPart}`, 'i'),
    ]);
  };

  const title = cleanTitle(
    metaContent('og:title') ||
      metaContent('twitter:title') ||
      firstMatch(html, [/<title[^>]*>([\s\S]{1,300}?)<\/title>/i])
  );
  const image = absoluteUrl(
    baseUrl,
    metaContent('og:image') || metaContent('twitter:image') || metaContent('twitter:image:src')
  );
  const site =
    cleanTitle(metaContent('og:site_name')) ||
    (() => {
      try {
        return new URL(baseUrl).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();

  if (!title && !image) return null;
  return { title, image, site };
}

/** Same-origin guard — mirrors the chat gateway's (native clients send no Origin). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/** Read at most MAX_HTML_BYTES of the body, then stop. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (html.length >= MAX_HTML_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return html.slice(0, MAX_HTML_BYTES);
    }
  }
  return html;
}

/**
 * POST { url: "https://…" } → { title, image, site } (any field '' when absent).
 * Never throws to the client: every failure becomes a 200 with empty fields, so
 * the composer can attach the link without the preview and nothing breaks.
 */
export async function handleLinkPreview(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!sameOrigin(req)) return json(403, { error: 'forbidden' });

  let url = '';
  try {
    const body = (await req.json()) as { url?: unknown };
    if (typeof body.url === 'string') url = body.url.trim();
  } catch {
    return json(400, { error: 'bad_json' });
  }
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return json(200, { title: '', image: '', site: '' });
    host = u.hostname;
  } catch {
    return json(200, { title: '', image: '', site: '' });
  }
  if (!host || isBlockedHost(host)) return json(200, { title: '', image: '', site: '' });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return json(200, { title: '', image: '', site: '' });
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return json(200, { title: '', image: '', site: '' });
    const html = await readCapped(res);
    const meta = parseOgMeta(html, res.url || url);
    return json(200, meta ?? { title: '', image: '', site: '' });
  } catch {
    return json(200, { title: '', image: '', site: '' });
  }
}
