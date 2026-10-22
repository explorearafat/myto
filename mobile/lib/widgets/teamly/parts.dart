import 'package:flutter/material.dart';

import '../../models/agent.dart';
import '../../models/memory.dart';
import '../../theme.dart';
import 'kit.dart';

/// ---------------------------------------------------------------------------
/// The repeating row-level pieces of the reference UI: avatar discs, stacked
/// avatars, colour topic tiles, the agent row card and the wiki doc row.
///
/// These are separated from [kit.dart] because they carry domain meaning (an
/// [Agent], a [WikiDoc]) whereas the kit is domain-free.
/// ---------------------------------------------------------------------------

/// A circular avatar. In the reference every entity that can be talked to has
/// one: a pastel disc with a flat mascot, and optionally a small green dot in
/// the corner for the social state ("friends", "connected").
///
/// We draw the mascot as a simple rounded face rather than shipping art, so the
/// row never depends on an asset that might be missing — and it keeps the
/// pastel-disc language the reference uses.
class TeamlyAvatar extends StatelessWidget {
  const TeamlyAvatar({
    super.key,
    required this.pastelIndex,
    this.size = 48,
    this.dot = false,
    this.badgeIcon,
  });

  final int pastelIndex;
  final double size;

  /// The green corner dot — relationship / connected state.
  final bool dot;

  /// Optional tiny badge glyph in the corner (the YouTube mark on Little T).
  final IconData? badgeIcon;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final fill = palette.pastel(pastelIndex);
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              color: fill,
              shape: BoxShape.circle,
              border: Border.all(color: palette.surface, width: size > 40 ? 2 : 1.5),
            ),
            child: _Mascot(size: size * 0.52, color: TeamlyColors.ink800),
          ),
          if (dot)
            Positioned(
              right: -1,
              bottom: -1,
              child: Container(
                width: size * 0.3,
                height: size * 0.3,
                decoration: BoxDecoration(
                  color: palette.accent,
                  shape: BoxShape.circle,
                  border: Border.all(color: palette.surface, width: 1.5),
                ),
              ),
            ),
          if (badgeIcon != null)
            Positioned(
              right: -2,
              bottom: -2,
              child: Container(
                width: size * 0.42,
                height: size * 0.42,
                decoration: BoxDecoration(
                  color: palette.surface,
                  shape: BoxShape.circle,
                  border: Border.all(color: palette.border),
                ),
                child: Icon(badgeIcon, size: size * 0.24, color: TeamlyColors.ink700),
              ),
            ),
        ],
      ),
    );
  }
}

/// Two overlapping discs — the group-chat avatar. A team room is readable from
/// its avatar alone in the reference, which is good information design.
class TeamlyStackedAvatars extends StatelessWidget {
  const TeamlyStackedAvatars({super.key, required this.pastelIndices, this.size = 48});

  final List<int> pastelIndices;
  final double size;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final shown = pastelIndices.take(2).toList();
    final step = size * 0.42;
    return SizedBox(
      width: size + (shown.length > 1 ? step : 0),
      height: size,
      child: Stack(
        children: <Widget>[
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * step,
              child: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: palette.surface, width: 2),
                ),
                child: TeamlyAvatar(pastelIndex: shown[shown.length - 1 - i], size: size),
              ),
            ),
        ],
      ),
    );
  }
}

/// The simple flat mascot drawn inside an avatar disc: a rounded "screen face"
/// with two eyes. Deliberately plain — it reads correctly at 24px and needs no
/// bundled artwork.
class _Mascot extends StatelessWidget {
  const _Mascot({required this.size, required this.color});

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SizedBox(
        width: size,
        height: size * 0.86,
        child: CustomPaint(painter: _MascotPainter(color)),
      ),
    );
  }
}

class _MascotPainter extends CustomPainter {
  _MascotPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.11
      ..strokeCap = StrokeCap.round
      ..isAntiAlias = true;

    // Head: a rounded rectangle.
    final head = RRect.fromRectAndRadius(
      Rect.fromLTWH(0, size.height * 0.12, size.width, size.height * 0.74),
      Radius.circular(size.width * 0.26),
    );
    canvas.drawRRect(head, stroke);

    // Antenna.
    final cx = size.width / 2;
    canvas.drawLine(
      Offset(cx, size.height * 0.12),
      Offset(cx, 0),
      stroke,
    );

    // Two eyes.
    final eye = Paint()
      ..color = color
      ..style = PaintingStyle.fill
      ..isAntiAlias = true;
    final r = size.width * 0.1;
    canvas.drawCircle(Offset(size.width * 0.32, size.height * 0.46), r, eye);
    canvas.drawCircle(Offset(size.width * 0.68, size.height * 0.46), r, eye);

    // Mouth — a short arc.
    final mouth = Path()
      ..moveTo(size.width * 0.34, size.height * 0.68)
      ..quadraticBezierTo(cx, size.height * 0.8, size.width * 0.66, size.height * 0.68);
    canvas.drawPath(mouth, stroke);
  }

  @override
  bool shouldRepaint(_MascotPainter old) => old.color != color;
}

/// A solid-colour square tile with a white glyph — the Memory system pages
/// (Overview, My Profile, Next Actions, My Artifacts). The only place in the app
/// where a large block of accent colour is allowed.
class TeamlyTopicTile extends StatelessWidget {
  const TeamlyTopicTile({
    super.key,
    required this.accentIndex,
    required this.icon,
    this.size = 52,
  });

  final int accentIndex;
  final IconData icon;
  final double size;

  @override
  Widget build(BuildContext context) {
    final accent = TeamlyColors.topicAccents[accentIndex % TeamlyColors.topicAccents.length];
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: accent,
        borderRadius: BorderRadius.circular(TeamlyRadius.md),
      ),
      child: Icon(icon, size: size * 0.46, color: Colors.white),
    );
  }
}

/// The agent row card — the single most repeated component in the app.
///
/// `[pastel avatar]  Title / description        [Chat]`
///
/// The reference is identical in every row: pastel disc, bold role title, a
/// resume-style one-liner in grey, and a green Chat pill on the right, which is
/// why the agents read as *colleagues* rather than features.
class TeamlyAgentCard extends StatelessWidget {
  const TeamlyAgentCard({
    super.key,
    required this.agent,
    required this.onChat,
    this.onTap,
  });

  final Agent agent;
  final VoidCallback onChat;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return TeamlyCard(
      onTap: onTap,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          TeamlyAvatar(pastelIndex: agent.pastelIndex, size: 64, dot: agent.friends),
          const SizedBox(width: TeamlySpace.s4),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  agent.name,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    height: 1.25,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  agent.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: TeamlyColors.ink500,
                    fontSize: 14,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: TeamlySpace.s3),
          TeamlyPillButton(label: 'Chat', compact: true, onPressed: onChat),
        ],
      ),
    );
  }
}

/// One wiki page row: title, truncated subtitle, meta line and tags. A `NEW`
/// dot marks a page that arrived while you were away — the same signal as the
/// nav badge and the `Updates n` chip.
class TeamlyDocRow extends StatelessWidget {
  const TeamlyDocRow({super.key, required this.doc, required this.onTap});

  final WikiDoc doc;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return TeamlyCard(
      onTap: onTap,
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (doc.isNew)
                Container(
                  margin: const EdgeInsets.only(top: 6, right: 8),
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: palette.accent,
                    shape: BoxShape.circle,
                  ),
                ),
              Expanded(
                child: Text(
                  doc.title,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    height: 1.3,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            doc.subtitle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.4),
          ),
          const SizedBox(height: TeamlySpace.s3),
          Wrap(
            spacing: TeamlySpace.s2,
            runSpacing: TeamlySpace.s1,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              Text(
                doc.relativeUpdated,
                style: const TextStyle(color: TeamlyColors.ink300, fontSize: 12),
              ),
              for (final t in doc.tags)
                Text(
                  '#$t',
                  style: const TextStyle(
                    color: TeamlyColors.ink300,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}