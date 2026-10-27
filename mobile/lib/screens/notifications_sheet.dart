import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// NotificationsSheet — what the Discover header's bell opens: recent comments
/// on my posts (and my posts' like counts), gathered in bounded queries.
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

class _ActivityItem {
  const _ActivityItem({required this.kind, required this.text, required this.who, required this.whenMs, required this.postPreview});

  final String kind; // 'comment' | 'like'
  final String text;
  final String who;
  final int whenMs;
  final String postPreview;
}

class _NotificationsSheet extends StatefulWidget {
  const _NotificationsSheet();

  @override
  State<_NotificationsSheet> createState() => _NotificationsSheetState();
}

class _NotificationsSheetState extends State<_NotificationsSheet> {
  List<_ActivityItem>? _items;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final me = FirebaseAuth.instance.currentUser?.uid;
    if (me == null || me.isEmpty) {
      if (mounted) setState(() => _items = const <_ActivityItem>[]);
      return;
    }
    final items = <_ActivityItem>[];
    try {
      final myPosts = await FirebaseFirestore.instance
          .collection('posts')
          .where('uid', isEqualTo: me)
          .orderBy('createdAt', descending: true)
          .limit(10)
          .get();
      for (final post in myPosts.docs) {
        final preview = ((post.data()['text'] ?? '') as String);
        final comments = await post.reference.collection('comments').limit(20).get();
        for (final c in comments.docs) {
          final d = c.data();
          items.add(_ActivityItem(
            kind: 'comment',
            text: (d['text'] ?? '') as String,
            who: (d['name'] ?? 'Someone') as String,
            whenMs: (d['createdAt'] as Timestamp?)?.millisecondsSinceEpoch ?? 0,
            postPreview: preview.length > 60 ? preview.substring(0, 60) : preview,
          ));
        }
      }
      items.sort((a, b) => b.whenMs.compareTo(a.whenMs));
    } on FirebaseException catch (_) {
      // Reading notifications is best-effort.
    }
    if (mounted) setState(() => _items = items);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.6,
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
              child: _items == null
                  ? const Center(child: CircularProgressIndicator())
                  : _items!.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Icon(Icons.notifications_off_rounded, size: 36, color: palette.muted),
                              const SizedBox(height: 10),
                              const Text(
                                'No activity yet —\ncomments on your posts will show up here.',
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 13.5, height: 1.5, color: TeamlyColors.ink500),
                              ),
                            ],
                          ),
                        )
                      : ListView(
                          padding: const EdgeInsets.all(TeamlySpace.gutter),
                          children: <Widget>[
                            for (final item in _items!)
                              Padding(
                                padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    CircleAvatar(
                                      radius: 16,
                                      backgroundColor: palette.tagBg,
                                      child: Text(
                                        item.who.isNotEmpty ? item.who.substring(0, 1).toUpperCase() : '?',
                                        style: const TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w700,
                                          color: TeamlyColors.greenText,
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: TeamlySpace.s3),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: <Widget>[
                                          RichText(
                                            text: TextSpan(
                                              style: const TextStyle(
                                                fontSize: 13.5,
                                                height: 1.35,
                                                color: TeamlyColors.ink900,
                                              ),
                                              children: <TextSpan>[
                                                TextSpan(
                                                  text: item.who,
                                                  style: const TextStyle(fontWeight: FontWeight.w700),
                                                ),
                                                const TextSpan(text: ' commented: '),
                                                TextSpan(
                                                  text: item.text,
                                                  style: const TextStyle(color: TeamlyColors.ink700),
                                                ),
                                              ],
                                            ),
                                          ),
                                          if (item.postPreview.isNotEmpty)
                                            Padding(
                                              padding: const EdgeInsets.only(top: 2),
                                              child: Text(
                                                'on: ${item.postPreview}',
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style: const TextStyle(
                                                  fontSize: 11.5,
                                                  color: TeamlyColors.ink300,
                                                ),
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
            ),
          ],
        ),
      ),
    );
  }
}
