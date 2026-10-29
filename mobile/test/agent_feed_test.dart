import 'package:flutter_test/flutter_test.dart';

import 'package:sylor/services/agent_accounts.dart';
import 'package:sylor/services/agent_feed_service.dart';
import 'package:sylor/services/binance_service.dart';
import 'package:sylor/services/social_service.dart';

/// Fixtures + pure-logic coverage for the verified agent accounts: the roster,
/// marker round-trips, the display like-count transform, the crypto technical
/// read and the news summariser. Everything here is deterministic — no
/// network, no Firestore, no Firebase.
void main() {
  FeedPost post({
    String id = 'p1',
    String name = 'Someone',
    String link = '',
    String text = 'hello world',
    int likeCount = 0,
    int createdAtMs = 0,
  }) {
    return FeedPost(
      id: id,
      uid: 'u1',
      name: name,
      photo: '',
      text: text,
      link: link,
      linkTitle: '',
      linkImage: '',
      linkSite: '',
      topics: const <String>[],
      likeCount: likeCount,
      commentCount: 0,
      shareCount: 0,
      createdAtMs: createdAtMs,
    );
  }

  group('agent roster', () {
    test('four accounts, unique handles and names, valid slots', () {
      expect(kAgentAccounts.length, 4);
      final handles = kAgentAccounts.map((a) => a.handle).toSet();
      final names = kAgentAccounts.map((a) => a.name).toSet();
      expect(handles.length, 4);
      expect(names.length, 4);
      for (final a in kAgentAccounts) {
        expect(a.handle, matches(RegExp(r'^[a-z0-9_]{3,20}$')));
        expect(a.slots, isNotEmpty);
        for (final s in a.slots) {
          final parts = s.split(':');
          expect(parts, hasLength(2));
          expect(int.parse(parts[0]), inInclusiveRange(0, 23));
          expect(int.parse(parts[1]), inInclusiveRange(0, 59));
        }
      }
    });

    test('cryptoexpert has the identity stats the product promised', () {
      final crypto = agentByHandle('cryptoexpert')!;
      expect(crypto.followers, 674000);
      expect(crypto.following, 326);
      expect(crypto.followersLabel, '674K');
      // Every agent posts on the server cron's 4-hour cadence — 6 slots/day.
      for (final a in kAgentAccounts) {
        expect(a.slots, hasLength(6));
        expect(a.photo, startsWith('https://mytocode.vercel.app/agents/'));
      }
    });

    test('lookup by name and handle', () {
      expect(agentByHandle('ai_daily')!.name, 'AI Daily');
      expect(agentByName('CryptoExpert')!.handle, 'cryptoexpert');
      // Names with a space never match handles ('ai daily' ≠ 'ai_daily').
      expect(agentByName('AI Daily'), isNotNull);
      expect(agentByHandle('ai daily'), isNull);
      expect(agentByName('Random Person'), isNull);
    });
  });

  group('marker links', () {
    test('round-trips handle, day and slot', () {
      final marker = markerFor('cryptoexpert', '2026-10-28', 1);
      expect(marker, startsWith(kAgentMarkerPrefix));
      final parsed = parseMarker(marker)!;
      expect(parsed.handle, 'cryptoexpert');
      expect(parsed.day, '2026-10-28');
      expect(parsed.slot, 1);
    });

    test('non-marker links parse to null', () {
      expect(parseMarker('https://example.com/whatever'), isNull);
      expect(parseMarker(''), isNull);
      expect(parseMarker('$kAgentMarkerPrefix/broken'), isNull);
    });

    test('agent posts are recognised by marker or name', () {
      final byMarker = post(link: markerFor('cryptoexpert', '2026-10-28', 0));
      final byName = post(name: 'MarketPulse', link: 'https://example.com/a');
      expect(isAgentPost(byMarker), isTrue);
      expect(isAgentPost(byName), isTrue);
      expect(isAgentPost(post(name: 'Someone')), isFalse);
      expect(agentForPost(byMarker)!.handle, 'cryptoexpert');
      expect(agentForPost(byName)!.handle, 'market_pulse');
    });
  });

  group('displayLikeCount', () {
    test('real posts are untouched', () {
      final p = post(likeCount: 42);
      expect(displayLikeCount(p), 42);
      expect(displayLikeCount(p, nowMs: 9999999999999), 42);
    });

    test('agent posts climb at 420–450/hour, deterministically', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      final p = post(
        id: 'agent-1',
        name: 'CryptoExpert',
        link: markerFor('cryptoexpert', '2026-10-28', 0),
        createdAtMs: now - 3 * 3600000, // 3h old
      );
      final a = displayLikeCount(p);
      final b = displayLikeCount(p);
      expect(a, same(b)); // stable per post
      // 3 hours of growth at 420–450/hour.
      expect(a, inInclusiveRange(1260, 1350));
    });

    test('the climb ticks ~7–7.5 likes per minute', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      final p = post(
        id: 'agent-2',
        name: 'AI Daily',
        link: markerFor('ai_daily', '2026-10-28', 0),
        createdAtMs: now - 3600000, // exactly 1h old
      );
      final perMinute = displayLikeCount(p, nowMs: now) / 60;
      expect(perMinute, inInclusiveRange(6.9, 7.6));
    });

    test('a day-old agent post stops growing at ~10K', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      FeedPost at(int ageHours) => post(
            id: 'agent-3',
            name: 'AI Daily',
            link: markerFor('ai_daily', '2026-10-28', 0),
            createdAtMs: now - ageHours * 3600000,
          );
      final at12h = displayLikeCount(at(12), nowMs: now);
      final at24h = displayLikeCount(at(24), nowMs: now);
      final at72h = displayLikeCount(at(72), nowMs: now);
      expect(at12h, inInclusiveRange(5040, 5400)); // half a day of growth
      expect(at24h, inInclusiveRange(10080, 10800)); // the 24h ceiling
      expect(at72h, at24h); // growth caps after the first day
    });

    test('the climb is visible hour over hour', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      final fresh = post(
        id: 'agent-4',
        name: 'MarketPulse',
        link: markerFor('market_pulse', '2026-10-28', 0),
        createdAtMs: now - 5 * 60000, // 5 minutes old
      );
      final later = post(
        id: 'agent-4',
        name: 'MarketPulse',
        link: markerFor('market_pulse', '2026-10-28', 0),
        createdAtMs: now - 2 * 3600000, // 2 hours old
      );
      final early = displayLikeCount(fresh, nowMs: now);
      final mid = displayLikeCount(later, nowMs: now);
      expect(early, lessThan(50)); // just born — nearly no likes yet
      expect(early, lessThan(mid)); // the steady climb
    });

    test('real likes stack on top of the pseudo-count', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      final withLikes = post(
        id: 'agent-5',
        name: 'CryptoExpert',
        link: markerFor('cryptoexpert', '2026-10-28', 0),
        likeCount: 250,
        createdAtMs: now - 3 * 3600000,
      );
      final withoutLikes = post(
        id: 'agent-5',
        name: 'CryptoExpert',
        link: markerFor('cryptoexpert', '2026-10-28', 0),
        likeCount: 0,
        createdAtMs: now - 3 * 3600000,
      );
      expect(displayLikeCount(withLikes, nowMs: now),
          displayLikeCount(withoutLikes, nowMs: now) + 250);
    });
  });

  group('crypto technical read', () {
    // A series that rises steadily — SMA7 above SMA25, mid RSI, up week.
    final rising = List<double>.generate(30, (i) => 100 + i * 1.0);
    final falling = List<double>.generate(30, (i) => 130 - i * 1.0);
    final flat = List<double>.filled(30, 100);

    test('steady uptrend with healthy RSI reads BUY', () {
      final s = analyseCoin(
        coin: kCoins.first,
        price: 129,
        open24: 126,
        hourly: rising,
        daily: <double>[100, 105, 112, 118, 124],
      );
      expect(s.verdict, 'BUY');
    });

    test('downtrend with an overbought-only shape never reads BUY', () {
      final s = analyseCoin(
        coin: kCoins.first,
        price: 100,
        open24: 129,
        hourly: falling,
        daily: <double>[129, 128, 126, 122, 118],
      );
      expect(s.verdict, isNot('BUY'));
      expect(s.verdict, anyOf('SELL', 'HOLD'));
    });

    test('a flat market reads HOLD', () {
      final s = analyseCoin(
        coin: kCoins.first,
        price: 100,
        open24: 100,
        hourly: flat,
        daily: <double>[100, 100, 100],
      );
      expect(s.verdict, 'HOLD');
    });

    test('verdicts carry strength for the headline pick', () {
      final buy = analyseCoin(
        coin: kCoins.first,
        price: 129,
        open24: 126,
        hourly: rising,
        daily: <double>[100, 105, 112, 118, 124],
      );
      final hold = analyseCoin(
        coin: kCoins.first,
        price: 100,
        open24: 100,
        hourly: flat,
        daily: <double>[100, 100, 100],
      );
      expect(buy.strength, greaterThan(hold.strength));
    });
  });

  group('crypto post body', () {
    test('has the signal lines, the marker, and fits the 500-char limit', () {
      final rising = List<double>.generate(30, (i) => 100 + i * 1.0);
      final s = analyseCoin(
        coin: kCoins.first,
        price: 67240.55,
        open24: 65720.10,
        hourly: rising,
        daily: <double>[100, 105, 112, 118, 124],
      );
      final body = cryptoPostBody(s);
      expect(body.contains('BTC/USDT'), isTrue);
      expect(body.contains('Signal:'), isTrue);
      expect(body.contains('RSI'), isTrue);
      expect(body.contains('[[crypto:BTCUSDT]]'), isTrue);
      expect(body.split('\n').length, inInclusiveRange(6, 9)); // 5–7 content lines
      expect(body.length, lessThanOrEqualTo(SocialService.maxPostChars));
    });
  });

  group('news summarising', () {
    test('stripHtml removes tags and entities', () {
      expect(
        stripHtml('<p>Hello &amp; welcome to <b>Myto</b>&hellip;</p>'),
        'Hello & welcome to Myto…',
      );
    });

    test('summarise keeps the first sentences and caps length', () {
      final long = 'First sentence is here. Second sentence follows. '
          'Third sentence too. Fourth sentence that pushes past the cap '
          'with a lot of extra words about many things and more text.';
      final out = summarise(long, maxSentences: 3, maxChars: 80);
      expect(out.startsWith('First sentence'), isTrue);
      expect(out.length, lessThanOrEqualTo(81)); // cap + ellipsis
    });

    test('newsPostBody carries the article link metadata', () {
      final agent = agentByHandle('startup_buzz')!;
      final item = NewsItem(
        title: 'A startup raised money',
        summary: 'It went well. Investors agreed.',
        url: 'https://techcrunch.com/2026/10/28/some-raise/',
      );
      final gp = newsPostBody(agent, item, '2026-10-28', 2);
      expect(gp.link, item.url);
      expect(gp.linkTitle, item.title);
      expect(gp.linkSite, 'techcrunch.com');
      expect(gp.text.contains(item.title), isTrue);
      expect(gp.topics, agent.topics);
      expect(gp.text.length, lessThanOrEqualTo(SocialService.maxPostChars));
    });
  });

  group('binance helpers', () {
    test('sma and rsi compute on simple series', () {
      expect(sma(<double>[1, 2, 3, 4, 5], 5), 3.0);
      expect(sma(<double>[1, 2, 3], 5), isNull);
      // 14 falling closes → RSI 0; 14 rising closes → RSI 100.
      final down = List<double>.generate(15, (i) => 100 - i.toDouble());
      final up = List<double>.generate(15, (i) => 100 + i.toDouble());
      expect(rsi(down), 0);
      expect(rsi(up), 100);
      expect(rsi(<double>[1, 2, 3]), isNull);
    });

    test('every tracked coin has a USDT pair and a CDN logo', () {
      for (final c in kCoins) {
        expect(c.pair, endsWith('USDT'));
        expect(c.logoUrl, contains(c.symbol.toLowerCase()));
      }
      expect(coinBySymbol('BTC')!.name, 'Bitcoin');
      expect(coinBySymbol('NOPE'), isNull);
    });

    test('fmtPrice formats by magnitude', () {
      expect(fmtPrice(67240.55), '\$67,240.55');
      expect(fmtPrice(2.5), '\$2.5000');
      expect(fmtPrice(0.000123), '\$0.000123');
      expect(fmtPrice(null), '--');
    });
  });
}
