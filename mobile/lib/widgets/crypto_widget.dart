import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../services/binance_service.dart';
import '../theme.dart';

/// ---------------------------------------------------------------------------
/// The live crypto widgets the feed embeds in CryptoExpert's posts.
///
/// A post carries a `[[crypto:BTCUSDT]]` marker; DiscoverScreen renders
/// [CryptoMiniCard] in its place — coin logo, live price, 24h change badge and
/// a sparkline of the last 24h (96 × 15m closes), refreshed every 45s. Tapping
/// opens [showCryptoSheet], the full chart with 1H/1D/1W/1M ranges and
/// High/Low/Volume stats — the mobile port of the Live Crypto Tracker page.
///
/// Chart data lives per-widget in state; the REST layer (BinanceService) does
/// the host-fallback so a blocked host never blanks a card.
/// ---------------------------------------------------------------------------

/// Extract the first `[[crypto:PAIR]]` marker from a post body.
final RegExp kCryptoMarkerRe = RegExp(r'\[\[crypto:([A-Z0-9]+USDT)\]\]');

String? cryptoMarkerPair(String text) => kCryptoMarkerRe.firstMatch(text)?.group(1);

/// Text with every `[[crypto:…]]` marker removed (the marker renders as a widget).
String stripCryptoMarkers(String text) => text.replaceAll(kCryptoMarkerRe, '').trim();

class CryptoMiniCard extends StatefulWidget {
  const CryptoMiniCard({super.key, required this.pair});

  final String pair;

  @override
  State<CryptoMiniCard> createState() => _CryptoMiniCardState();
}

class _CryptoMiniCardState extends State<CryptoMiniCard> {
  Ticker24? _tick;
  List<double> _spark = const <double>[];
  bool _failed = false;
  Timer? _timer;

  CoinDef? get _coin => coinBySymbol(widget.pair.replaceAll('USDT', ''));

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 45), (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final tick = await BinanceService.ticker(widget.pair);
      List<double> spark = _spark;
      if (_spark.isEmpty) {
        spark = await BinanceService.klines(widget.pair, interval: '15m', limit: 96);
      }
      if (!mounted) return;
      setState(() {
        _tick = tick;
        _spark = spark;
        _failed = false;
      });
    } catch (_) {
      if (!mounted || _tick != null) return;
      setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final coin = _coin;
    final tick = _tick;
    final up = (tick?.changePct ?? 0) >= 0;
    final color = up ? const Color(0xFF16C784) : const Color(0xFFEA3943);

    return GestureDetector(
      onTap: tick == null ? null : () => showCryptoSheet(context, widget.pair),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.md),
          border: Border.all(color: palette.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                _CoinLogo(symbol: coin?.symbol ?? widget.pair, url: coin?.logoUrl),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        '${coin?.name ?? widget.pair} · ${widget.pair}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: TeamlyColors.ink900,
                        ),
                      ),
                      Text(
                        _failed ? 'Market data unavailable' : 'Live · Binance',
                        style: TextStyle(
                          fontSize: 11,
                          color: _failed ? TeamlyColors.ink300 : TeamlyColors.greenText,
                        ),
                      ),
                    ],
                  ),
                ),
                if (tick != null) ...<Widget>[
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      Text(
                        fmtPrice(tick.price),
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          color: TeamlyColors.ink900,
                          fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                        ),
                      ),
                      Container(
                        margin: const EdgeInsets.only(top: 2),
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          '${tick.changePct >= 0 ? '+' : ''}${tick.changePct.toStringAsFixed(2)}%',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: color,
                          ),
                        ),
                      ),
                    ],
                  ),
                ] else
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            if (_spark.length >= 2) ...<Widget>[
              const SizedBox(height: 10),
              SizedBox(
                height: 56,
                width: double.infinity,
                child: CustomPaint(
                  painter: SparklinePainter(
                    values: _spark,
                    color: color,
                    fill: true,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The round coin logo (CDN art, letter fallback).
class _CoinLogo extends StatelessWidget {
  const _CoinLogo({required this.symbol, required this.url});

  final String symbol;
  final String? url;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: Container(
        width: 36,
        height: 36,
        color: context.palette.surface,
        alignment: Alignment.center,
        child: (url == null || url!.isEmpty)
            ? _letter()
            : Image.network(
                url!,
                width: 36,
                height: 36,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => _letter(),
              ),
      ),
    );
  }

  Widget _letter() => Text(
        symbol.isEmpty ? '?' : symbol.substring(0, 1),
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: TeamlyColors.ink700),
      );
}

/// The sparkline: a smooth polyline over the close series with a gradient
/// fill beneath — the same shape as the tracker page's SVG.
class SparklinePainter extends CustomPainter {
  const SparklinePainter({
    required this.values,
    required this.color,
    this.fill = true,
    this.strokeWidth = 2,
  });

  final List<double> values;
  final Color color;
  final bool fill;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;
    final minV = values.reduce(math.min);
    final maxV = values.reduce(math.max);
    final range = (maxV - minV) == 0 ? 1.0 : maxV - minV;
    final dx = size.width / (values.length - 1);
    Offset point(int i) => Offset(
          i * dx,
          size.height - 4 - ((values[i] - minV) / range) * (size.height - 8),
        );

    final path = Path()..moveTo(point(0).dx, point(0).dy);
    for (var i = 1; i < values.length; i++) {
      path.lineTo(point(i).dx, point(i).dy);
    }

    if (fill) {
      final fillPath = Path.from(path)
        ..lineTo(size.width, size.height)
        ..lineTo(0, size.height)
        ..close();
      final fillPaint = Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[color.withValues(alpha: 0.30), color.withValues(alpha: 0.0)],
        ).createShader(Offset.zero & size);
      canvas.drawPath(fillPath, fillPaint);
    }

    final line = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeJoin = StrokeJoin.round
      ..strokeCap = StrokeCap.round
      ..isAntiAlias = true;
    canvas.drawPath(path, line);
  }

  @override
  bool shouldRepaint(SparklinePainter old) =>
      old.color != color || old.values.length != values.length || old.fill != fill;
}

/// The full-screen chart sheet: big line chart with 1H/1D/1W/1M ranges and
/// 24h High/Low/Volume stats (the tracker page's modal, in Flutter).
Future<void> showCryptoSheet(BuildContext context, String pair) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.palette.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (_) => _CryptoSheet(pair: pair),
  );
}

class _CryptoSheet extends StatefulWidget {
  const _CryptoSheet({required this.pair});

  final String pair;

  @override
  State<_CryptoSheet> createState() => _CryptoSheetState();
}

class _CryptoSheetState extends State<_CryptoSheet> {
  /// (label, kline interval, candle count) — same ranges as the tracker.
  static const List<(String, String, int)> _ranges = <(String, String, int)>[
    ('1H', '1m', 60),
    ('1D', '15m', 96),
    ('1W', '1h', 168),
    ('1M', '4h', 180),
  ];

  String _range = '1D';
  Ticker24? _tick;
  List<double> _series = const <double>[];
  bool _loading = true;
  bool _failed = false;
  Timer? _timer;

  CoinDef? get _coin => coinBySymbol(widget.pair.replaceAll('USDT', ''));

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _loadTickerOnly());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _loadTickerOnly() async {
    try {
      final tick = await BinanceService.ticker(widget.pair);
      if (!mounted) return;
      setState(() => _tick = tick);
    } catch (_) {}
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final tick = await BinanceService.ticker(widget.pair);
      final range = _ranges.firstWhere((r) => r.$1 == _range);
      final series = await BinanceService.klines(widget.pair, interval: range.$2, limit: range.$3);
      if (!mounted) return;
      setState(() {
        _tick = tick;
        _series = series;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final coin = _coin;
    final tick = _tick;
    final up = (tick?.changePct ?? 0) >= 0;
    final color = up ? const Color(0xFF16C784) : const Color(0xFFEA3943);

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.all(TeamlySpace.s5),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                _CoinLogo(symbol: coin?.symbol ?? widget.pair, url: coin?.logoUrl ?? ''),
                const SizedBox(width: TeamlySpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        coin?.name ?? widget.pair,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
                      ),
                      Text('${widget.pair} · Binance', style: const TextStyle(fontSize: 12, color: TeamlyColors.ink500)),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded, size: 22, color: TeamlyColors.ink500),
                ),
              ],
            ),
            const SizedBox(height: TeamlySpace.s3),
            if (tick != null) ...<Widget>[
              Text(
                fmtPrice(tick.price),
                style: TextStyle(
                  fontSize: 30,
                  fontWeight: FontWeight.w800,
                  color: TeamlyColors.ink900,
                  fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
                ),
              ),
              Text(
                '${tick.changePct >= 0 ? '+' : ''}${tick.changePct.toStringAsFixed(2)}% (24h)',
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: color),
              ),
            ],
            const SizedBox(height: TeamlySpace.s3),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                for (final r in _ranges)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: GestureDetector(
                      onTap: () {
                        setState(() => _range = r.$1);
                        _load();
                      },
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                        decoration: BoxDecoration(
                          color: _range == r.$1 ? palette.accent : palette.chip,
                          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                        ),
                        child: Text(
                          r.$1,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: _range == r.$1 ? palette.onAccent : TeamlyColors.ink500,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: TeamlySpace.s3),
            SizedBox(
              height: 240,
              width: double.infinity,
              child: _loading
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : _failed || _series.length < 2
                      ? const Center(
                          child: Text(
                            'Failed to load chart',
                            style: TextStyle(color: TeamlyColors.ink300, fontSize: 13),
                          ),
                        )
                      : CustomPaint(
                          painter: _BigChartPainter(values: _series, color: color),
                        ),
            ),
            const SizedBox(height: TeamlySpace.s3),
            if (tick != null)
              Row(
                children: <Widget>[
                  _stat(context, '24h High', fmtPrice(tick.high)),
                  _stat(context, '24h Low', fmtPrice(tick.low)),
                  _stat(context, '24h Volume', _compactUsd(tick.volume)),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _stat(BuildContext context, String label, String value) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: context.palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.sm),
        ),
        child: Column(
          children: <Widget>[
            Text(label, style: const TextStyle(fontSize: 10.5, color: TeamlyColors.ink500)),
            const SizedBox(height: 2),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
            ),
          ],
        ),
      ),
    );
  }

  String _compactUsd(double n) {
    if (n >= 1e9) return '\$${(n / 1e9).toStringAsFixed(2)}B';
    if (n >= 1e6) return '\$${(n / 1e6).toStringAsFixed(2)}M';
    if (n >= 1e3) return '\$${(n / 1e3).toStringAsFixed(1)}K';
    return '\$${n.toStringAsFixed(0)}';
  }
}

/// The big chart: line + gradient fill + light horizontal grid with price
/// labels, like the tracker page's modal SVG.
class _BigChartPainter extends CustomPainter {
  const _BigChartPainter({required this.values, required this.color});

  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;
    const padT = 12.0;
    const padB = 18.0;
    final minV = values.reduce(math.min);
    final maxV = values.reduce(math.max);
    final range = (maxV - minV) == 0 ? 1.0 : maxV - minV;
    final dx = size.width / (values.length - 1);
    double y(double v) => padT + (1 - (v - minV) / range) * (size.height - padT - padB);

    // Grid: five dashed lines with price labels.
    final grid = Paint()
      ..color = const Color(0x1A111727)
      ..strokeWidth = 1;
    for (var i = 0; i < 5; i++) {
      final v = maxV - i * range / 4;
      final gy = y(v);
      final dash = Path();
      for (double x = 0; x < size.width; x += 12) {
        dash.moveTo(x, gy);
        dash.lineTo(math.min(x + 5, size.width), gy);
      }
      canvas.drawPath(dash, grid);
      TextPainter(
        text: TextSpan(text: fmtPrice(v), style: const TextStyle(fontSize: 9.5, color: TeamlyColors.ink300)),
        textDirection: TextDirection.ltr,
      )
        ..layout()
        ..paint(canvas, Offset(2, gy - 12));
    }

    final path = Path()..moveTo(0, y(values.first));
    for (var i = 1; i < values.length; i++) {
      path.lineTo(i * dx, y(values[i]));
    }
    final fillPath = Path.from(path)
      ..lineTo(size.width, size.height - padB)
      ..lineTo(0, size.height - padB)
      ..close();
    canvas.drawPath(
      fillPath,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[color.withValues(alpha: 0.28), color.withValues(alpha: 0.0)],
        ).createShader(Offset.zero & size),
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.2
        ..strokeJoin = StrokeJoin.round
        ..isAntiAlias = true,
    );
  }

  @override
  bool shouldRepaint(_BigChartPainter old) =>
      old.color != color || old.values.length != values.length;
}
