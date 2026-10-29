import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../../services/notification_service.dart';
import '../../theme.dart';

/// ---------------------------------------------------------------------------
/// NotificationsSheet — what the Discover header's bell opens. Everything the
/// NotificationService filed while the app was open: likes, comments, shares
/// on my posts, and new posts from people I follow. Opening the sheet marks
/// everything read.
/// ---------------------------------------------------------------------------
Future<void> showNotificationsSheet(BuildContext context) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: context.palette.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (_) => const _NotificationsSheet(),
  );
}

class _NotificationsSheet extends StatefulWidget {
  const _NotificationsSheet();

  @override
  State<_NotificationsSheet> createState() => _NotificationsSheetState();
}

class _NotificationsSheetState extends State<_NotificationsSheet> {
  String? _uid;

  @override
  void initState() {
    super.initState();
    final uid = FirebaseAuth.instance.currentUser?.uid ?? '';
    _uid = uid.isEmpty ? null : uid;
    if (_uid != null) NotificationService.markAllRead(_uid!);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final uid = _uid;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.65,
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(TeamlySpace.s4),
              child: Row(
                children: <Widget>[
                  const Icon(Icons.notifications_rounded, size: 20, color: TeamlyColors.greenText),
                  const SizedBox(width: TeamlySpace.s2),
                  const Text(
                    'Notifications',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded, color: TeamlyColors.ink500),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: uid == null
                  ? const Center(
                      child: Text(
                        'Sign in to see notifications about your posts.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 13.5, color: TeamlyColors.ink500),
                      ),
                    )
                  : StreamBuilder<List<AppNotification>>(
                      stream: NotificationService.stream(uid),
                      builder: (context, snap) {
                        final items = snap.data ?? const <AppNotification>[];
                        if (items.isEmpty) {
                          return Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                Icon(Icons.notifications_off_rounded, size: 36, color: palette.muted),
                                const SizedBox(height: 10),
                                const Text(
                                  'No notifications yet.\nLikes, comments, shares on your posts and\n'
                                  'new posts from people you follow land here.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(fontSize: 13.5, height: 1.5, color: TeamlyColors.ink500),
                                ),
                              ],
                            ),
                          );
                        }
                        return ListView(
                          padding: const EdgeInsets.all(TeamlySpace.gutter),
                          children: <Widget>[
                            for (final n in items)
                              Padding(
                                padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    _NotifAvatar(n: n),
                                    const SizedBox(width: TeamlySpace.s3),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: <Widget>[
                                          Text(
                                            n.headline(),
                                            style: const TextStyle(
                                              fontSize: 13.5,
                                              height: 1.35,
                                              color: TeamlyColors.ink900,
                                            ),
                                          ),
                                          if (n.postPreview.isNotEmpty)
                                            Padding(
                                              padding: const EdgeInsets.only(top: 2),
                                              child: Text(
                                                'on: ${n.postPreview}',
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style: const TextStyle(
                                                  fontSize: 11.5,
                                                  color: TeamlyColors.ink300,
                                                ),
                                              ),
                                            ),
                                          if (n.atMs > 0)
                                            Padding(
                                              padding: const EdgeInsets.only(top: 2),
                                              child: Text(
                                                _relTime(n.atMs),
                                                style: const TextStyle(
                                                  fontSize: 11,
                                                  color: TeamlyColors.ink300,
                                                ),
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                    _KindIcon(kind: n.kind),
                                  ],
                                ),
                              ),
                          ],
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  String _relTime(int ms) {
    final diff = DateTime.now().millisecondsSinceEpoch - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return '${diff ~/ 60000}m ago';
    if (diff < 86400000) return '${diff ~/ 3600000}h ago';
    return '${diff ~/ 86400000}d ago';
  }
}

class _NotifAvatar extends StatelessWidget {
  const _NotifAvatar({required this.n});

  final AppNotification n;

  @override
  Widget build(BuildContext context) {
    if (n.fromPhoto.isNotEmpty) {
      return ClipOval(
        child: Image.network(
          n.fromPhoto,
          width: 32,
          height: 32,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(context),
        ),
      );
    }
    return _initial(context);
  }

  Widget _initial(BuildContext context) {
    return CircleAvatar(
      radius: 16,
      backgroundColor: context.palette.tagBg,
      child: Text(
        n.fromName.isNotEmpty ? n.fromName.substring(0, 1).toUpperCase() : '?',
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: TeamlyColors.greenText,
        ),
      ),
    );
  }
}

class _KindIcon extends StatelessWidget {
  const _KindIcon({required this.kind});

  final String kind;

  @override
  Widget build(BuildContext context) {
    final (icon, color) = switch (kind) {
      'like' => (Icons.favorite_rounded, TeamlyColors.danger),
      'comment' => (Icons.chat_bubble_rounded, TeamlyColors.greenText),
      'share' => (Icons.repeat_rounded, TeamlyColors.ink700),
      'post' => (Icons.edit_note_rounded, TeamlyColors.greenText),
      _ => (Icons.notifications_rounded, TeamlyColors.ink500),
    };
    return Icon(icon, size: 17, color: color);
  }
}
