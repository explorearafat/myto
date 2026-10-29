import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/dm_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import 'dm_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// DmListScreen — the DM inbox: one row per 1:1 conversation, newest activity
/// first. Tapping a row opens the WhatsApp-style chat. The other participant's
/// name/photo resolve from their public Discover profile.
/// ---------------------------------------------------------------------------
class DmListScreen extends StatefulWidget {
  const DmListScreen({super.key});

  @override
  State<DmListScreen> createState() => _DmListScreenState();
}

class _DmListScreenState extends State<DmListScreen> {
  final Map<String, DiscoverProfile?> _profiles = <String, DiscoverProfile?>{};

  String get _me => FirebaseAuth.instance.currentUser?.uid ?? '';

  Future<void> _loadProfile(String uid) async {
    if (_profiles.containsKey(uid) || uid.isEmpty) return;
    _profiles[uid] = null; // reserve so we don't refetch while in flight
    final p = await SocialService().getProfile(uid);
    if (!mounted) return;
    setState(() => _profiles[uid] = p);
  }

  void _openChat(DmThread thread) {
    final other = thread.otherUid(_me);
    final p = _profiles[other];
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
    if (_me.isEmpty) {
      return Scaffold(
        backgroundColor: palette.bg,
        appBar: AppBar(title: const Text('Messages')),
        body: const Center(
          child: Text(
            'Sign in to chat with the community.',
            style: TextStyle(color: TeamlyColors.ink500),
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(title: const Text('Messages')),
      body: StreamBuilder<List<DmThread>>(
        stream: DmService.streamThreads(_me),
        builder: (context, snap) {
          final threads = snap.data ?? const <DmThread>[];
          if (snap.connectionState == ConnectionState.waiting && threads.isEmpty) {
            return const Center(child: CircularProgressIndicator());
          }
          if (threads.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(Icons.chat_bubble_outline_rounded, size: 44, color: palette.muted),
                    const SizedBox(height: 14),
                    const Text(
                      'No conversations yet.\nOpen someone\'s profile on Discover and tap Message.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 14, height: 1.5, color: TeamlyColors.ink500),
                    ),
                  ],
                ),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () async {},
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(vertical: TeamlySpace.s2),
              itemCount: threads.length,
              itemBuilder: (context, i) {
                final t = threads[i];
                final other = t.otherUid(_me);
                if (!_profiles.containsKey(other)) _loadProfile(other);
                final p = _profiles[other];
                final name = p?.name ?? 'Myto user';
                final photo = p?.photo ?? '';
                final outgoing = t.lastFrom == _me;
                return _ThreadRow(
                  name: name,
                  photo: photo,
                  preview: t.lastText.isEmpty
                      ? 'Tap to start chatting'
                      : (outgoing ? 'You: ' : '') + t.lastText,
                  timeMs: t.lastAtMs,
                  isMine: outgoing,
                  onTap: () => _openChat(t),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class _ThreadRow extends StatelessWidget {
  const _ThreadRow({
    required this.name,
    required this.photo,
    required this.preview,
    required this.timeMs,
    required this.isMine,
    required this.onTap,
  });

  final String name;
  final String photo;
  final String preview;
  final int timeMs;
  final bool isMine;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: TeamlySpace.gutter,
          vertical: TeamlySpace.s3,
        ),
        child: Row(
          children: <Widget>[
            _DmAvatar(photo: photo, name: name, size: 48),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      color: TeamlyColors.ink900,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    preview,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      color: isMine ? TeamlyColors.ink500 : TeamlyColors.ink700,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: TeamlySpace.s2),
            Text(
              _stamp(timeMs),
              style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
            ),
            Icon(Icons.chevron_right_rounded, size: 18, color: palette.muted),
          ],
        ),
      ),
    );
  }

  String _stamp(int ms) {
    if (ms == 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    if (d.day == now.day && d.month == now.month && d.year == now.year) {
      final hh = d.hour % 12 == 0 ? 12 : d.hour % 12;
      return '$hh:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
    }
    return '${d.day}/${d.month}';
  }
}

class _DmAvatar extends StatelessWidget {
  const _DmAvatar({required this.photo, required this.name, required this.size});

  final String photo;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(size),
        child: Image.network(
          photo,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(),
        ),
      );
    }
    return _initial();
  }

  Widget _initial() {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: const Color(0xFFE8F3EE),
        shape: BoxShape.circle,
        border: Border.all(color: const Color(0xFFD3E6DD)),
      ),
      child: Text(
        (name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase()),
        style: const TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: Color(0xFF1A6B52),
        ),
      ),
    );
  }
}
