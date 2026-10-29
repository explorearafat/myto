// ---------------------------------------------------------------------------
// News feed fetcher. Every desk has an ORDERED source list (agents.mjs); the
// first source that yields items wins, so one blocked/rate-limited publisher
// never produces an empty desk again.
//
// All requests carry a browser User-Agent — publishers (Cloudflare-fronted
// ones especially) 403/429 the default `node` UA. CoinDesk's RSS 308-redirects
// to a trailing-slash variant; undici's fetch follows redirects natively.
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function stripHtml(raw) {
  let s = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/\s+([,.!?;:…])/g, '$1');
}

function summarise(text, maxSentences = 3, maxChars = 280) {
  const clean = stripHtml(text ?? '');
  const parts = clean.split(/(?<=[.!?])\s+/);
  const taken = parts.slice(0, maxSentences).join(' ').trim();
  if (taken.length <= maxChars) return taken;
  const cut = taken.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 80 ? cut.slice(0, lastSpace) : cut}…`;
}

function decodeCdata(v) {
  if (!v) return '';
  return v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeCdata(m[1]).trim() : '';
}

/// Parse RSS <item> / Atom <entry> blocks the same way the mobile client's
/// regex parser does (publisher feeds are well-formed; no XML dep needed).
export function parseFeed(xml, limit = 20) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[1] ?? m[2] ?? '';
    const title = stripHtml(tag(block, 'title'));
    let link = tag(block, 'link');
    if (!link || link.includes('<')) {
      link = block.match(/href="([^"]+)"/i)?.[1] ?? '';
    }
    const description = tag(block, 'description') || tag(block, 'content') || tag(block, 'summary');
    const image = block.match(/url="([^"]+)"/i)?.[1] ?? '';
    if (!title || !link.startsWith('https://')) continue;
    items.push({
      title,
      summary: summarise(description, 3, 260),
      url: link,
      image: image.startsWith('http') ? image : '',
    });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchUrl(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/// Walk a desk's source list; return the first source's items.
export async function fetchNews(sources, limit = 20) {
  const errors = [];
  for (const url of sources) {
    try {
      const xml = await fetchUrl(url);
      const items = parseFeed(xml, limit);
      if (items.length === 0) throw new Error('feed parsed to zero items');
      console.log(`  [feeds] ${new URL(url).host} → ${items.length} items`);
      return items;
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.message}`);
      console.warn(`  [feeds] ${new URL(url).host} failed — ${e.message}`);
    }
  }
  throw new Error(`All sources failed:\n  ${errors.join('\n  ')}`);
}
