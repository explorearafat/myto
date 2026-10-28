import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

import 'agent_accounts.dart';
import 'binance_service.dart';
import 'social_service.dart';

/// ---------------------------------------------------------------------------
/// AgentFeedService — generates and seeds the verified agents' daily posts.
///
/// The crypto desk reads REAL Binance market data (24h ticker + hourly and
/// daily klines) and turns it into a deterministic technical read: SMA7/25
/// cross, 14-RSI, 24h momentum and the 7-day trend decide a BUY / ACCUMULATE /
/// SELL / HOLD verdict on the strongest coin. The news desks pull free public
/// feeds (CryptoCompare for markets, VentureBeat for AI, TechCrunch for
/// startups) and condense each headline into a 2–4 line summary with the real
/// article link.
///
/// Seeding is IDEMPOTENT per (day, slot): each post carries the marker link
/// from [markerFor], and before writing we check whether a post with that
/// marker already exists — so whichever device opens the app first after a
/// slot passes publishes it, and every other device sees the same post. No
/// Firestore schema or rules changes; the posts are ordinary posts authored
/// with the account's name/photo, which is how desktop and website display
/// them as normal feed content.
///
/// All analysis functions are pure and unit-tested (see
/// test/agent_feed_test.dart); the network wiring around them is not.
/// ---------------------------------------------------------------------------

/// One generated post ready to publish.
class GeneratedPost {
  const GeneratedPost({
    required this.text,
    required this.topics,
    this.link = '',
    this.linkTitle = '',
    this.linkSite = '',
    this.linkImage = '',
  });

  final String text;
  final List<String> topics;
  final String link;
  final String linkTitle;
  final String linkSite;
  final String linkImage;
}

/// A per-coin technical read.
class CryptoSignal {
  const CryptoSignal({
    required this.coin,
    required this.price,
    required this.changePct,
    required this.verdict,
    required this.rsi,
    required this.smaFast,
    required this.smaSlow,
    required this.weekTrendPct,
  });

  final CoinDef coin;
  final double price;
  final double changePct;
  final String verdict; // 'BUY' | 'ACCUMULATE' | 'SELL' | 'HOLD'
  final double? rsi;
  final double? smaFast;
  final double? smaSlow;
  final double weekTrendPct;

  /// Rank signal strength for picking the day's headline call. BUY/SELL on a
  /// confirmed cross beats a HOLD; bigger |weekTrend| breaks ties.
  double get strength {
    const verdictScore = <String, double>{
      'BUY': 3,
      'SELL': 3,
      'ACCUMULATE': 2,
      'HOLD': 1,
    };
    return (verdictScore[verdict] ?? 0) * 10 + weekTrendPct.abs().clamp(0, 20);
  }
}

/// Decide a verdict from the market shape. Pure — the heart of the desk.
///
///   BUY         — fast SMA above slow SMA, RSI mid-range (50–70), 7d up
///   ACCUMULATE  — uptrend intact but RSI low (dip) or trend only starting
///   SELL        — fast SMA below slow SMA, RSI high (>70) or 7d momentum down hard
///   HOLD        — everything else
CryptoSignal analyseCoin({
  required CoinDef coin,
  required double price,
  required double open24,
  required List<double> hourly,
  required List<double> daily,
  double? rsiValue,
}) {
  final fast = sma(hourly, 7);
  final slow = sma(hourly, 25);
  final r = rsiValue ?? rsi(hourly);
  final weekTrend = (daily.length >= 2)
      ? (daily.last - daily.first) / daily.first * 100
      : 0.0;
  final changePct = open24 == 0 ? 0.0 : (price - open24) / open24 * 100;
  final bullishCross = fast != null && slow != null && fast > slow;
  final bearishCross = fast != null && slow != null && fast < slow;

  String verdict;
  if (bullishCross && r != null && r >= 50 && r <= 70 && weekTrend > 0) {
    verdict = 'BUY';
  } else if (bullishCross && (r == null || r < 50)) {
    verdict = 'ACCUMULATE';
  } else if (bearishCross && ((r != null && r > 70) || weekTrend < -5)) {
    verdict = 'SELL';
  } else if (!bullishCross && !bearishCross) {
    verdict = 'HOLD';
  } else if (bullishCross) {
    verdict = weekTrend > 3 ? 'BUY' : 'ACCUMULATE';
  } else {
    verdict = weekTrend < -3 ? 'SELL' : 'HOLD';
  }
  return CryptoSignal(
    coin: coin,
    price: price,
    changePct: changePct,
    verdict: verdict,
    rsi: r,
    smaFast: fast,
    smaSlow: slow,
    weekTrendPct: weekTrend,
  );
}

/// The 5–7 line post body for one signal, ending with the live-price marker
/// the feed renders as the crypto widget. Deterministic given the signal.
String cryptoPostBody(CryptoSignal s) {
  final pct = '${s.changePct >= 0 ? '+' : ''}${s.changePct.toStringAsFixed(2)}%';
  final rsiText = s.rsi == null ? 'n/a' : s.rsi!.toStringAsFixed(0);
  final week = '${s.weekTrendPct >= 0 ? '+' : ''}${s.weekTrendPct.toStringAsFixed(1)}%';
  final cross = (s.smaFast != null && s.smaSlow != null)
      ? (s.smaFast! >= s.smaSlow!
          ? '7-SMA above 25-SMA — trend is up'
          : '7-SMA below 25-SMA — pressure down')
      : 'trend data still building';
  final buffer = StringBuffer()
    ..writeln('${s.coin.symbol}/USDT — ${fmtPrice(s.price)} ($pct 24h)')
    ..writeln('')
    ..writeln('Signal: ${s.verdict}')
    ..writeln('• $cross')
    ..writeln('• RSI $rsiText · 7-day trend $week')
    ..write('Live rate and chart below. Not financial advice.')
    ..writeln()
    ..writeln('[[crypto:${s.coin.pair}]]');
  return buffer.toString().trim();
}

/// A news item pulled from a public feed.
class NewsItem {
  const NewsItem({
    required this.title,
    required this.summary,
    required this.url,
    this.image = '',
  });
  final String title;
  final String summary;
  final String url;
  final String image;
}

/// Strip HTML tags/entities from RSS descriptions.
String stripHtml(String raw) {
  var s = raw
      .replaceAll(RegExp(r'<[^>]*>'), ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&#8217;', "'")
      .replaceAll('&#8220;', '"')
      .replaceAll('&#8221;', '"')
      .replaceAll('&#8211;', '–')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&hellip;', '…')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>');
  s = s
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  // Tag removal leaves a space before the punctuation it abutted ("Myto …").
  s = s.replaceAllMapped(RegExp(r'\s+([,.!?;:…])'), (m) => m.group(1)!);
  return s;
}

/// First [maxChars]-ish characters of the first [maxSentences] sentences.
String summarise(String text, {int maxSentences = 3, int maxChars = 280}) {
  final clean = stripHtml(text);
  final parts = clean.split(RegExp(r'(?<=[.!?])\s+'));
  final taken = parts.take(maxSentences).join(' ').trim();
  if (taken.length <= maxChars) return taken;
  final cut = taken.substring(0, maxChars);
  final lastSpace = cut.lastIndexOf(' ');
  return '${lastSpace > 80 ? cut.substring(0, lastSpace) : cut}…';
}

/// Which public feed a news desk reads.
const Map<String, String> kNewsFeeds = <String, String>{
  'ai_daily': 'https://venturebeat.com/category/ai/feed/',
  'market_pulse': 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'startup_buzz': 'https://techcrunch.com/feed/',
};

/// Fetch a news desk's feed and return its recent items (RSS via regex —
/// well-formed publisher feeds, no XML package needed).
Future<List<NewsItem>> fetchNews(String handle, {int limit = 20}) async {
  // CryptoCompare's public news API is JSON and richer for markets.
  if (handle == 'market_pulse') {
    try {
      final res = await http
          .get(Uri.parse('https://min-api.cryptocompare.com/data/v2/news/?lang=EN'))
          .timeout(const Duration(seconds: 12));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final list = ((data['Data'] ?? const <dynamic>[]) as List).cast<Map<String, dynamic>>();
        return <NewsItem>[
          for (final n in list.take(limit))
            NewsItem(
              title: stripHtml('${n['title'] ?? ''}'),
              summary: summarise('${n['body'] ?? ''}', maxSentences: 3, maxChars: 260),
              url: '${n['url'] ?? ''}',
              image: '${n['imageurl'] ?? ''}',
            ),
        ].where((n) => n.title.isNotEmpty && n.url.startsWith('https://')).toList();
      }
    } catch (_) {
      // fall through to the RSS attempt below
    }
  }
  final feedUrl = kNewsFeeds[handle];
  if (feedUrl == null) return const <NewsItem>[];
  try {
    final res = await http.get(Uri.parse(feedUrl)).timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) return const <NewsItem>[];
    final xml = res.body;
    final items = <NewsItem>[];
    final re = RegExp(
      r'<item>([\s\S]*?)</item>|<entry>([\s\S]*?)</entry>',
      caseSensitive: false,
    );
    String? tag(String src, String name) {
      final m = RegExp(r'<$name[^>]*>([\s\S]*?)</$name>', caseSensitive: false).firstMatch(src);
      return m?.group(1)?.trim();
    }

    for (final m in re.allMatches(xml)) {
      final block = m.group(1) ?? m.group(2) ?? '';
      final title = stripHtml(tag(block, 'title') ?? '');
      var link = tag(block, 'link') ?? '';
      // Atom puts the link in an href attribute.
      if (link.isEmpty || link.contains('<')) {
        final href = RegExp(r'href="([^"]+)"').firstMatch(block)?.group(1) ?? '';
        link = href;
      }
      final description = tag(block, 'description') ?? tag(block, 'content') ?? '';
      final image = RegExp(r'url="([^"]+)"').firstMatch(block)?.group(1) ?? '';
      if (title.isEmpty || !link.startsWith('https://')) continue;
      items.add(NewsItem(
        title: title,
        summary: summarise(description, maxSentences: 3, maxChars: 260),
        url: link,
        image: image.startsWith('http') ? image : '',
      ));
      if (items.length >= limit) break;
    }
    return items;
  } catch (_) {
    return const <NewsItem>[];
  }
}

/// Build one news post: headline + summary lines + the real article link.
GeneratedPost newsPostBody(AgentAccount agent, NewsItem item, String day, int slot) {
  final lines = StringBuffer()
    ..writeln(item.title)
    ..writeln('')
    ..writeln(item.summary.isEmpty
        ? 'Full story at the link — worth two minutes.'
        : item.summary)
    ..write('What it means for builders: watch this space.');
  return GeneratedPost(
    text: lines.toString().trim(),
    topics: agent.topics,
    link: item.url,
    linkTitle: item.title.length <= 200 ? item.title : item.title.substring(0, 200),
    linkSite: Uri.tryParse(item.url)?.host.replaceFirst('www.', '') ?? '',
    linkImage: item.image,
  );
}

/// ---------------------------------------------------------------------------
/// The seeder.
/// ---------------------------------------------------------------------------
class AgentFeedService {
  AgentFeedService._();

  /// Seed every due agent slot in the last 48h that has no post yet. Call on
  /// Discover open (and app resume). Best-effort: network or Firestore
  /// failures leave the slot for the next open.
  static Future<void> seedIfDue({DateTime? now}) async {
    final user = FirebaseAuth.instance.currentUser;
    final uid = user?.uid ?? '';
    if (uid.isEmpty) return;

    final t = now ?? DateTime.now();
    for (final agent in kAgentAccounts) {
      for (var dayOffset = 1; dayOffset >= 0; dayOffset--) {
        final day = DateTime(t.year, t.month, t.day - dayOffset);
        final dayKey = _dayKey(day);
        for (var i = 0; i < agent.slots.length; i++) {
          final parts = agent.slots[i].split(':');
          final when = day.add(Duration(hours: int.parse(parts[0]), minutes: int.parse(parts[1])));
          if (when.isAfter(t)) continue;
          final marker = markerFor(agent.handle, dayKey, i);
          try {
            if (await _postExists(marker)) continue;
            final post = await generate(agent, i, dayKey);
            await SocialService.createPost(
              uid: uid,
              name: agent.name,
              photo: agent.photo,
              text: post.text,
              topics: post.topics,
              link: marker,
              linkMeta: <String, String>{
                'title': post.linkTitle,
                'image': post.linkImage,
                'site': post.linkSite,
              },
            );
          } catch (_) {
            // Miss this slot this time; the next open retries it (within 48h).
          }
        }
      }
    }
  }

  /// Generate the content for one slot. Crypto slots read Binance; news slots
  /// read the desk's feed and pick deterministically so re-runs converge.
  static Future<GeneratedPost> generate(AgentAccount agent, int slot, String dayKey) async {
    if (agent.handle == 'cryptoexpert') {
      return _cryptoPost();
    }
    final items = await fetchNews(agent.handle);
    if (items.isEmpty) {
      // Feed unavailable — a short standdown note keeps the cadence honest.
      return GeneratedPost(
        text: '${agent.name} brief: feed temporarily unavailable — the next '
            'drop lands at the usual time.',
        topics: agent.topics,
      );
    }
    // Deterministic per-day headline pick; the marker keeps any accidental
    // collision from publishing twice.
    final seed = (stableHash01('$dayKey:${agent.handle}') * items.length).floor();
    final candidate = items[(seed + slot * 3) % items.length];
    return newsPostBody(agent, candidate, dayKey, slot);
  }

  static Future<GeneratedPost> _cryptoPost() async {
    final coins = kCoins.take(8).toList();
    final pairs = coins.map((c) => c.pair).toList();
    final tickers = await BinanceService.tickers(pairs);
    final byPair = <String, Ticker24>{for (final t in tickers) t.pair: t};

    CryptoSignal? best;
    for (final coin in coins) {
      final tick = byPair[coin.pair];
      if (tick == null || tick.price <= 0) continue;
      try {
        final hourly = await BinanceService.klines(coin.pair, interval: '1h', limit: 30);
        final daily = await BinanceService.klines(coin.pair, interval: '1d', limit: 8);
        final signal = analyseCoin(
          coin: coin,
          price: tick.price,
          open24: tick.open,
          hourly: hourly,
          daily: daily,
        );
        if (best == null || signal.strength > best.strength) best = signal;
      } catch (_) {
        // One coin's chart failing must not kill the post.
      }
    }
    if (best == null) {
      throw StateError('No market data available');
    }
    return GeneratedPost(
      text: cryptoPostBody(best),
      topics: const <String>['crypto'],
    );
  }

  static Future<bool> _postExists(String marker) async {
    return SocialService.postWithMarkerExists(marker);
  }

  static String _dayKey(DateTime day) =>
      '${day.year.toString().padLeft(4, '0')}-'
      '${day.month.toString().padLeft(2, '0')}-'
      '${day.day.toString().padLeft(2, '0')}';
}
