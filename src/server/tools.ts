// Server-side tool calling for the chat gateway. The user's endpoint is streamed and may speak no
// native `tool_calls`, so — exactly like the desktop app — tools ride a text protocol:
// the model emits a fenced ```sylor:tool block, we detect it mid-stream, run the tool, and feed a
// ```sylor:tool_result block back. Because the loop lives here in the gateway, BOTH the website
// and the mobile app inherit tools for free; each client only has to render the two block kinds.
//
// Only READ-ONLY web tools live here (web_fetch / web_search / wiki_search). There is deliberately
// no run_code: this handler runs on a shared server, so executing arbitrary code would be a hole.
// "Run code on this machine" stays a desktop-only capability where the machine is the user's own.
//
// Everything here is Edge-compatible: fetch, URL, TextEncoder/Decoder, AbortController only.

// ── Tool-call parser (mirrors app/src/main/tools/toolParser.ts) ───────────────────────────────

const MARKER = '```sylor:tool';

export interface ToolCall {
  /** The exact block text to write into the reply for the card. */
  block: string;
  /** Parsed tool name, or null when the JSON was missing/malformed. */
  name: string | null;
  /** The value under the call's `input` key. */
  input: unknown;
  /** A human-readable parse error when `name` is null; else null. */
  error: string | null;
}

export interface ToolParseResult {
  text: string;
  call: ToolCall | null;
}

export interface ToolCallParser {
  push(delta: string): ToolParseResult;
  flush(): string;
}

function parseToolBody(body: string): { name: string | null; input: unknown; error: string | null } {
  const trimmed = body.trim();
  if (!trimmed) return { name: null, input: null, error: 'empty tool call' };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (err) {
    return { name: null, input: null, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { name: null, input: null, error: 'tool call must be a JSON object' };
  }
  const rec = obj as Record<string, unknown>;
  const name = typeof rec.tool === 'string' && rec.tool.trim() ? rec.tool.trim() : null;
  if (!name) return { name: null, input: rec.input ?? null, error: 'missing "tool" field' };
  return { name, input: rec.input ?? {}, error: null };
}

function lineStartIndexOf(s: string, marker: string): number {
  if (s.startsWith(marker)) return 0;
  let from = 0;
  for (;;) {
    const nl = s.indexOf('\n', from);
    if (nl === -1) return -1;
    if (s.startsWith(marker, nl + 1)) return nl + 1;
    from = nl + 1;
  }
}

function heldToolPrefix(s: string): number {
  const nl = s.lastIndexOf('\n');
  const lastLine = nl === -1 ? s : s.slice(nl + 1);
  if (lastLine.length > 0 && lastLine.length < MARKER.length && MARKER.startsWith(lastLine)) {
    return lastLine.length;
  }
  return 0;
}

function extractToolBlock(buf: string): { consumed: number; call: ToolCall } | null {
  const lines = buf.split('\n');
  const openFence = /^(`{3,})/.exec(lines[0]);
  const fenceLen = openFence ? openFence[1].length : 3;
  let closeLine = -1;
  for (let k = 1; k < lines.length; k++) {
    const c = /^(`{3,})[ \t]*$/.exec(lines[k]);
    if (c && c[1].length >= fenceLen) {
      closeLine = k;
      break;
    }
  }
  if (closeLine === -1) return null;
  const block = lines.slice(0, closeLine + 1).join('\n');
  const body = lines.slice(1, closeLine).join('\n');
  let consumed = block.length;
  if (buf[consumed] === '\n') consumed++;
  return { consumed, call: { block, ...parseToolBody(body) } };
}

/** Incremental parser: forwards prose immediately, holds a tool block until its closing fence. */
export function createToolCallParser(): ToolCallParser {
  let buffer = '';
  let inTool = false;
  return {
    push(delta: string): ToolParseResult {
      buffer += delta;
      let text = '';
      for (;;) {
        if (!inTool) {
          const idx = lineStartIndexOf(buffer, MARKER);
          if (idx === -1) {
            const hold = heldToolPrefix(buffer);
            text += buffer.slice(0, buffer.length - hold);
            buffer = buffer.slice(buffer.length - hold);
            return { text, call: null };
          }
          text += buffer.slice(0, idx);
          buffer = buffer.slice(idx);
          inTool = true;
        }
        const found = extractToolBlock(buffer);
        if (!found) return { text, call: null };
        buffer = buffer.slice(found.consumed);
        inTool = false;
        return { text, call: found.call };
      }
    },
    flush(): string {
      const rest = buffer;
      buffer = '';
      inTool = false;
      return rest;
    },
  };
}

/** Shortest backtick fence that wraps `text` without an internal run closing it early. */
export function fenceFor(text: string): string {
  let max = 0;
  for (const run of text.matchAll(/`+/g)) max = Math.max(max, run[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

/** Wrap a tool result as a fenced block the reply carries and each client coalesces onto its card. */
export function toolResultBlock(name: string, result: string): string {
  const fence = fenceFor(result);
  return `\n\n${fence}sylor:tool_result ${name}\n${result}\n${fence}\n\n`;
}

// ── HTML → text + fetch helpers ───────────────────────────────────────────────────────────────

const UA = 'SylorChat/0.2 (+https://sylorcode.vercel.app)';
const FETCH_CAP = 6000;
const FETCH_TIMEOUT_MS = 8000;

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function htmlToText(html: string, cap = FETCH_CAP): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[^\S\n]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (s.length > cap) s = s.slice(0, cap).trimEnd() + '\n…[truncated]';
  return s;
}

async function fetchText(url: string, accept: string, signal: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { 'user-agent': UA, accept }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// A browser-like User-Agent for search: DuckDuckGo's HTML endpoints serve datacenter
// IPs a stripped/challenge page when the UA looks like a bot, which is exactly why the
// old scraper came back empty from Vercel. A real browser UA gets the normal results page.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/**
 * POST a form body to a URL with browser-like headers. DuckDuckGo's `/html/` endpoint
 * is far more reliable via POST `q=…` (form) than a GET query string from a server IP.
 */
async function fetchSearch(
  url: string,
  form: Record<string, string> | null,
  signal: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    };
    const init: RequestInit = form
      ? {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        }
      : { headers };
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// ── Search result formatting ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeDdgHref(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

export function parseDuckDuckGo(html: string, limit = 6): SearchResult[] {
  const anchorRe = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));
  const results: SearchResult[] = [];
  let i = 0;
  while ((m = anchorRe.exec(html)) && results.length < limit) {
    const title = stripTags(m[2]);
    if (title) results.push({ title, url: decodeDdgHref(m[1]), snippet: snippets[i] ?? '' });
    i++;
  }
  return results;
}

/**
 * Parse the DuckDuckGo Lite page (`lite.duckduckgo.com/lite/`) — a plain table layout
 * used as a fallback when the main HTML endpoint returns nothing. Result links carry
 * `class="result-link"`; the snippet sits in a following `td.result-snippet`.
 */
export function parseDuckDuckGoLite(html: string, limit = 6): SearchResult[] {
  // The Lite page puts href BEFORE the class and quotes the class with single quotes
  // (`<a rel="nofollow" href="URL" class='result-link'>`), so the regex must be quote-
  // agnostic and match that attribute order — not the html endpoint's class-then-href.
  const linkRe = /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));
  const results: SearchResult[] = [];
  let i = 0;
  while ((m = linkRe.exec(html)) && results.length < limit) {
    const title = stripTags(m[2]);
    if (title) results.push({ title, url: decodeDdgHref(m[1]), snippet: snippets[i] ?? '' });
    i++;
  }
  return results;
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (!results.length) return `No web results for "${query}".`;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
}

interface WikiSearchResp {
  query?: { search?: Array<{ title: string; snippet: string }> };
}
interface WikiExtractResp {
  query?: { pages?: Record<string, { title: string; extract?: string }> };
}

export function formatWiki(query: string, hits: Array<{ title: string; snippet: string }>, intro: string): string {
  const list = hits.map((h, i) => `${i + 1}. ${h.title} — ${stripTags(h.snippet)}`).join('\n');
  const lead = intro && hits[0] ? `\n\n${hits[0].title}:\n${intro.slice(0, 3000)}` : '';
  return `Wikipedia results for "${query}":\n${list}${lead}`;
}

// ── Input readers + SSRF guard ────────────────────────────────────────────────────────────────

/** Block obvious private/loopback/metadata hosts so web_fetch (and the BYOK proxy) can't be turned inward. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  return false;
}

function readUrl(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).url : undefined;
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isBlockedHost(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function readQuery(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).query : undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// ── The tools ─────────────────────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  usage: string;
  run(input: unknown, signal: AbortSignal): Promise<string>;
}

const webFetch: ToolDef = {
  name: 'web_fetch',
  description: 'Fetch a public web page and return its readable text.',
  usage: '{"url": "https://example.com/article"}',
  async run(input, signal) {
    const url = readUrl(input);
    if (!url) return 'web_fetch needs {"url": "https://…"} with a public http/https URL.';
    const res = await fetchText(url, 'text/html,application/xhtml+xml,text/plain', signal);
    if (!res.ok) return `Fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`;
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = /html|xml/i.test(ct) ? htmlToText(body) : body.slice(0, FETCH_CAP);
    return text.trim() || '(the page had no readable text)';
  },
};

const webSearch: ToolDef = {
  name: 'web_search',
  description: 'Search the web and return the top results (titles, links, snippets).',
  usage: '{"query": "your search terms"}',
  async run(input, signal) {
    const query = readQuery(input);
    if (!query) return 'web_search needs {"query": "…"}.';

    // DuckDuckGo's HTML endpoint is flaky from datacenter IPs (Vercel): a GET with a
    // bot-ish UA often returns an empty/challenge page — which is why search "worked"
    // but came back with no results. Try three resilient strategies in order and use
    // the first that yields results:
    //   1. POST form to html.duckduckgo.com/html/ (most reliable from a server).
    //   2. GET the same endpoint (some regions/edges prefer it).
    //   3. GET the Lite endpoint, which has its own simpler layout.
    const attempts: Array<() => Promise<SearchResult[]>> = [
      async () => {
        const r = await fetchSearch('https://html.duckduckgo.com/html/', { q: query }, signal);
        return r.ok ? parseDuckDuckGo(await r.text()) : [];
      },
      async () => {
        const r = await fetchSearch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          null,
          signal,
        );
        return r.ok ? parseDuckDuckGo(await r.text()) : [];
      },
      async () => {
        const r = await fetchSearch('https://lite.duckduckgo.com/lite/', { q: query }, signal);
        return r.ok ? parseDuckDuckGoLite(await r.text()) : [];
      },
    ];

    for (const attempt of attempts) {
      if (signal.aborted) return 'web_search was cancelled.';
      let results: SearchResult[] = [];
      try {
        results = await attempt();
      } catch {
        // Try the next strategy — a single endpoint hiccup shouldn't fail the search.
        continue;
      }
      if (results.length) return formatSearchResults(query, results);
    }
    // Every strategy came back empty. Suggest Wikipedia so the model has a next move
    // instead of telling the user "search doesn't work".
    return `No web results for "${query}" (the search endpoint returned nothing). Try rephrasing the query, or use wiki_search for an encyclopedic answer.`;
  },
};

const wikiSearch: ToolDef = {
  name: 'wiki_search',
  description: 'Search Wikipedia and return the top matches with the lead paragraph of the best one.',
  usage: '{"query": "Ada Lovelace"}',
  async run(input, signal) {
    const query = readQuery(input);
    if (!query) return 'wiki_search needs {"query": "…"}.';
    const base = 'https://en.wikipedia.org/w/api.php';
    const searchUrl = `${base}?action=query&format=json&list=search&srlimit=5&srsearch=${encodeURIComponent(query)}`;
    const res = await fetchText(searchUrl, 'application/json', signal);
    if (!res.ok) return `Wikipedia search failed: HTTP ${res.status}`;
    const data = (await res.json().catch(() => null)) as WikiSearchResp | null;
    const hits = data?.query?.search ?? [];
    if (!hits.length) return `No Wikipedia results for "${query}".`;
    let intro = '';
    try {
      const extractUrl = `${base}?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(hits[0].title)}`;
      const ex = await fetchText(extractUrl, 'application/json', signal);
      const exData = (await ex.json().catch(() => null)) as WikiExtractResp | null;
      const first = Object.values(exData?.query?.pages ?? {})[0];
      intro = first?.extract?.trim() ?? '';
    } catch {
      /* intro is best-effort; the list is enough on its own */
    }
    return formatWiki(query, hits, intro);
  },
};

const TOOLS: Record<string, ToolDef> = {
  web_fetch: webFetch,
  web_search: webSearch,
  wiki_search: wikiSearch,
};

/** Whether tool calling is enabled for the gateway (env kill-switch; on by default). */
export function toolsEnabled(): boolean {
  const v = (process.env.SYLOR_TOOLS || '').trim().toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

/** The system prompt that teaches the call protocol and lists the tools. */
export function toolsSystemPrompt(): string {
  const list = Object.values(TOOLS).map((t) => `- ${t.name} — ${t.description} Input example: ${t.usage}`);
  return [
    'You can call tools to get real, current information before you answer. To call a tool, write ONE fenced block and then STOP — do not write the result yourself:',
    '',
    '```sylor:tool',
    '{"tool": "<name>", "input": { ... }}',
    '```',
    '',
    'Rules:',
    '- Put the call on a single line of compact JSON between the fences.',
    '- After the block, output nothing and wait. The result comes back to you as a ```sylor:tool_result block.',
    '- Read the result, then either call another tool or write your final answer.',
    '- Call a tool only when it genuinely helps: a current/time-sensitive fact, a page or source the user named, or something you are unsure of. Otherwise just answer directly.',
    '- Never invent a tool result or claim you used a tool you did not.',
    '',
    'Available tools:',
    ...list,
  ].join('\n');
}

/** Dispatch a parsed call. Never throws: every failure becomes a short message the model recovers from. */
export async function runTool(call: ToolCall, signal: AbortSignal): Promise<string> {
  if (call.error || !call.name) {
    return `That tool call did not parse (${call.error ?? 'unknown error'}). Re-issue it as one compact JSON object {"tool": "name", "input": { ... }} inside a sylor:tool block.`;
  }
  const tool = TOOLS[call.name];
  if (!tool) {
    return `Unknown tool "${call.name}". Available: ${Object.keys(TOOLS).join(', ')}.`;
  }
  try {
    return await tool.run(call.input, signal);
  } catch (err) {
    if (signal.aborted) return `The "${call.name}" tool was cancelled.`;
    return `The "${call.name}" tool failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
