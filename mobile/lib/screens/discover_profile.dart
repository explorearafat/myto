import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// First-time Discover profile setup: display name, unique @handle, bio.
/// Shown inside the Profile destination before anything else.
class DiscoverProfileSetup extends StatefulWidget {
  const DiscoverProfileSetup({
    super.key,
    required this.uid,
    required this.defaultName,
    required this.defaultPhoto,
    required this.onDone,
  });

  final String uid;
  final String defaultName;
  final String defaultPhoto;
  final void Function(DiscoverProfile profile) onDone;

  @override
  State<DiscoverProfileSetup> createState() => _DiscoverProfileSetupState();
}

class _DiscoverProfileSetupState extends State<DiscoverProfileSetup> {
  late final TextEditingController _name = TextEditingController(text: widget.defaultName);
  final TextEditingController _username = TextEditingController();
  final TextEditingController _bio = TextEditingController();
  bool _checking = false;
  bool? _free;
  bool _busy = false;
  String _error = '';
  Timer? _debounce;

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
    if (handle.isEmpty) {
      setState(() => _free = null);
      return;
    }
    setState(() => _checking = true);
    _debounce = Timer(const Duration(milliseconds: 450), () async {
      final free = kHandleRe.hasMatch(handle) && await SocialService().isHandleFree(handle);
      if (!mounted) return;
      setState(() => _free = free);
    });
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
                  const Text(
                    'Set up your profile',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
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
                  onTap: valid && !_busy
                      ? () async {
                          setState(() {
                            _busy = true;
                            _error = '';
                          });
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
                                name: _name.text,
                                username: _username.text.trim().toLowerCase(),
                                bio: _bio.text,
                                photo: widget.defaultPhoto,
                                createdAtMs: DateTime.now().millisecondsSinceEpoch,
                              ),
                            );
                          } else {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('That username was just taken — try another.')),
                            );
                          }
                        }
                      : null,
                  child: Center(
                    child: Text(
                      _busy ? 'Saving…' : 'Create profile',
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

/// The Profile destination: identity header + My posts / Saved tabs.
class DiscoverProfileView extends StatefulWidget {
  const DiscoverProfileView({
    super.key,
    required this.uid,
    required this.profile,
    required this.savedIds,
    required this.onUnsave,
    required this.onDelete,
    required this.onComment,
  });

  final String uid;
  final DiscoverProfile? profile;
  final Set<String> savedIds;
  final void Function(String postId) onUnsave;
  final void Function(String postId) onDelete;
  final void Function(FeedPost post, String text) onComment;

  @override
  State<DiscoverProfileView> createState() => _DiscoverProfileViewState();
}

class _DiscoverProfileViewState extends State<DiscoverProfileView> {
  String _tab = 'posts';
  List<FeedPost>? _posts;
  List<FeedPost>? _saved;

  @override
  void initState() {
    super.initState();
    SocialService.streamFeed(authorUid: widget.uid, limitCount: 50).listen((list) {
      if (mounted) setState(() => _posts = list);
    });
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    final posts = await SocialService.hydratePosts(widget.savedIds.toList());
    if (mounted) setState(() => _saved = posts);
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final list = _tab == 'posts' ? _posts : _saved;
    return ListView(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      children: <Widget>[
        TeamlyCard(
          padding: const EdgeInsets.all(TeamlySpace.s4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  _DProfileAvatar(
                    photo: widget.profile?.photo ?? '',
                    name: widget.profile?.name ?? 'You',
                    size: 52,
                  ),
                  const SizedBox(width: TeamlySpace.s3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          widget.profile?.name ?? 'You',
                          style: const TextStyle(
                              fontSize: 17, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                        ),
                        if (widget.profile?.username.isNotEmpty ?? false)
                          Text('@${widget.profile!.username}',
                              style: const TextStyle(fontSize: 13, color: TeamlyColors.greenText)),
                      ],
                    ),
                  ),
                ],
              ),
              if (widget.profile?.bio.isNotEmpty ?? false)
                Padding(
                  padding: const EdgeInsets.only(top: TeamlySpace.s3),
                  child: Text(
                    widget.profile!.bio,
                    style: const TextStyle(fontSize: 13.5, height: 1.45, color: TeamlyColors.ink700),
                  ),
                ),
              const SizedBox(height: TeamlySpace.s3),
              Row(
                children: <Widget>[
                  Text('${_posts?.length ?? 0} posts',
                      style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500)),
                  const SizedBox(width: TeamlySpace.s4),
                  Text('${widget.savedIds.length} saved',
                      style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500)),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: TeamlySpace.s3),
        Row(
          children: <Widget>[
            for (final t in const <String>['posts', 'saved'])
              Expanded(
                child: GestureDetector(
                  onTap: () => setState(() => _tab = t),
                  child: Container(
                    margin: EdgeInsets.only(right: t == 'posts' ? TeamlySpace.s2 : 0),
                    padding: const EdgeInsets.symmetric(vertical: 9),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _tab == t ? palette.accent : palette.chip,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                    child: Text(
                      t == 'posts' ? 'My posts' : 'Saved',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: _tab == t ? palette.onAccent : TeamlyColors.ink700,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: TeamlySpace.s3),
        if (list == null)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: Text('Loading…', style: TextStyle(color: TeamlyColors.ink300))),
          )
        else if (list.isEmpty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Center(
              child: Text(
                _tab == 'posts' ? 'You have not posted yet.' : 'Nothing saved yet — tap Save on a post.',
                style: const TextStyle(color: TeamlyColors.ink300),
              ),
            ),
          )
        else
          for (final p in list)
            Padding(
              padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
              child: _DProfilePostCard(
                post: p,
                meUid: widget.uid,
                meName: widget.profile?.name ?? 'You',
                saved: _tab == 'saved',
                onUnsave: _tab == 'saved' ? () => widget.onUnsave(p.id) : null,
                onDelete: _tab == 'posts' ? () => widget.onDelete(p.id) : null,
              ),
            ),
      ],
    );
  }
}

/// A compact read-mostly post card for the profile lists.
class _DProfilePostCard extends StatelessWidget {
  const _DProfilePostCard({
    required this.post,
    required this.meUid,
    required this.meName,
    required this.saved,
    this.onUnsave,
    this.onDelete,
  });

  final FeedPost post;
  final String meUid;
  final String meName;
  final bool saved;
  final VoidCallback? onUnsave;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    return TeamlyCard(
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            post.text,
            style: const TextStyle(fontSize: 14, height: 1.45, color: TeamlyColors.ink900),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Row(
            children: <Widget>[
              Text('${post.likeCount} likes · ${post.commentCount} comments',
                  style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300)),
              const Spacer(),
              if (onUnsave != null)
                TextButton(
                  onPressed: onUnsave,
                  child: const Text('Remove', style: TextStyle(fontSize: 12, color: TeamlyColors.ink500)),
                ),
              if (onDelete != null)
                TextButton(
                  onPressed: onDelete,
                  child: const Text('Delete', style: TextStyle(fontSize: 12, color: TeamlyColors.ink500)),
                ),
            ],
          ),
        ],
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
