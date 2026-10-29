import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/dm_service.dart';
import '../services/notification_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import 'dm_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// MessagesScreen — the 1-to-1 inbox, opened from Discover's message icon.
/// WhatsApp-style flat rows: avatar · name (with the blue tick for verified
/// accounts) · last message · time. Opening the list also sweeps my aged-out
/// messages across every thread (the 24-hour retention).
/// ---------------------------------------------------------------------------
class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key});

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  final Map<String, DiscoverProfile?> _profiles = <String, DiscoverProfile?>{};

  String get _me => FirebaseAuth.instance.currentUser?.uid ?? '';

  @override
  void initState() {
    super.initState();
    if (_me.isNotEmpty) DmService.sweepAllMine(_me);
  }

  Future<void> _loadProfile(String uid) async {
    if (_profiles.containsKey(uid) || uid.isEmpty) return;
    _profiles[uid] = null;
    try {
      final p = await SocialService().getProfile(uid);
      if (!mounted) return;
      setState(() => _profiles[uid] = p);
    } on FirebaseException {
      // The row still renders with the fallback name.
    }
  }

  void _open(DmThread thread) {
    final other = thread.otherUid(_me);
    final p = _profiles[other];
    NotificationService.markDmSeen(thread.id);
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DmChatScreen(
          otherUid: other,
          otherName: p?.name ?? 'Myto user',
          otherPhoto: p?.photo ?? '',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: const Text(
          'Messages',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
        ),
      ),
      body: _me.isEmpty
          ? const Center(
              child: Text(
                'Sign in to chat with the community.',
                style: TextStyle(fontSize: 13.5, color: TeamlyColors.ink500),
              ),
            )
          : StreamBuilder<List<DmThread>>(
              stream: DmService.streamThreads(_me),
              builder: (context, snap) {
                final threads = snap.data ?? const <DmThread>[];
                if (threads.isEmpty) {
                  return Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(Icons.chat_bubble_outline_rounded, size: 40, color: palette.muted),
                        const SizedBox(height: 12),
                        const Text(
                          'No messages yet.\nTap Message on someone\'s profile to start.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 13.5, height: 1.5, color: TeamlyColors.ink500),
                        ),
                      ],
                    ),
                  );
                }
                return ListView(
                  padding: const EdgeInsets.only(top: 4, bottom: TeamlySpace.s6),
                  children: <Widget>[
                    for (final t in threads) _row(t),
                  ],
                );
              },
            ),
    );
  }

  Widget _row(DmThread thread) {
    final other = thread.otherUid(_me);
    if (other.isNotEmpty) _loadProfile(other);
    final p = _profiles[other];
    final verified = p?.verified == true;
    final photo = p?.photo ?? '';
    final name = p?.name ?? 'Myto user';
    return InkWell(
      onTap: () => _open(thread),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 9),
        child: Row(
          children: <Widget>[
            _Avatar(photo: photo, name: name),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: TeamlyColors.ink900,
                            fontSize: 15.5,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      if (verified) ...<Widget>[
                        const SizedBox(width: 4),
                        const Icon(Icons.verified_rounded, size: 15, color: Color(0xFF1D9BF0)),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    thread.lastText.isEmpty ? 'Say hi!' : thread.lastText,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              _time(thread.lastAtMs),
              style: const TextStyle(color: TeamlyColors.ink300, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }

  String _time(int ms) {
    if (ms == 0) return '';
    final now = DateTime.now();
    final at = DateTime.fromMillisecondsSinceEpoch(ms);
    if (at.day == now.day && at.month == now.month) {
      final h = at.hour % 12 == 0 ? 12 : at.hour % 12;
      return '$h:${at.minute.toString().padLeft(2, '0')}';
    }
    return '${at.day}/${at.month}';
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.photo, required this.name});

  final String photo;
  final String name;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipOval(
        child: Image.network(
          photo,
          width: 46,
          height: 46,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(context),
        ),
      );
    }
    return _initial(context);
  }

  Widget _initial(BuildContext context) {
    return Container(
      width: 46,
      height: 46,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: context.palette.pastel(1),
        shape: BoxShape.circle,
      ),
      child: Text(
        name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
      ),
    );
  }
}
