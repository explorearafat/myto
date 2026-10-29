// ---------------------------------------------------------------------------
// Binance public market data + the technical read for CryptoExpert's posts.
// Port of mobile/lib/services/binance_service.dart + analyseCoin from
// agent_feed_service.dart (SMA7/25 cross on hourly closes, 14-RSI, 7-day
// trend) — kept identical so server and app agree on a verdict.
// ---------------------------------------------------------------------------

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];

const COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX', 'AVAX', 'LINK', 'DOT', 'LTC'];

async function getJson(path) {
  let last;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`All Binance hosts failed: ${last?.message}`);
}

export function fmtPrice(p) {
  if (p == null) return '--';
  if (p >= 1000) return `$${p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  if (p >= 1) return `$${p.toFixed(p < 10 ? 4 : 2)}`;
  return `$${p.toFixed(6)}`;
}

function sma(values, n) {
  if (values.length < n || n <= 0) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/// The verdict table from analyseCoin (see the Dart file for the rationale).
export function analyseCoin({ coin, price, open24, hourly, daily }) {
  const fast = sma(hourly, 7);
  const slow = sma(hourly, 25);
  const r = rsi(hourly);
  const weekTrend = daily.length >= 2 ? ((daily.at(-1) - daily[0]) / daily[0]) * 100 : 0;
  const changePct = open24 === 0 ? 0 : ((price - open24) / open24) * 100;
  const bullish = fast != null && slow != null && fast > slow;
  const bearish = fast != null && slow != null && fast < slow;

  let verdict;
  if (bullish && r != null && r >= 50 && r <= 70 && weekTrend > 0) verdict = 'BUY';
  else if (bullish && (r == null || r < 50)) verdict = 'ACCUMULATE';
  else if (bearish && ((r != null && r > 70) || weekTrend < -5)) verdict = 'SELL';
  else if (!bullish && !bearish) verdict = 'HOLD';
  else if (bullish) verdict = weekTrend > 3 ? 'BUY' : 'ACCUMULATE';
  else verdict = weekTrend < -3 ? 'SELL' : 'HOLD';

  const score = { BUY: 3, SELL: 3, ACCUMULATE: 2, HOLD: 1 }[verdict] ?? 0;
  return {
    coin,
    price,
    changePct,
    verdict,
    rsi: r,
    smaFast: fast,
    smaSlow: slow,
    weekTrendPct: weekTrend,
    strength: score * 10 + Math.min(Math.max(Math.abs(weekTrend), 0), 20),
  };
}

function crossText(s) {
  if (s.smaFast != null && s.smaSlow != null) {
    return s.smaFast >= s.smaSlow ? '7-SMA above 25-SMA — trend is up' : '7-SMA below 25-SMA — pressure down';
  }
  return 'trend data still building';
}

export function cryptoPostBody(s) {
  const pct = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%`;
  const rsiText = s.rsi == null ? 'n/a' : s.rsi.toFixed(0);
  const week = `${s.weekTrendPct >= 0 ? '+' : ''}${s.weekTrendPct.toFixed(1)}%`;
  return [
    `${s.coin}/USDT — ${fmtPrice(s.price)} (${pct} 24h)`,
    '',
    `Signal: ${s.verdict}`,
    `• ${crossText(s)}`,
    `• RSI ${rsiText} · 7-day trend ${week}`,
    'Live rate and chart below. Not financial advice.',
    '[[crypto:' + `${s.coin}USDT]]`,
  ].join('\n');
}

/// The strongest signal across the majors, or null when market data is down.
export async function strongestSignal() {
  const pairs = COINS.map((c) => `${c}USDT`);
  const symbols = encodeURIComponent(JSON.stringify(pairs));
  const tickers = await getJson(`/api/v3/ticker/24hr?symbols=${symbols}`);
  const byPair = new Map(tickers.map((t) => [t.symbol, t]));

  let best = null;
  for (const coin of COINS) {
    const t = byPair.get(`${coin}USDT`);
    const price = Number(t?.lastPrice ?? 0);
    if (!t || price <= 0) continue;
    try {
      const kl = await getJson(`/api/v3/klines?symbol=${coin}USDT&interval=1h&limit=30`);
      const hourly = kl.map((k) => Number(k[4])).filter((v) => v > 0);
      const kd = await getJson(`/api/v3/klines?symbol=${coin}USDT&interval=1d&limit=8`);
      const daily = kd.map((k) => Number(k[4])).filter((v) => v > 0);
      const signal = analyseCoin({ coin, price, open24: Number(t.openPrice), hourly, daily });
      if (!best || signal.strength > best.strength) best = signal;
    } catch (e) {
      // One coin's chart failing must not kill the post.
      console.warn(`  [binance] ${coin} chart failed — ${e.message}`);
    }
  }
  return best;
}
