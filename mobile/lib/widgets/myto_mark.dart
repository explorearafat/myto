import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// The Myto mark: a monochrome mitochondria — a tilted, organic bean with a double membrane and four
/// rounded finger-like cristae — drawn with a CustomPainter so it stays crisp at any size and picks up
/// the theme's ink/near-white accent. Same geometry as the web/desktop surfaces (512×512 frame,
/// rotated 12° clockwise about the centre).
class MytoMark extends StatelessWidget {
  const MytoMark({super.key, this.size = 24, this.color});

  final double size;

  /// Stroke colour. Defaults to the theme's accent (ink on light, near-white on dark) so the mark
  /// reads on either surface.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? Theme.of(context).palette.accent;
    return SizedBox.square(
      dimension: size,
      child: CustomPaint(
        painter: _MarkPainter(c),
      ),
    );
  }
}

class _MarkPainter extends CustomPainter {
  _MarkPainter(this.color);

  final Color color;

  @override
  void paint(Canvas c, Size size) {
    final u = size.width / 512.0;
    c.save();
    c.translate(size.width / 2, size.height / 2);
    c.rotate(12 * math.pi / 180);
    c.translate(-256 * u, -256 * u);
    final p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..isAntiAlias = true;

    // f = [startX, startY, then groups of six: c1x, c1y, c2x, c2y, endX, endY].
    Path cubicPath(List<num> f) {
      final path = Path()..moveTo(f[0] * u, f[1] * u);
      for (var i = 2; i + 5 < f.length; i += 6) {
        path.cubicTo(f[i] * u, f[i + 1] * u, f[i + 2] * u, f[i + 3] * u, f[i + 4] * u, f[i + 5] * u);
      }
      return path;
    }

    // Double membrane: two continuous organic bean contours (the mitochondrion's two membranes).
    p.strokeWidth = 17 * u;
    c.drawPath(
      cubicPath([100, 260, 100, 212, 134, 178, 182, 170, 214, 165, 234, 187, 258, 193, 284, 199, 302, 170, 342, 168, 394, 166, 436, 202, 434, 254, 432, 306, 398, 348, 344, 356, 302, 362, 282, 368, 252, 368, 194, 368, 132, 354, 110, 320, 97, 300, 98, 282, 100, 260])..close(),
      p,
    );
    p.strokeWidth = 13 * u;
    c.drawPath(
      cubicPath([142, 258, 142, 224, 168, 204, 202, 199, 228, 195, 244, 209, 266, 214, 288, 219, 302, 200, 330, 200, 366, 200, 394, 222, 392, 256, 390, 292, 366, 320, 328, 326, 300, 330, 284, 334, 258, 334, 214, 334, 174, 324, 156, 302, 143, 288, 142, 274, 142, 258])..close(),
      p,
    );
    // Four rounded finger-like cristae folding in from the lower membrane wall.
    for (final f in [
      [14, 184, 300, 172, 274, 176, 244, 192, 224],
      [15, 216, 312, 206, 282, 210, 242, 226, 216],
      [14, 250, 312, 244, 284, 254, 248, 272, 226],
      [13, 286, 302, 282, 282, 292, 262, 310, 248],
    ]) {
      p.strokeWidth = f[0] * u;
      c.drawPath(cubicPath(f.sublist(1)), p);
    }
    c.restore();
  }

  @override
  bool shouldRepaint(covariant _MarkPainter oldDelegate) => oldDelegate.color != color;
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
    final mark = MytoMark(size: widget.size, color: widget.color);
    if (!widget.active) return mark;
    final curve = CurvedAnimation(parent: _controller, curve: Curves.easeInOut);
    return AnimatedBuilder(
      animation: curve,
      child: mark,
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

class MytoMarkAura extends StatelessWidget {
  const MytoMarkAura({super.key, this.auraSize = 132, this.starSize = 56});

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
          MytoMark(size: starSize, color: accent),
        ],
      ),
    );
  }
}
