import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// The Sylor star — Sylor's universal mark, a twelve-ray terracotta sunburst. This is a faithful
/// port of the web/desktop SylorStar geometry (same 24×24 space, same long/short ray Béziers,
/// same #cf5535), drawn with a [CustomPainter] so it needs no asset and stays crisp at any size.
class SylorStar extends StatelessWidget {
  const SylorStar({super.key, this.size = 24, this.color});

  final double size;

  /// Defaults to the universal terracotta so the mark looks identical everywhere.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: size,
      child: CustomPaint(
        painter: _StarPainter(color ?? SylorColors.terracotta),
      ),
    );
  }
}

class _StarPainter extends CustomPainter {
  _StarPainter(this.color);

  final Color color;

  // The two rays in the 24×24 space about the centre (12,12), as two cubic Béziers each —
  // lifted verbatim from SylorStar.tsx (LONG_RAY / SHORT_RAY).
  Path _longRay() => Path()
    ..moveTo(12, 1.4)
    ..cubicTo(12.85, 6, 12.85, 8.4, 12, 11)
    ..cubicTo(11.15, 8.4, 11.15, 6, 12, 1.4)
    ..close();

  Path _shortRay() => Path()
    ..moveTo(12, 4.8)
    ..cubicTo(12.6, 7.4, 12.6, 8.9, 12, 11)
    ..cubicTo(11.4, 8.9, 11.4, 7.4, 12, 4.8)
    ..close();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.fill
      ..isAntiAlias = true;

    // Map the 24-unit design space onto the requested pixel size.
    final scale = size.width / 24.0;
    canvas.save();
    canvas.scale(scale);

    for (var i = 0; i < 12; i++) {
      canvas.save();
      canvas.translate(12, 12);
      canvas.rotate(i * 30 * math.pi / 180);
      canvas.translate(-12, -12);
      canvas.drawPath(i.isEven ? _longRay() : _shortRay(), paint);
      canvas.restore();
    }

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _StarPainter oldDelegate) => oldDelegate.color != color;
}

/// A [SylorStar] that gently "breathes" — a soft scale + opacity pulse — while [active] is true,
/// and sits perfectly still otherwise. Used as the leading mark on an assistant reply while it
/// streams, so the brand itself signals that Sylor is thinking. Falls back to a plain star when
/// idle, so a finished reply shows the same crisp mark as everywhere else.
class PulsingStar extends StatefulWidget {
  const PulsingStar({super.key, this.size = 22, this.color, this.active = true});

  final double size;
  final Color? color;

  /// When true the star pulses; when false it's identical to a plain [SylorStar].
  final bool active;

  @override
  State<PulsingStar> createState() => _PulsingStarState();
}

class _PulsingStarState extends State<PulsingStar> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1150),
  );

  @override
  void initState() {
    super.initState();
    if (widget.active) _controller.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(PulsingStar old) {
    super.didUpdateWidget(old);
    if (widget.active && !_controller.isAnimating) {
      _controller.repeat(reverse: true);
    } else if (!widget.active && _controller.isAnimating) {
      _controller.stop();
      _controller.value = 0; // settle to the resting size
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final star = SylorStar(size: widget.size, color: widget.color);
    if (!widget.active) return star;
    final curve = CurvedAnimation(parent: _controller, curve: Curves.easeInOut);
    return AnimatedBuilder(
      animation: curve,
      child: star,
      builder: (context, child) {
        final t = curve.value; // 0 → 1 → 0
        return Opacity(
          opacity: 0.72 + 0.28 * t,
          child: Transform.scale(scale: 0.9 + 0.18 * t, child: child),
        );
      },
    );
  }
}

/// The [SylorStar] sitting inside a soft terracotta radial glow — a small, calm focal point that
/// gives an otherwise-flat screen some depth. Used on the sign-in gate and the empty chat state.
class SylorStarAura extends StatelessWidget {
  const SylorStarAura({super.key, this.auraSize = 132, this.starSize = 56});

  final double auraSize;
  final double starSize;

  @override
  Widget build(BuildContext context) {
    final accent = Theme.of(context).palette.accent;
    return SizedBox(
      width: auraSize,
      height: auraSize,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: [
                  accent.withValues(alpha: 0.18),
                  accent.withValues(alpha: 0.0),
                ],
              ),
            ),
          ),
          SylorStar(size: starSize, color: accent),
        ],
      ),
    );
  }
}
