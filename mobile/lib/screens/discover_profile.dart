import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/social_service.dart';
import '../services/verified.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// First-time Discover profile setup — doubles as the EDIT form when
/// [existing] is passed: fields arrive prefilled, the unchanged handle passes
/// the availability check (it's already the caller's), and the save button
/// reads "Save changes". Shown inside the Profile destination.
class DiscoverProfileSetup extends StatefulWidget {
  const DiscoverProfileSetup({
    super.key,
    required this.uid,
    required this.defaultName,
    required this.defaultPhoto,
    required this.onDone,
    this.existing,
  });

  final String uid;
  final String defaultName;
  final String defaultPhoto;

  /// The profile being edited, or null for first-time setup.
  final DiscoverProfile? existing;

  final void Function(DiscoverProfile profile) onDone;

  @override
  State<DiscoverProfileSetup> createState() => _DiscoverProfileSetupState();
}

class _DiscoverProfileSetupState extends State<DiscoverProfileSetup> {
  late final TextEditingController _name =
      TextEditingController(text: widget.existing?.name ?? widget.defaultName);
  late final TextEditingController _username =
      TextEditingController(text: widget.existing?.username ?? '');
  late final TextEditingController _bio =
      TextEditingController(text: widget.existing?.bio ?? '');
  bool _checking = false;
  bool? _free;
  bool _busy = false;
  String _error = '';
  Timer? _debounce;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    // Editing with the current handle: skip the availability check — the
    // handle is already ours (and create-once in the rules).
    if (_editing) _free = true;
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _name.dispose();
    _username.dispose();
    _bio.dispose();
    super.dispose();
  }

  void _onHandle(String value) {
    _debounce?.cancel();
    final handle = value.trim().toLowerCase();
    // Keeping your own handle is always valid — the old code re-checked it
    // and showed "taken", which blocked editing entirely.
    if (_editing && handle == widget.existing!.username) {
      setState(() => _free = true);
      return;
    }
    if (handle.isEmpty) {
      setState(() => _free = null);
      return;
    }
    setState(() => _checking = true);
    _debounce = Timer(const Duration(milliseconds: 450), () async {
      bool free;
      try {
        free = kHandleRe.hasMatch(handle) && await SocialService().isHandleFree(handle);
      } catch (_) {
        free = false;
      }
      if (!mounted) return;
      setState(() => _free = free);
    });
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final ok = await SocialService().saveProfile(
        widget.uid,
        name: _name.text,
        username: _username.text,
        bio: _bio.text,
        photo: widget.defaultPhoto,
      );
      if (!mounted) return;
      setState(() => _busy = false);
      if (ok) {
        widget.onDone(
          DiscoverProfile(
            uid: widget.uid,
            name: _name.text.trim(),
            username: _username.text.trim().toLowerCase(),
            bio: _bio.text,
            photo: widget.defaultPhoto,
            createdAtMs: widget.existing?.createdAtMs ?? DateTime.now().millisecondsSinceEpoch,
          ),
        );
      } else {
        setState(() => _error = 'That username was just taken — try another.');
      }
    } on FirebaseException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.code.contains('permission-denied')
            ? 'Myto could not save your profile — sign in and try again.'
            : 'Myto could not save your profile — check your connection and try again.';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Something went wrong — try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final valid =
        _name.text.trim().length >= 2 && _free == true && kHandleRe.hasMatch(_username.text.trim());
    return SingleChildScrollView(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      child: TeamlyCard(
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Center(
              child: Column(
                children: <Widget>[
                  _DProfileAvatar(photo: widget.defaultPhoto, name: _name.text, size: 56),
                  const SizedBox(height: TeamlySpace.s3),
                  Text(
                    _editing ? 'Edit profile' : 'Set up your profile',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'This is how the community sees you — on your posts, comments, and follows.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13, height: 1.4, color: TeamlyColors.ink500),
                  ),
                ],
              ),
            ),
            const SizedBox(height: TeamlySpace.s4),
            TextField(
              controller: _name,
              maxLength: 80,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Display name', counterText: ''),
            ),
            const SizedBox(height: TeamlySpace.s3),
            TextField(
              controller: _username,
              maxLength: 20,
              onChanged: _onHandle,
              decoration: InputDecoration(
                labelText: 'Username',
                prefixText: '@ ',
                counterText: '',
                helperText: _checking
                    ? 'Checking availability…'
                    : _free == true
                        ? '@${_username.text} is available'
                        : _free == false
                            ? 'That username is taken'
                            : '3-20 chars: a-z, 0-9, underscore',
                helperStyle: TextStyle(
                  color: _free == false ? TeamlyColors.danger : TeamlyColors.ink300,
                ),
              ),
            ),
            const SizedBox(height: TeamlySpace.s3),
            TextField(
              controller: _bio,
              maxLength: 280,
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: 'Bio (optional)',
                counterText: '',
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: TeamlySpace.s4),
            SizedBox(
              height: 50,
              child: Material(
                color: valid && !_busy ? palette.accent : palette.chip,
                borderRadius: BorderRadius.circular(14),
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: valid && !_busy ? _save : null,
                  child: Center(
                    child: Text(
                      _busy ? 'Saving…' : (_editing ? 'Save changes' : 'Create profile'),
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: valid && !_busy ? palette.onAccent : TeamlyColors.ink300,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (_error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: TeamlyColors.danger, fontSize: 12.5),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The Profile view — Instagram layout: avatar raised on the LEFT, the
/// posts/followers/following stats to its right, name + bio beneath, link
/// chips, and an Edit profile / Share profile action row. Then the
/// My posts | Saved tabs.
class DiscoverProfileView extends StatefulWidget {
  const DiscoverProfileView({
    super.key,
    required this.uid,
    required this.profile,
    required this.savedIds,
    required this.onUnsave,
    required this.onDelete,
    required this.onComment,
    required this.onEdit,
  });

  final String uid;
  final DiscoverProfile? profile;
  final Set<String> savedIds;
  final void Function(String postId) onUnsave;
  final void Function(String postId) onDelete;
  final void Function(FeedPost post, String text) onComment;
  final VoidCallback onEdit;

  @override
  State<DiscoverProfileView> createState() => _DiscoverProfileViewState();
}

class _DiscoverProfileViewState extends State<DiscoverProfileView> {
  List<FeedPost>? _posts;
  int _followers = 0;
  int _following = 0;

  @override
  void initState() {
    super.initState();
    SocialService.streamFeed(authorUid: widget.uid, limitCount: 50).listen(
      (list) {
        if (mounted) setState(() => _posts = list);
      },
      // A failed subscription (offline, index hiccup) shows the empty state
      // instead of a "Loading…" that never resolves.
      onError: (_) {
        if (mounted) setState(() => _posts = const <FeedPost>[]);
      },
    );
    _loadStats();
  }

  Future<void> _loadStats() async {
    try {
      final followers = await SocialService.followerCount(widget.uid);
      final following = await SocialService.followingCount(widget.uid);
      if (!mounted) return;
      setState(() {
        _followers = followers;
        _following = following;
      });
    } catch (_) {
      // Stats stay at 0 — the header still renders.
    }
  }

  /// https links found in the bio — rendered as the IG-style link chips.
  List<String> get _bioLinks {
    final bio = widget.profile?.bio ?? '';
    return RegExp(r'https://[^\s]+')
        .allMatches(bio)
        .map((m) => m.group(0)!)
        .take(3)
        .toList();
  }

  /// Bio with the link URLs stripped (they render as chips instead).
  String get _bioText => (widget.profile?.bio ?? '')
      .replaceAll(RegExp(r'https://\S+'), '')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  Future<void> _shareProfile() async {
    final username = widget.profile?.username ?? '';
    final url = username.isEmpty
        ? 'https://mytocode.vercel.app/discover'
        : 'https://mytocode.vercel.app/discover?u=$username';
    final messenger = ScaffoldMessenger.of(context);
    await Clipboard.setData(ClipboardData(text: url));
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Profile link copied.')));
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final profile = widget.profile;
    final verified = profile?.verified == true;
    final followersLabel = verified ? kVerifiedFollowersLabel : _compact(_followers);
    final postCount = _posts?.length ?? 0;
    // A Column, NOT a ListView: this view is embedded in the ProfileScreen's
    // own scrolling ListView, and a nested viewport-based ListView gets
    // unbounded height there — the layout exception that rendered the whole
    // profile body blank in release builds. The outer screen does the
    // scrolling for both.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // ── Instagram-style identity header ────────────────────────────────
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // The avatar sits slightly raised relative to the stats — the IG
            // composition (photo top-left, numbers to the right).
            Transform.translate(
              offset: const Offset(0, -6),
              child: _DProfileAvatar(
                photo: profile?.photo ?? '',
                name: profile?.name ?? 'You',
                size: 84,
              ),
            ),
            const SizedBox(width: TeamlySpace.s5),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: <Widget>[
                    _Stat(count: '$postCount', label: 'posts'),
                    _Stat(count: followersLabel, label: 'followers'),
                    _Stat(count: _compact(_following), label: 'following'),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: TeamlySpace.s3),
        if (profile?.username.isNotEmpty ?? false)
          Row(
            children: <Widget>[
              Text(
                '@${profile!.username}',
                style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: TeamlyColors.greenText),
              ),
              if (verified) ...<Widget>[
                const SizedBox(width: 5),
                const Icon(Icons.verified_rounded, size: 16, color: Color(0xFF1D9BF0)),
              ],
            ],
          ),
        const SizedBox(height: 2),
        Text(
          profile?.name ?? 'You',
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
        ),
        if (_bioText.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              _bioText,
              style: const TextStyle(fontSize: 13.5, height: 1.45, color: TeamlyColors.ink700),
            ),
          ),
        if (_bioLinks.isNotEmpty) ...<Widget>[
          const SizedBox(height: TeamlySpace.s2),
          Wrap(
            spacing: TeamlySpace.s2,
            runSpacing: TeamlySpace.s2,
            children: <Widget>[
              for (final url in _bioLinks)
                GestureDetector(
                  onTap: () async {
                    await Clipboard.setData(ClipboardData(text: url));
                    if (!mounted) return;
                    ScaffoldMessenger.of(context)
                      ..hideCurrentSnackBar()
                      ..showSnackBar(const SnackBar(content: Text('Link copied.')));
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                    decoration: BoxDecoration(
                      color: palette.chip,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                      border: Border.all(color: palette.border),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        const Icon(Icons.link_rounded, size: 14, color: TeamlyColors.ink700),
                        const SizedBox(width: 6),
                        Text(
                          Uri.tryParse(url)?.host.replaceFirst('www.', '') ?? url,
                          style: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: TeamlyColors.ink900,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ],
        const SizedBox(height: TeamlySpace.s4),
        // Action row — Edit profile / Share profile / overflow.
        Row(
          children: <Widget>[
            Expanded(
              child: _ActionTile(label: 'Edit profile', onTap: widget.onEdit),
            ),
            const SizedBox(width: TeamlySpace.s2),
            Expanded(
              child: _ActionTile(label: 'Share profile', onTap: _shareProfile),
            ),
            const SizedBox(width: TeamlySpace.s2),
            _ActionTile.icon(
              icon: Icons.keyboard_arrow_down_rounded,
              onTap: () => _moreSheet(context),
            ),
          ],
        ),
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
        if (_posts == null)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: Text('Loading…', style: TextStyle(color: TeamlyColors.ink300))),
          )
        else if (_posts!.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Center(
              child: Text(
                'You have not posted yet — share something from Discover.',
                textAlign: TextAlign.center,
                style: TextStyle(color: TeamlyColors.ink300),
              ),
            ),
          )
        else
          for (final post in _posts!)
            Padding(
              padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
              child: _OwnPostCard(post: post),
            ),
      ],
    );
  }

  void _moreSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const SizedBox(height: TeamlySpace.s2),
            ListTile(
              leading: const Icon(Icons.copy_rounded, size: 20, color: TeamlyColors.ink700),
              title: const Text('Copy profile link', style: TextStyle(fontSize: 14.5)),
              onTap: () {
                Navigator.pop(context);
                _shareProfile();
              },
            ),
            ListTile(
              leading: const Icon(Icons.edit_outlined, size: 20, color: TeamlyColors.ink700),
              title: const Text('Edit profile', style: TextStyle(fontSize: 14.5)),
              onTap: () {
                Navigator.pop(context);
                widget.onEdit();
              },
            ),
            const SizedBox(height: TeamlySpace.s2),
          ],
        ),
      ),
    );
  }

  String _compact(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return '$n';
  }
}

/// One number+label column in the stats row.
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

/// The IG-style bordered action pill (Edit profile / Share profile).
class _ActionTile extends StatelessWidget {
  const _ActionTile({required this.label, this.onTap}) : icon = null;

  const _ActionTile.icon({required this.icon, this.onTap}) : label = null;

  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.sm),
          border: Border.all(color: palette.border),
        ),
        child: label != null
            ? Text(
                label!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
              )
            : Icon(icon, size: 20, color: TeamlyColors.ink700),
      ),
    );
  }
}


class _DProfileAvatar extends StatelessWidget {
  const _DProfileAvatar({required this.photo, required this.name, required this.size});

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
          errorBuilder: (_, __, ___) => _initial(size),
        ),
      );
    }
    return _initial(size);
  }

  Widget _initial(double size) {
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
            fontSize: size * 0.4, fontWeight: FontWeight.w700, color: const Color(0xFF1A6B52)),
      ),
    );
  }
}

/// A compact read-only card for the profile's POSTS list.
class _OwnPostCard extends StatelessWidget {
  const _OwnPostCard({required this.post});

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
            maxLines: 5,
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
