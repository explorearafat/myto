import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// ---------------------------------------------------------------------------
/// BinanceService — live market data from Binance's public REST API (no key,
/// no account). Ported from the standalone Live Crypto Tracker page: the same
/// six hosts tried in order with a sticky preference (data-api.binance.vision
/// first, which also serves regions where api.binance.com is blocked), the
/// same 24h ticker and klines endpoints, prices in USDT.
///
/// Everything here is read-only public market data — no credentials, no
/// trading. Failures surface as exceptions the caller shows softly.
/// ---------------------------------------------------------------------------

/// One tracked coin: symbol, full name and its USDT pair.
class CoinDef {
  const CoinDef(this.symbol, this.name);
  final String symbol;
  final String name;
  String get pair => '${symbol}USDT';

  /// The CDN logo the crypto tracker uses (falls back to a letter disc).
  String get logoUrl =>
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/'
      '${symbol.toLowerCase()}.png';
}

/// The majors the app tracks — the same list as the crypto tracker page.
const List<CoinDef> kCoins = <CoinDef>[
  CoinDef('BTC', 'Bitcoin'),
  CoinDef('ETH', 'Ethereum'),
  CoinDef('BNB', 'BNB'),
  CoinDef('SOL', 'Solana'),
  CoinDef('XRP', 'XRP'),
  CoinDef('ADA', 'Cardano'),
  CoinDef('DOGE', 'Dogecoin'),
  CoinDef('TRX', 'TRON'),
  CoinDef('AVAX', 'Avalanche'),
  CoinDef('LINK', 'Chainlink'),
  CoinDef('DOT', 'Polkadot'),
  CoinDef('LTC', 'Litecoin'),
];

CoinDef? coinBySymbol(String symbol) {
  final s = symbol.toUpperCase();
  for (final c in kCoins) {
    if (c.symbol == s) return c;
  }
  return null;
}

/// A 24-hour market snapshot for one pair.
class Ticker24 {
  const Ticker24({
    required this.pair,
    required this.price,
    required this.open,
    required this.high,
    required this.low,
    required this.volume,
  });

  final String pair;
  final double price;
  final double open;
  final double high;
  final double low;
  final double volume;

  double get changePct => open == 0 ? 0 : (price - open) / open * 100;
}

/// Price formatting shared by the widgets and the generated posts.
String fmtPrice(double? p) {
  if (p == null) return '--';
  if (p >= 1000) return '\$${p.toStringAsFixed(2).replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+(?!\d))'), (m) => '${m[1]},')}';
  if (p >= 1) return '\$${p.toStringAsFixed(p < 10 ? 4 : 2)}';
  return '\$${p.toStringAsFixed(6)}';
}

class BinanceService {
  BinanceService._();

  /// Public market-data hosts, tried in order; [REST] sticks to the first
  /// one that worked so healthy sessions never pay the fallback cost.
  static const List<String> _hosts = <String>[
    'https://data-api.binance.vision',
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://api4.binance.com',
  ];
  static String? _preferred;

  static Future<dynamic> _getJson(String path, {Duration timeout = const Duration(seconds: 12)}) async {
    final tried = <String>[
      if (_preferred != null) _preferred!,
      ..._hosts.where((h) => h != _preferred),
    ];
    Object? last;
    for (final host in tried) {
      try {
        final res = await http.get(Uri.parse('$host$path')).timeout(timeout);
        if (res.statusCode != 200) {
          throw StateError('HTTP ${res.statusCode}');
        }
        _preferred = host;
        return jsonDecode(res.body);
      } catch (e) {
        last = e;
      }
    }
    throw StateError('All Binance hosts failed: $last');
  }

  /// 24h tickers for the given pairs.
  static Future<List<Ticker24>> tickers(List<String> pairs) async {
    final symbols = Uri.encodeComponent(jsonEncode(pairs));
    final data = await _getJson('/api/v3/ticker/24hr?symbols=$symbols') as List<dynamic>;
    return <Ticker24>[
      for (final d in data.cast<Map<String, dynamic>>())
        Ticker24(
          pair: (d['symbol'] ?? '') as String,
          price: double.tryParse('${d['lastPrice']}') ?? 0,
          open: double.tryParse('${d['openPrice']}') ?? 0,
          high: double.tryParse('${d['highPrice']}') ?? 0,
          low: double.tryParse('${d['lowPrice']}') ?? 0,
          volume: double.tryParse('${d['quoteVolume']}') ?? 0,
        ),
    ];
  }

  static Future<Ticker24> ticker(String pair) async {
    final list = await tickers(<String>[pair]);
    if (list.isEmpty) throw StateError('No ticker for $pair');
    return list.first;
  }

  /// Closing prices of the last [limit] candles of [interval]
  /// (e.g. '15m', '1h', '4h', '1d'), oldest first.
  static Future<List<double>> klines(String pair, {String interval = '15m', int limit = 96}) async {
    final data = await _getJson('/api/v3/klines?symbol=$pair&interval=$interval&limit=$limit') as List<dynamic>;
    return <double>[
      for (final k in data) double.tryParse('${(k as List<dynamic>)[4]}') ?? 0,
    ].where((v) => v > 0).toList();
  }
}

// ── Technical indicators (pure, unit-testable) ────────────────────────────────

/// Simple moving average of the last [n] values, or null when fewer exist.
double? sma(List<double> values, int n) {
  if (values.length < n || n <= 0) return null;
  var sum = 0.0;
  for (var i = values.length - n; i < values.length; i++) {
    sum += values[i];
  }
  return sum / n;
}

/// 14-period RSI of a close series, or null when the series is too short.
double? rsi(List<double> closes, {int period = 14}) {
  if (closes.length < period + 1) return null;
  var gain = 0.0;
  var loss = 0.0;
  for (var i = closes.length - period; i < closes.length; i++) {
    final d = closes[i] - closes[i - 1];
    if (d >= 0) {
      gain += d;
    } else {
      loss -= d;
    }
  }
  final avgGain = gain / period;
  final avgLoss = loss / period;
  if (avgLoss == 0) return 100;
  final rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
