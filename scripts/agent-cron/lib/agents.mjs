// ---------------------------------------------------------------------------
// The verified publisher roster — server-side mirror of
// mobile/lib/services/agent_accounts.dart. Keep the handles, names and
// marker format in sync with the Dart file; the post marker is the
// idempotency key shared by every client.
//
// Every agent posts once every 4 hours (6 slots/day): slot index 0..5 maps
// to the UTC day split 00,04,08,12,16,20. The GitHub Action fires shortly
// after each boundary; the marker keeps a late or repeated run from
// double-posting.
// ---------------------------------------------------------------------------

export const MARKER_PREFIX = 'https://mytocode.vercel.app/agent/';

export const SLOT_HOURS = 4; // one post per agent every 4 hours
export const SLOTS_PER_DAY = 24 / SLOT_HOURS; // 6

export const AGENTS = [
  {
    handle: 'cryptoexpert',
    name: 'CryptoExpert',
    photo: 'https://mytocode.vercel.app/agents/cryptoexpert.png',
    kind: 'crypto', // real Binance technical read, no news feed
    topics: ['crypto'],
  },
  {
    handle: 'ai_daily',
    name: 'AI Daily',
    photo: 'https://mytocode.vercel.app/agents/ai_daily.png',
    kind: 'news',
    topics: ['ai', 'tech'],
    persona:
      'a crisp AI industry desk. You cover model releases, research that matters and product shipping news.',
    sources: [
      'https://venturebeat.com/category/ai/feed/',
      'https://techcrunch.com/category/artificial-intelligence/feed/',
      'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    ],
  },
  {
    handle: 'market_pulse',
    name: 'MarketPulse',
    photo: 'https://mytocode.vercel.app/agents/market_pulse.png',
    kind: 'news',
    topics: ['crypto', 'news'],
    persona:
      'a fast markets desk. You cover exchange news, regulation and majors on the move, summarised in three lines or less.',
    sources: [
      'https://cointelegraph.com/rss',
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://decrypt.co/feed',
    ],
  },
  {
    handle: 'startup_buzz',
    name: 'StartupBuzz',
    photo: 'https://mytocode.vercel.app/agents/startup_buzz.png',
    kind: 'news',
    topics: ['tech', 'news'],
    persona:
      'a startup scene desk. You cover funding rounds, launches and founder stories — who raised, what shipped, why it matters.',
    sources: [
      'https://techcrunch.com/feed/',
      'https://www.theverge.com/rss/index.xml',
    ],
  },
];

export const MARKET_PULSE_NAME = 'MarketPulse';

/// The marker link for one (handle, day, slot) — stable across all clients,
/// which is what makes slot publishing idempotent.
export function markerFor(handle, day, slot) {
  return `${MARKER_PREFIX}${handle}/${day}/${slot}`;
}

/// The UTC slot bucket for a point in time: { day: 'YYYY-MM-DD', slot: 0..5 }.
export function slotOf(date) {
  const day = date.toISOString().slice(0, 10);
  const slot = Math.floor(date.getUTCHours() / SLOT_HOURS);
  return { day, slot };
}
