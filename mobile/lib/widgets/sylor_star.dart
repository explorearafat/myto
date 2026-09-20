import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

class SylorStar extends StatelessWidget {
  const SylorStar({super.key, this.size = 24, this.color});

  final double size;

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

class PulsingStar extends StatefulWidget {
  const PulsingStar({super.key, this.size = 22, this.color, this.active = true});

  final double size;
  final Color? color;

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
      _controller.value = 0;
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
        final t = curve.value;
        return Opacity(
          opacity: 0.72 + 0.28 * t,
          child: Transform.scale(scale: 0.9 + 0.18 * t, child: child),
        );
      },
    );
  }
}

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
