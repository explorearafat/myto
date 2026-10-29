/// ---------------------------------------------------------------------------
/// Generated vector avatars.
///
/// Every agent gets a unique disc: a pastel background (from the palette) with
/// a distinct hand-drawn vector emblem. No image assets are needed — each
/// emblem is a [CustomPainter] stroke path, so the whole set ships in code and
/// scales to any size. Index [emblem] into [AgentAvatar.emblems] for the painter.
/// ---------------------------------------------------------------------------
library;

import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../theme.dart';
import 'agent_art_data.dart';

/// Map an agent's `glyph` name to its vector emblem index. Every roster glyph
/// has a distinct emblem; unknown glyphs fall back to the sparkle.
int emblemForGlyph(String glyph) {
  switch (glyph) {
    case 'bug':
      return 0;
    case 'med':
      return 1;
    case 'search':
      return 2;
    case 'code':
      return 3;
    case 'calc':
      return 4;
    case 'chart':
      return 5;
    case 'pen':
      return 6;
    case 'flag':
      return 7;
    case 'data':
      return 8;
    case 'shield':
      return 9;
    case 'spark':
    case 'help':
    default:
      return 10;
  }
}

/// Draws one of the ten roster emblems inside a square of [size] px.
class AgentEmblemPainter extends CustomPainter {
  const AgentEmblemPainter(this.emblem, this.color, {this.size = 64});

  final int emblem;
  final Color color;

  /// The square the emblem is designed for (the painter scales to actual size).
  final double size;

  @override
  void paint(Canvas canvas, Size s) {
    final double scale = s.shortestSide / size;
    canvas.scale(scale, scale);
    final Paint p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4.2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final Paint pFill = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    final Offset c = Offset(size / 2, size / 2);

    switch (emblem) {
      case 0: // QA Tester — clipboard with a check.
        _roundRect(canvas, Offset(size * 0.30, size * 0.24), Offset(size * 0.70, size * 0.76), 6, p);
        canvas.drawLine(Offset(size * 0.50, size * 0.17), Offset(size * 0.50, size * 0.24), p);
        canvas.drawLine(Offset(size * 0.44, size * 0.17), Offset(size * 0.56, size * 0.17), p);
        final Path tick = Path()
          ..moveTo(size * 0.38, size * 0.50)
          ..lineTo(size * 0.47, size * 0.60)
          ..lineTo(size * 0.62, size * 0.40);
        canvas.drawPath(tick, p);

      case 1: // Doctor — a cross in a rounded badge.
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromCenter(center: c, width: size * 0.62, height: size * 0.62),
            Radius.circular(size * 0.12),
          ),
          p,
        );
        canvas.drawLine(Offset(size * 0.40, size * 0.50), Offset(size * 0.60, size * 0.50), p);
        canvas.drawLine(Offset(size * 0.50, size * 0.40), Offset(size * 0.50, size * 0.60), p);

      case 2: // Bug Analyzer — a magnifier over a bug glyph.
        canvas.drawCircle(Offset(size * 0.44, size * 0.42), size * 0.19, p);
        canvas.drawLine(Offset(size * 0.58, size * 0.58), Offset(size * 0.74, size * 0.74), p);
        // legs
        for (final double d in <double>[-0.30, -0.15, 0.15, 0.30]) {
          final Offset o = Offset(size * 0.44 + d * size, size * 0.42);
          canvas.drawLine(o, o.translate(-(d == 0 ? 0 : d.sign) * size * 0.12, size * 0.24), p);
        }

      case 3: // Code Reviewer — code brackets with a check.
        final Path lt = Path()
          ..moveTo(size * 0.36, size * 0.32)
          ..lineTo(size * 0.24, size * 0.50)
          ..lineTo(size * 0.36, size * 0.68);
        final Path gt = Path()
          ..moveTo(size * 0.64, size * 0.32)
          ..lineTo(size * 0.76, size * 0.50)
          ..lineTo(size * 0.64, size * 0.68);
        canvas.drawPath(lt, p);
        canvas.drawPath(gt, p);
        final Path tick = Path()
          ..moveTo(size * 0.42, size * 0.52)
          ..lineTo(size * 0.49, size * 0.60)
          ..lineTo(size * 0.58, size * 0.42);
        canvas.drawPath(tick, p);

      case 4: // Accounting — calculator.
        _roundRect(canvas, Offset(size * 0.30, size * 0.22), Offset(size * 0.70, size * 0.78), 6, p);
        canvas.drawLine(Offset(size * 0.36, size * 0.34), Offset(size * 0.64, size * 0.34), p);
        for (final double x in <double>[0.42, 0.50, 0.58]) {
          for (final double y in <double>[0.48, 0.60, 0.72]) {
            canvas.drawCircle(Offset(size * x, size * y), size * 0.022, pFill);
          }
        }

      case 5: // Market Researcher — trending chart.
        final Path axis = Path()
          ..moveTo(size * 0.24, size * 0.78)
          ..lineTo(size * 0.76, size * 0.78);
        canvas.drawPath(axis, p);
        final Path trend = Path()
          ..moveTo(size * 0.28, size * 0.62)
          ..lineTo(size * 0.42, size * 0.50)
          ..lineTo(size * 0.54, size * 0.56)
          ..lineTo(size * 0.72, size * 0.34);
        canvas.drawPath(trend, p);
        canvas.drawLine(Offset(size * 0.72, size * 0.34), Offset(size * 0.64, size * 0.34), p);
        canvas.drawLine(Offset(size * 0.72, size * 0.34), Offset(size * 0.72, size * 0.42), p);

      case 6: // UX Designer — a pen nib / layout diamond.
        final Path nib = Path()
          ..moveTo(size * 0.50, size * 0.22)
          ..lineTo(size * 0.74, size * 0.50)
          ..lineTo(size * 0.50, size * 0.78)
          ..lineTo(size * 0.26, size * 0.50)
          ..close();
        canvas.drawPath(nib, p);
        canvas.drawLine(Offset(size * 0.50, size * 0.42), Offset(size * 0.50, size * 0.58), p);

      case 7: // Project Manager — flag on a milestone.
        canvas.drawLine(Offset(size * 0.34, size * 0.22), Offset(size * 0.34, size * 0.80), p);
        final Path flag = Path()
          ..moveTo(size * 0.34, size * 0.26)
          ..lineTo(size * 0.66, size * 0.34)
          ..lineTo(size * 0.34, size * 0.44)
          ..close();
        canvas.drawPath(flag, pFill);
        canvas.drawLine(Offset(size * 0.34, size * 0.52), Offset(size * 0.62, size * 0.56), p);

      case 8: // Data Scientist — scatter plot with a fitted line.
        for (final Offset o in <Offset>[
          Offset(size * 0.32, size * 0.58),
          Offset(size * 0.42, size * 0.46),
          Offset(size * 0.54, size * 0.52),
          Offset(size * 0.64, size * 0.38),
        ]) {
          canvas.drawCircle(o, size * 0.03, pFill);
        }
        canvas.drawLine(Offset(size * 0.26, size * 0.68), Offset(size * 0.72, size * 0.32), p);

      case 9: // Security Analyst — shield with a keyhole.
        final Path shield = Path()
          ..moveTo(size * 0.50, size * 0.20)
          ..lineTo(size * 0.74, size * 0.28)
          ..lineTo(size * 0.72, size * 0.52)
          ..quadraticBezierTo(size * 0.70, size * 0.70, size * 0.50, size * 0.80)
          ..quadraticBezierTo(size * 0.30, size * 0.70, size * 0.28, size * 0.52)
          ..lineTo(size * 0.26, size * 0.28)
          ..close();
        canvas.drawPath(shield, p);
        canvas.drawCircle(Offset(size * 0.50, size * 0.44), size * 0.07, p);
        canvas.drawLine(Offset(size * 0.50, size * 0.50), Offset(size * 0.50, size * 0.62), p);

      default: // Fallback — a friendly sparkle.
        final Path spark = Path()
          ..moveTo(size * 0.50, size * 0.24)
          ..lineTo(size * 0.56, size * 0.44)
          ..lineTo(size * 0.76, size * 0.50)
          ..lineTo(size * 0.56, size * 0.56)
          ..lineTo(size * 0.50, size * 0.76)
          ..lineTo(size * 0.44, size * 0.56)
          ..lineTo(size * 0.24, size * 0.50)
          ..lineTo(size * 0.44, size * 0.44)
          ..close();
        canvas.drawPath(spark, pFill);
    }
  }

  void _roundRect(
    Canvas canvas,
    Offset a,
    Offset b,
    double radius,
    Paint p,
  ) {
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromPoints(a, b),
        Radius.circular(radius),
      ),
      p,
    );
  }

  @override
  bool shouldRepaint(covariant AgentEmblemPainter old) =>
      old.emblem != emblem || old.color != color || old.size != size;
}

/// The agent's profile picture. Three sources, chosen by the [AgentAvatar.artId]
/// scheme:
///
///   'asset:<name>'  — a bundled mascot portrait (assets/agents/chat/<name>.jpg)
///   'file:<path>'   — a photo the user uploaded (copied into app storage)
///   anything else   — a hand-drawn face from [kAgentArtIndex]
///
/// An unknown [artId] falls back to the neutral vector emblem rather than an
/// empty hole, so a user-built agent always has a face.
class AgentAvatar extends StatelessWidget {
  const AgentAvatar({
    super.key,
    required this.artId,
    this.size = 44,
    this.dot = false,
  });

  /// Which face this agent wears.
  final String artId;
  final double size;

  /// The small presence dot in the bottom-right corner.
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final Widget inner;
    if (artId.startsWith('asset:')) {
      inner = Image.asset(
        'assets/agents/chat/${artId.substring(6)}.jpg',
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => _AvatarFallback(size: size),
      );
    } else if (artId.startsWith('file:')) {
      inner = Image.file(
        File(artId.substring(5)),
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => _AvatarFallback(size: size),
      );
    } else {
      final AgentArt? art = kAgentArtIndex[artId];
      inner = art == null
          ? _AvatarFallback(size: size)
          : SvgPicture.string(
              art.svg,
              width: size,
              height: size,
              fit: BoxFit.cover,
            );
    }

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          ClipOval(child: inner),
          if (dot)
            Positioned(
              right: 0,
              bottom: 0,
              child: Container(
                width: size * 0.26,
                height: size * 0.26,
                decoration: BoxDecoration(
                  color: TeamlyColors.green500,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: Theme.of(context).scaffoldBackgroundColor,
                    width: 2,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Neutral stand-in for an agent whose [AgentAvatar.artId] is not in the
/// library — a user-built agent, or art added in a newer build.
class _AvatarFallback extends StatelessWidget {
  const _AvatarFallback({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    final Color ink = Theme.of(context).brightness == Brightness.dark
        ? const Color(0xFFE8ECF3)
        : const Color(0xFF3A4149);

    return Container(
      width: size,
      height: size,
      color: context.palette.pastel(0),
      child: CustomPaint(
        painter: AgentEmblemPainter(10, ink, size: size * 0.72),
      ),
    );
  }
}

/// A deterministic pseudo-random generator so the doodle backdrop stays
/// identical between builds (no flicker when the keyboard opens).
class SeededRandom {
  SeededRandom(this._seed);

  int _seed;

  double next() {
    _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
    return _seed / 0x7fffffff;
  }
}

/// A faint, hand-drawn doodle wall — the same vibe as the sketchy pattern on
/// the classic chat wallpaper: stars, hearts, swirls, squiggles and flowers,
/// drawn once as vector paths at very low opacity behind the transcript.
class DoodleBackground extends StatelessWidget {
  const DoodleBackground({super.key, this.opacity = 0.05});

  final double opacity;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: IgnorePointer(
        child: CustomPaint(
          painter: _DoodlePainter(
            color: Theme.of(context).brightness == Brightness.dark
                ? const Color(0xFFFFFFFF)
                : const Color(0xFF111727),
            opacity: opacity,
          ),
        ),
      ),
    );
  }
}

class _DoodlePainter extends CustomPainter {
  _DoodlePainter({required this.color, required this.opacity});

  final Color color;
  final double opacity;

  /// Spacing of the jittered lattice, in logical pixels. Small enough that
  /// neighbouring doodles nearly touch — the wall reads as a dense hand-drawn
  /// texture rather than a sparse scatter.
  static const double _kCell = 20.0;

  @override
  void paint(Canvas canvas, Size s) {
    if (s.isEmpty) return;
    final math.Random rng = math.Random(7);
    final Paint p = Paint()
      ..color = color.withValues(alpha: opacity)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round;

    // A jittered lattice instead of pure-random scatter: every cell of the
    // canvas claims one doodle, so coverage stays uniformly packed with only
    // a sliver of gap between neighbours at any screen size (a phone display
    // draws ~800 of them vs. the handful a plain random pass would give).
    final int cols = (s.width / _kCell).ceil();
    final int rows = (s.height / _kCell).ceil();
    int i = 0;
    for (int r = 0; r < rows; r++) {
      for (int c = 0; c < cols; c++) {
        final double x = (c + 0.5 + (rng.nextDouble() - 0.5) * 0.7) * _kCell;
        final double y = (r + 0.5 + (rng.nextDouble() - 0.5) * 0.7) * _kCell;
        final double scale = 0.7 + rng.nextDouble() * 0.6;
        final int kind = i % 5;
        i++;
        canvas.save();
        canvas.translate(x, y);
        canvas.scale(scale, scale);
        switch (kind) {
          case 0: // star
            _star(canvas, p, 6);
          case 1: // heart
            _heart(canvas, p);
          case 2: // spiral
            _spiral(canvas, p);
          case 3: // squiggle
            _squiggle(canvas, p);
          default: // flower
            _flower(canvas, p);
        }
        canvas.restore();
      }
    }
  }

  void _star(Canvas canvas, Paint p, double r) {
    final Path path = Path();
    for (int i = 0; i < 10; i++) {
      final double rad = i.isEven ? r : r * 0.45;
      final double a = i * math.pi / 5 - math.pi / 2;
      final Offset o = Offset(math.cos(a) * rad, math.sin(a) * rad);
      if (i == 0) {
        path.moveTo(o.dx, o.dy);
      } else {
        path.lineTo(o.dx, o.dy);
      }
    }
    path.close();
    canvas.drawPath(path, p);
  }

  void _heart(Canvas canvas, Paint p) {
    final Path path = Path()
      ..moveTo(0, 4)
      ..cubicTo(-6, -2, -2, -8, 0, -5)
      ..cubicTo(2, -8, 6, -2, 0, 4);
    canvas.drawPath(path, p);
  }

  void _spiral(Canvas canvas, Paint p) {
    final Path path = Path();
    const int turns = 2;
    const int steps = 40;
    for (int i = 0; i <= steps; i++) {
      final double t = i / steps;
      final double a = t * turns * 2 * math.pi;
      final double r = 0.2 + t * 5.4;
      final Offset o = Offset(math.cos(a) * r, math.sin(a) * r);
      if (i == 0) {
        path.moveTo(o.dx, o.dy);
      } else {
        path.lineTo(o.dx, o.dy);
      }
    }
    canvas.drawPath(path, p);
  }

  void _squiggle(Canvas canvas, Paint p) {
    final Path path = Path()
      ..moveTo(-7, 0)
      ..cubicTo(-3, -5, -1, 5, 3, 0)
      ..cubicTo(5, -3, 6, 3, 8, 0);
    canvas.drawPath(path, p);
  }

  void _flower(Canvas canvas, Paint p) {
    for (int i = 0; i < 5; i++) {
      final double a = i * 2 * math.pi / 5;
      canvas.drawCircle(
        Offset(math.cos(a) * 3.2, math.sin(a) * 3.2),
        1.8,
        p,
      );
    }
    canvas.drawCircle(Offset.zero, 1.2, p);
  }

  @override
  bool shouldRepaint(covariant _DoodlePainter old) =>
      old.color != color || old.opacity != opacity;
}
