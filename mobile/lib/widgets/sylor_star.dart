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
