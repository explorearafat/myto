import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/dm_service.dart';
import '../services/notification_service.dart';
import '../services/social_service.dart';
import '../services/verified.dart';
import '../theme.dart';
import 'dm_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// UserProfileScreen — someone ELSE's public profile, opened from Discover's
/// search or by tapping a post author. Instagram composition: avatar, the
/// posts/followers/following stats, @handle (with the blue tick for verified
/// accounts) and the name — then the Follow / Message action row:
///
///   Follow   — green pill; tapping swaps to "Following", tapping again
///              unfollows back to "Follow".
///   Message  — outlined pill; opens the 1-to-1 chat (the messages section).
/// ---------------------------------------------------------------------------
class UserProfileScreen extends StatefulWidget {
  const UserProfileScreen({
    super.key,
    required this.uid,
    required this.name,
    required this.photo,
  });

  final String uid;
  final String name;
  final String photo;

  @override
  State<UserProfileScreen> createState() => _UserProfileScreenState();
}

class _UserProfileScreenState extends State<UserProfileScreen> {
  DiscoverProfile? _profile;
  List<FeedPost> _posts = const <FeedPost>[];
  int _followers = 0;
  int _following = 0;
  bool _followingThem = false;
  bool _loaded = false;

  String get _me => FirebaseAuth.instance.currentUser?.uid ?? '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final profileSnap = await FirebaseFirestore.instance
          .collection('profiles')
          .doc(widget.uid)
          .get();
      final profile =
          profileSnap.exists ? DiscoverProfile.fromDoc(profileSnap.id, profileSnap.data() ?? {}) : null;
      final posts = await SocialService.fetchPostsByAuthors(<String>[widget.uid]);
      final followers = await SocialService.followerCount(widget.uid);
      final following = await SocialService.followingCount(widget.uid);
      bool followingThem = false;
      if (_me.isNotEmpty) {
        final edge = await FirebaseFirestore.instance
            .collection('follows')
            .doc(_me)
            .collection('following')
            .doc(widget.uid)
            .get();
        followingThem = edge.exists;
      }
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _posts = posts;
        _followers = followers;
        _following = following;
        _followingThem = followingThem;
        _loaded = true;
      });
    } on FirebaseException {
      if (!mounted) return;
      setState(() => _loaded = true);
    }
  }

  Future<void> _toggleFollow() async {
    if (_me.isEmpty) return;
    try {
      if (_followingThem) {
        await SocialService.unfollowAuthor(_me, widget.uid);
        if (!mounted) return;
        setState(() {
          _followingThem = false;
          _followers = (_followers - 1).clamp(0, 1 << 30);
        });
      } else {
        await SocialService.followAuthor(_me, widget.uid);
        if (!mounted) return;
        setState(() {
          _followingThem = true;
          _followers++;
        });
      }
    } on FirebaseException {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Sign in to follow.')));
    }
  }

  Future<void> _message() async {
    if (_me.isEmpty || _me == widget.uid) return;
    // Robust on purpose: a thread-create hiccup (offline, rules race) must
    // never swallow the tap — the chat still opens and the first send retries
    // the thread creation itself.
    try {
      await DmService.ensureThread(_me, widget.uid);
    } catch (_) {
      // The chat screen self-heals the thread on send.
    }
    if (!mounted) return;
    NotificationService.markDmSeen(DmService.threadIdFor(_me, widget.uid));
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DmChatScreen(
          otherUid: widget.uid,
          otherName: _profile?.name ?? widget.name,
          otherPhoto: _profile?.photo ?? widget.photo,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final profile = _profile;
    final verified = profile?.verified == true;
    final name = profile?.name ?? widget.name;
    final username = profile?.username ?? '';
    final followers = verified ? kVerifiedFollowersLabel : _compact(_followers);

    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text(
          username.isEmpty ? name : '@$username',
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
        ),
      ),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(TeamlySpace.gutter),
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Transform.translate(
                      offset: const Offset(0, -6),
                      child: _PAvatar(photo: profile?.photo ?? widget.photo, name: name),
                    ),
                    const SizedBox(width: TeamlySpace.s5),
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 14),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                          children: <Widget>[
                            _Stat(count: '${_posts.length}', label: 'posts'),
                            _Stat(count: followers, label: 'followers'),
                            _Stat(count: _compact(_following), label: 'following'),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: TeamlySpace.s3),
                if (username.isNotEmpty)
                  Row(
                    children: <Widget>[
                      Text(
                        '@$username',
                        style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          color: TeamlyColors.greenText,
                        ),
                      ),
                      if (verified) ...<Widget>[
                        const SizedBox(width: 5),
                        const Icon(Icons.verified_rounded, size: 16, color: Color(0xFF1D9BF0)),
                      ],
                    ],
                  ),
                const SizedBox(height: 2),
                Text(
                  name,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
                ),
                if ((profile?.bio ?? '').isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      profile!.bio,
                      style: const TextStyle(fontSize: 13.5, height: 1.45, color: TeamlyColors.ink700),
                    ),
                  ),
                const SizedBox(height: TeamlySpace.s4),
                // ── Follow / Message ───────────────────────────────────────
                if (_me.isNotEmpty && _me != widget.uid)
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: SizedBox(
                          height: 46,
                          child: Material(
                            color: _followingThem ? palette.chip : palette.accent,
                            borderRadius: BorderRadius.circular(12),
                            child: InkWell(
                              borderRadius: BorderRadius.circular(12),
                              onTap: _toggleFollow,
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: <Widget>[
                                  Icon(
                                    _followingThem
                                        ? Icons.person_rounded
                                        : Icons.person_add_alt_rounded,
                                    size: 18,
                                    color: _followingThem ? TeamlyColors.greenText : palette.onAccent,
                                  ),
                                  const SizedBox(width: 7),
                                  Text(
                                    _followingThem ? 'Following' : 'Follow',
                                    style: TextStyle(
                                      fontSize: 14.5,
                                      fontWeight: FontWeight.w700,
                                      color: _followingThem ? TeamlyColors.greenText : palette.onAccent,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: TeamlySpace.s2),
                      Expanded(
                        child: SizedBox(
                          height: 46,
                          child: Material(
                            color: palette.chip,
                            borderRadius: BorderRadius.circular(12),
                            child: InkWell(
                              borderRadius: BorderRadius.circular(12),
                              onTap: _message,
                              child: const Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: <Widget>[
                                  Icon(Icons.chat_bubble_outline_rounded,
                                      size: 17, color: TeamlyColors.ink900),
                                  SizedBox(width: 7),
                                  Text(
                                    'Message',
                                    style: TextStyle(
                                      fontSize: 14.5,
                                      fontWeight: FontWeight.w700,
                                      color: TeamlyColors.ink900,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                if (_posts.isNotEmpty) ...<Widget>[
                  const SizedBox(height: TeamlySpace.s5),
                  const Text(
                    'POSTS',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.1,
                      color: TeamlyColors.ink300,
                    ),
                  ),
                  const SizedBox(height: TeamlySpace.s2),
                  for (final post in _posts)
                    Padding(
                      padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
                      child: _PostPreview(post: post),
                    ),
                ],
              ],
            ),
    );
  }

  String _compact(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return '$n';
  }
}

class _PAvatar extends StatelessWidget {
  const _PAvatar({required this.photo, required this.name});

  final String photo;
  final String name;

  @override
  Widget build(BuildContext context) {
    const size = 84.0;
    if (photo.isNotEmpty) {
      return ClipOval(
        child: Image.network(
          photo,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(context),
        ),
      );
    }
    return _initial(context);
  }

  Widget _initial(BuildContext context) {
    return Container(
      width: 84,
      height: 84,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: context.palette.pastel(1),
        shape: BoxShape.circle,
      ),
      child: Text(
        name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
        style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.count, required this.label});

  final String count;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          count,
          style: const TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w800,
            color: TeamlyColors.ink900,
            fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(height: 1),
        Text(label, style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500)),
      ],
    );
  }
}

/// A compact read-only post card for the profile's POSTS section.
class _PostPreview extends StatelessWidget {
  const _PostPreview({required this.post});

  final FeedPost post;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: context.palette.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: context.palette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            post.text,
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 14, height: 1.45, color: TeamlyColors.ink900),
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              const Icon(Icons.favorite_rounded, size: 14, color: TeamlyColors.danger),
              const SizedBox(width: 4),
              Text('${post.likeCount}', style: const TextStyle(fontSize: 12, color: TeamlyColors.ink500)),
              const SizedBox(width: 14),
              const Icon(Icons.chat_bubble_outline_rounded, size: 14, color: TeamlyColors.ink300),
              const SizedBox(width: 4),
              Text('${post.commentCount}', style: const TextStyle(fontSize: 12, color: TeamlyColors.ink500)),
              const Spacer(),
              Text(
                _relTime(post.createdAtMs),
                style: const TextStyle(fontSize: 11, color: TeamlyColors.ink300),
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _relTime(int ms) {
    if (ms == 0) return '';
    final diff = DateTime.now().millisecondsSinceEpoch - ms;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return '${diff ~/ 60000}m';
    if (diff < 86400000) return '${diff ~/ 3600000}h';
    return '${diff ~/ 86400000}d';
  }
}
