import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/dm_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'dm_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// SearchScreen — find community posts (text/topics) and people (name/handle).
/// Results filter client-side over a recent snapshot; cheap and instant.
/// ---------------------------------------------------------------------------
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _ctrl = TextEditingController();
  List<FeedPost>? _posts;
  List<DiscoverProfile>? _people;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final results = await Future.wait(<Future<dynamic>>[
      SocialService.fetchRecentPosts(),
      SocialService.fetchProfileSample(),
    ]);
    if (!mounted) return;
    setState(() {
      _posts = results[0] as List<FeedPost>;
      _people = results[1] as List<DiscoverProfile>;
      _loaded = true;
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final q = _ctrl.text.trim().toLowerCase();
    final posts = (_posts ?? const <FeedPost>[])
        .where((p) =>
            q.isEmpty ||
            p.text.toLowerCase().contains(q) ||
            p.name.toLowerCase().contains(q) ||
            p.topics.any((t) => t.contains(q)))
        .toList();
    final people = (_people ?? const <DiscoverProfile>[])
        .where((p) =>
            q.isNotEmpty &&
            (p.name.toLowerCase().contains(q) || p.username.contains(q)) &&
            p.uid != (FirebaseAuth.instance.currentUser?.uid ?? ''))
        .toList();

    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        title: TextField(
          controller: _ctrl,
          autofocus: false,
          style: const TextStyle(fontSize: 15, color: TeamlyColors.ink900),
          decoration: const InputDecoration(
            isCollapsed: true,
            contentPadding: EdgeInsets.symmetric(vertical: 10),
            border: InputBorder.none,
            hintText: 'Search posts, topics, people…',
            hintStyle: TextStyle(color: TeamlyColors.ink300, fontSize: 15),
          ),
          onChanged: (_) => setState(() {}),
        ),
      ),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : (q.isEmpty && posts.isEmpty)
              ? const _Nothing()
              : ListView(
                  padding: const EdgeInsets.all(TeamlySpace.gutter),
                  children: <Widget>[
                    if (people.isNotEmpty) ...<Widget>[
                      const TeamlyGroupHeader(label: 'People'),
                      const SizedBox(height: TeamlySpace.s2),
                      for (final p in people)
                        _PersonRow(
                          profile: p,
                          onMessage: () async {
                            final me = FirebaseAuth.instance.currentUser?.uid ?? '';
                            await DmService.ensureThread(me, p.uid);
                            if (!context.mounted) return;
                            Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => DmChatScreen(
                                  otherUid: p.uid,
                                  otherName: p.name,
                                  otherPhoto: p.photo,
                                ),
                              ),
                            );
                          },
                        ),
                      const SizedBox(height: TeamlySpace.s3),
                    ],
                    if (posts.isNotEmpty) ...<Widget>[
                      const TeamlyGroupHeader(label: 'Posts'),
                      const SizedBox(height: TeamlySpace.s2),
                      for (final p in posts.take(30))
                        Padding(
                          padding: const EdgeInsets.only(bottom: TeamlySpace.s2),
                          child: TeamlyCard(
                            padding: const EdgeInsets.all(TeamlySpace.s3),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(
                                  p.name,
                                  style: const TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w700,
                                    color: TeamlyColors.greenText,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  p.text,
                                  maxLines: 3,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 13.5,
                                    height: 1.4,
                                    color: TeamlyColors.ink900,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                    if (people.isEmpty && posts.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 48),
                        child: Center(
                          child: Text(
                            'Nothing matches "$q".',
                            style: const TextStyle(color: TeamlyColors.ink500),
                          ),
                        ),
                      ),
                  ],
                ),
    );
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({required this.profile, required this.onMessage});

  final DiscoverProfile profile;
  final VoidCallback onMessage;

  @override
  Widget build(BuildContext context) {
    return TeamlyCard(
      padding: const EdgeInsets.all(TeamlySpace.s3),
      child: Row(
        children: <Widget>[
          _PersonAvatar(photo: profile.photo, name: profile.name, size: 40),
          const SizedBox(width: TeamlySpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  profile.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                    color: TeamlyColors.ink900,
                  ),
                ),
                if (profile.username.isNotEmpty)
                  Text(
                    '@${profile.username}',
                    style: const TextStyle(
                      fontSize: 12,
                      fontFamily: 'monospace',
                      color: TeamlyColors.greenText,
                    ),
                  ),
              ],
            ),
          ),
          TeamlyPillButton(
            label: 'Message',
            icon: Icons.chat_bubble_outline_rounded,
            onPressed: onMessage,
          ),
        ],
      ),
    );
  }
}

class _PersonAvatar extends StatelessWidget {
  const _PersonAvatar({required this.photo, required this.name, required this.size});

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
        style: TextStyle(
          fontSize: size * 0.4,
          fontWeight: FontWeight.w700,
          color: const Color(0xFF1A6B52),
        ),
      ),
    );
  }
}

class _Nothing extends StatelessWidget {
  const _Nothing();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.search_rounded, size: 44, color: context.palette.muted),
          const SizedBox(height: 12),
          const Text(
            'Search the Myto community —\nposts, topics and people.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, height: 1.5, color: TeamlyColors.ink500),
          ),
        ],
      ),
    );
  }
}
