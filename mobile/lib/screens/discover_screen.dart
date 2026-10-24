import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// DiscoverScreen — the Myto community, backed by Firestore (the same feed the
/// website's /discover serves; see services/social_service.dart + firestore.rules).
///
/// Text-only posts about AI / Myto / crypto / anything — optionally with an
/// attached website link whose preview card renders on the post. Readers can
/// react (like), comment, share (repost to their profile), follow authors, and
/// save posts to their own profile. Reading is public; writing needs sign-in
/// (the app is already gated on Google/GitHub sign-in).
/// ---------------------------------------------------------------------------
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  String _tab = 'feeds'; // 'feeds' | 'following'
  String _topic = '';
  final Set<String> _likedIds = <String>{};
  final Set<String> _savedIds = <String>{};
  final Set<String> _followingIds = <String>{};
  bool _setsLoaded = false;
  List<FeedPost>? _followingPosts;
  bool _profileOpen = false;

  User? get _user => FirebaseAuth.instance.currentUser;
  String get _uid => _user?.uid ?? '';
  String get _name {
    final auth = Provider.of<AuthService>(context, listen: false);
    final n = (auth.displayName.isNotEmpty ? auth.displayName : (_user?.displayName ?? 'Anonymous')).trim();
    return n.isEmpty ? 'Anonymous' : n;
  }
  String get _photo => _user?.photoURL ?? '';

  @override
  void initState() {
    super.initState();
    _loadSets();
  }

  Future<void> _loadSets() async {
    if (_uid.isEmpty) return;
    final saved = await SocialService.listSavedIds(_uid);
    final following = await SocialService.getFollowingIds(_uid);
    if (!mounted) return;
    setState(() {
      _savedIds.addAll(saved);
      _followingIds.addAll(following);
      _setsLoaded = true;
    });
  }

  Future<void> _toast(String message) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 2)));
  }

  Future<void> _guard(Future<void> Function() action, String ok) async {
    try {
      await action();
      if (ok.isNotEmpty) await _toast(ok);
    } on FirebaseException catch (e) {
      await _toast(e.code.contains('permission-denied') ? 'Sign in to do that.' : 'Something went wrong — try again.');
    } catch (_) {
      await _toast('Something went wrong — try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Discover'),
        actions: <Widget>[
          if (_uid.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: TeamlySpace.s4),
              child: Center(
                child: GestureDetector(
                  onTap: () {
                    if (!_profileOpen) {
                      _profileOpen = true;
                      _openProfile();
                    }
                  },
                  child: _Avatar(photo: _photo, name: _name, size: 32),
                ),
              ),
            ),
        ],
      ),
      body: Column(
        children: <Widget>[
          const SizedBox(height: TeamlySpace.s2),
          TeamlyTabs(
            labels: const <String>['Feeds', 'Following'],
            index: _tab == 'feeds' ? 0 : 1,
            onChanged: (i) => setState(() => _tab = i == 0 ? 'feeds' : 'following'),
          ),
          const SizedBox(height: TeamlySpace.s3),
          _TopicChips(selected: _topic, onSelected: (t) => setState(() => _topic = t)),
          const SizedBox(height: TeamlySpace.s2),
          if (_uid.isEmpty)
            const _SignInCard()
          else
            _Composer(
              name: _name,
              photo: _photo,
              onPosted: () => _toast('Posted to Discover.'),
            ),
          const SizedBox(height: TeamlySpace.s3),
          Expanded(child: _feedArea(palette)),
        ],
      ),
    );
  }

  Widget _feedArea(MytoPalette palette) {
    if (_tab == 'following') {
      if (_uid.isEmpty) {
        return _Empty(text: 'Sign in to follow authors and see their posts here.', palette: palette);
      }
      if (_followingPosts == null && _setsLoaded) {
        void load() {
          SocialService.fetchPostsByAuthors(_followingIds.toList()).then((list) {
            if (mounted) setState(() => _followingPosts = list);
          });
        }

        load();
        return _Empty(text: 'Loading…', palette: palette);
      }
      final list = _followingPosts ?? const <FeedPost>[];
      if (list.isEmpty) {
        return _Empty(text: 'Follow authors and their posts land here.', palette: palette);
      }
      return RefreshIndicator(
        onRefresh: () async {
          final list = await SocialService.fetchPostsByAuthors(_followingIds.toList());
          if (mounted) setState(() => _followingPosts = list);
        },
        child: ListView(
          padding: const EdgeInsets.all(TeamlySpace.gutter),
          children: <Widget>[for (final p in list) _buildCard(p)],
        ),
      );
    }

    return StreamBuilder<List<FeedPost>>(
      key: ValueKey<String>('feed:$_topic'),
      stream: SocialService.streamFeed(topic: _topic.isEmpty ? null : _topic),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
          return _Empty(text: 'Loading the feed…', palette: palette);
        }
        final posts = snap.data ?? const <FeedPost>[];
        if (posts.isEmpty) {
          return _Empty(text: 'Nothing here yet — be the first to post.', palette: palette);
        }
        return RefreshIndicator(
          onRefresh: () async {},
          child: ListView(
            padding: const EdgeInsets.all(TeamlySpace.gutter),
            children: <Widget>[for (final p in posts) _buildCard(p)],
          ),
        );
      },
    );
  }

  Widget _buildCard(FeedPost post) {
    return Padding(
      padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
      child: _PostCard(
        post: post,
        meUid: _uid,
        meName: _name,
        liked: _likedIds.contains(post.id),
        saved: _savedIds.contains(post.id),
        following: _followingIds.contains(post.uid),
        onToggleLike: () => _guard(
          () async {
            final nowLiked = await SocialService.toggleLike(post.id, _uid);
            setState(() {
              nowLiked ? _likedIds.add(post.id) : _likedIds.remove(post.id);
            });
          },
          '',
        ),
        onShare: () => _guard(
          () async {
            final created = await SocialService.sharePost(post.id, uid: _uid, name: _name);
            await _toast(created ? 'Reposted to your profile.' : 'Already in your profile.');
          },
          '',
        ),
        onToggleSave: () => _guard(
          () async {
            if (_savedIds.contains(post.id)) {
              await SocialService.unsaveFromProfile(post.id, _uid);
              setState(() => _savedIds.remove(post.id));
              await _toast('Removed from your profile.');
            } else {
              await SocialService.saveToProfile(post.id, _uid);
              setState(() => _savedIds.add(post.id));
              await _toast('Saved to your profile.');
            }
          },
          '',
        ),
        onToggleFollow: () => _guard(
          () async {
            if (_followingIds.contains(post.uid)) {
              await SocialService.unfollowAuthor(_uid, post.uid);
              setState(() {
                _followingIds.remove(post.uid);
                _followingPosts = null;
              });
            } else {
              await SocialService.followAuthor(_uid, post.uid);
              setState(() {
                _followingIds.add(post.uid);
                _followingPosts = null;
              });
              await _toast('Following ${post.name}.');
            }
          },
          '',
        ),
        onComment: (text) => _guard(
          () => SocialService.addComment(
            post.id,
            uid: _uid,
            name: _name,
            photo: _photo,
            text: text,
          ),
          'Comment added.',
        ),
        onDelete: post.uid == _uid
            ? () => _guard(
                () async {
                  await SocialService.deletePost(post.id);
                  setState(() => _followingPosts = null);
                },
                'Post deleted.',
              )
            : null,
      ),
    );
  }

  void _openProfile() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _ProfileSheet(
        uid: _uid,
        name: _name,
        photo: _photo,
        savedIds: _savedIds.toList(growable: false),
        onUnsave: (id) => _guard(
          () async {
            await SocialService.unsaveFromProfile(id, _uid);
            setState(() => _savedIds.remove(id));
          },
          '',
        ),
        onDelete: (id) => _guard(
          () async {
            await SocialService.deletePost(id);
            setState(() => _followingPosts = null);
          },
          'Post deleted.',
        ),
        onComment: (post, text) => _guard(
          () => SocialService.addComment(
            post.id,
            uid: _uid,
            name: _name,
            photo: _photo,
            text: text,
          ),
          'Comment added.',
        ),
      ),
    ).whenComplete(() => _profileOpen = false);
  }
}

// ── Composer ───────────────────────────────────────────────────────────────────

class _Composer extends StatefulWidget {
  const _Composer({required this.name, required this.photo, required this.onPosted});

  final String name;
  final String photo;
  final VoidCallback onPosted;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  final TextEditingController _ctrl = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _expanded = false;
  bool _busy = false;
  String _error = '';
  final List<String> _topics = <String>[];
  Map<String, String>? _meta;
  Timer? _debounce;
  String _lastUrl = '';

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onTextChanged(String value) {
    final url = SocialService.firstUrl(value);
    if (url == null) {
      _debounce?.cancel();
      if (_meta != null) setState(() => _meta = null);
      _lastUrl = '';
      return;
    }
    if (url == _lastUrl) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 700), () async {
      _lastUrl = url;
      final meta = await SocialService.fetchLinkMeta(url);
      if (!mounted) return;
      setState(() => _meta = <String, String>{'url': url, ...meta});
    });
  }

  Future<void> _post() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final url = _meta?['url'] ?? SocialService.firstUrl(text) ?? '';
      await SocialService.createPost(
        uid: FirebaseAuth.instance.currentUser!.uid,
        name: widget.name,
        photo: widget.photo,
        text: text,
        topics: _topics,
        link: url,
        linkMeta: _meta ?? const <String, String>{},
      );
      _ctrl.clear();
      if (mounted) {
        setState(() {
          _expanded = false;
          _topics.clear();
          _meta = null;
          _lastUrl = '';
        });
      }
      widget.onPosted();
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not post. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final remaining = SocialService.maxPostChars - _ctrl.text.length;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
      child: TeamlyCard(
        padding: const EdgeInsets.all(TeamlySpace.s3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                _Avatar(photo: widget.photo, name: widget.name, size: 32),
                const SizedBox(width: TeamlySpace.s3),
                Expanded(
                  child: TextField(
                    controller: _ctrl,
                    focusNode: _focus,
                    minLines: _expanded ? 3 : 1,
                    maxLines: 5,
                    maxLength: SocialService.maxPostChars + 50,
                    style: const TextStyle(color: TeamlyColors.ink900, fontSize: 14.5, height: 1.4),
                    decoration: const InputDecoration(
                      isCollapsed: true,
                      border: InputBorder.none,
                      hintText: 'Share something about AI, Myto, crypto…',
                      hintStyle: TextStyle(color: TeamlyColors.ink300, fontSize: 14),
                    ),
                    onChanged: (v) {
                      setState(() {});
                      _onTextChanged(v);
                    },
                    onTap: () => setState(() => _expanded = true),
                  ),
                ),
              ],
            ),
            if (_expanded) ...<Widget>[
              const SizedBox(height: TeamlySpace.s2),
              Wrap(
                spacing: 6,
                children: <Widget>[
                  for (final t in kDiscoverTopics)
                    GestureDetector(
                      onTap: () => setState(() {
                        _topics.contains(t) ? _topics.remove(t) : _topics.add(t);
                        if (_topics.length > 4) _topics.removeAt(0);
                      }),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: _topics.contains(t) ? context.palette.accent : context.palette.chip,
                          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                        ),
                        child: Text(
                          '#$t',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                            color: _topics.contains(t) ? context.palette.onAccent : TeamlyColors.ink700,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            if (_meta != null && (_meta!['title']!.isNotEmpty || _meta!['image']!.isNotEmpty))
              Container(
                margin: const EdgeInsets.only(top: TeamlySpace.s2),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: context.palette.chip,
                  borderRadius: BorderRadius.circular(TeamlyRadius.md),
                ),
                child: Row(
                  children: <Widget>[
                    if (_meta!['image']!.isNotEmpty)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(TeamlyRadius.sm),
                        child: Image.network(
                          _meta!['image']!,
                          width: 56,
                          height: 40,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => const SizedBox(width: 56, height: 40),
                        ),
                      ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            _meta!['title']!.isEmpty ? _meta!['url']! : _meta!['title']!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: TeamlyColors.ink900),
                          ),
                          Text(
                            _meta!['site']!.isEmpty ? _meta!['url']! : _meta!['site']!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11, color: TeamlyColors.ink500),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      onPressed: () => setState(() {
                        _meta = null;
                        _lastUrl = '';
                        _ctrl.text = _ctrl.text.replaceFirst(_meta?['url'] ?? '', '').trim();
                      }),
                      icon: const Icon(Icons.close_rounded, size: 16, color: TeamlyColors.ink500),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: TeamlySpace.s2),
            Row(
              children: <Widget>[
                Text(
                  '${remaining.clamp(0, SocialService.maxPostChars)}',
                  style: TextStyle(
                    fontSize: 11.5,
                    fontFamily: 'monospace',
                    color: remaining < 0 ? TeamlyColors.danger : TeamlyColors.ink300,
                  ),
                ),
                const Spacer(),
                if (_expanded)
                  TextButton(
                    onPressed: () => setState(() {
                      _expanded = false;
                      _focus.unfocus();
                    }),
                    child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500, fontSize: 12.5)),
                  ),
                const SizedBox(width: 4),
                GestureDetector(
                  onTap: _ctrl.text.trim().isEmpty || _busy ? null : _post,
                  child: Container(
                    height: 34,
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _ctrl.text.trim().isEmpty || _busy
                          ? context.palette.chip
                          : context.palette.accent,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                    child: Text(
                      _busy ? 'Posting…' : 'Post',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: _ctrl.text.trim().isEmpty || _busy ? TeamlyColors.ink300 : context.palette.onAccent,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            if (_error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(_error, style: const TextStyle(color: TeamlyColors.danger, fontSize: 12)),
              ),
          ],
      ),
    ),
  );
}
}

// ── Post card ──────────────────────────────────────────────────────────────────

class _PostCard extends StatefulWidget {
  const _PostCard({
    required this.post,
    required this.meUid,
    required this.meName,
    required this.liked,
    required this.saved,
    required this.following,
    required this.onToggleLike,
    required this.onShare,
    required this.onToggleSave,
    required this.onToggleFollow,
    required this.onComment,
    this.onDelete,
  });

  final FeedPost post;
  final String meUid;
  final String meName;
  final bool liked;
  final bool saved;
  final bool following;
  final VoidCallback onToggleLike;
  final VoidCallback onShare;
  final VoidCallback onToggleSave;
  final VoidCallback onToggleFollow;
  final void Function(String text) onComment;
  final VoidCallback? onDelete;

  @override
  State<_PostCard> createState() => _PostCardState();
}

class _PostCardState extends State<_PostCard> {
  bool _commentsOpen = false;

  String get _mine => widget.post.uid == widget.meUid ? 'me' : 'other';

  @override
  Widget build(BuildContext context) {
    final post = widget.post;
    return TeamlyCard(
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              _Avatar(photo: post.photo, name: post.name, size: 38),
              const SizedBox(width: TeamlySpace.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      post.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                    ),
                    Text(
                      _time(post.createdAtMs),
                      style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
                    ),
                  ],
                ),
              ),
              if (widget.meUid.isNotEmpty && _mine != 'me')
                GestureDetector(
                  onTap: widget.onToggleFollow,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                    decoration: BoxDecoration(
                      color: widget.following ? context.palette.chip : context.palette.accent,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                    child: Text(
                      widget.following ? 'Following' : 'Follow',
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                        color: widget.following ? TeamlyColors.ink700 : context.palette.onAccent,
                      ),
                    ),
                  ),
                ),
              if (widget.meUid.isNotEmpty && _mine == 'me' && widget.onDelete != null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: () {
                    showDialog<void>(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        backgroundColor: context.palette.surface,
                        title: const Text('Delete this post?'),
                        actions: <Widget>[
                          TextButton(
                            onPressed: () => Navigator.pop(ctx),
                            child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
                          ),
                          TextButton(
                            onPressed: () {
                              Navigator.pop(ctx);
                              widget.onDelete!();
                            },
                            child: const Text('Delete', style: TextStyle(color: TeamlyColors.danger)),
                          ),
                        ],
                      ),
                    );
                  },
                  icon: const Icon(Icons.delete_outline_rounded, size: 18, color: TeamlyColors.ink300),
                ),
            ],
          ),
          const SizedBox(height: TeamlySpace.s3),
          _PostText(text: post.text),
          if (post.link.isNotEmpty) ...<Widget>[
            const SizedBox(height: TeamlySpace.s3),
            _LinkCard(
              url: post.link,
              title: post.linkTitle,
              image: post.linkImage,
              site: post.linkSite,
            ),
          ],
          if (post.topics.isNotEmpty) ...<Widget>[
            const SizedBox(height: TeamlySpace.s2),
            Wrap(
              spacing: 6,
              children: <Widget>[
                for (final t in post.topics)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    decoration: BoxDecoration(
                      color: context.palette.chip,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                    child: Text('#$t', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: TeamlyColors.ink500)),
                  ),
              ],
            ),
          ],
          const SizedBox(height: TeamlySpace.s3),
          Row(
            children: <Widget>[
              _Action(
                icon: widget.liked ? Icons.favorite_rounded : Icons.favorite_border_rounded,
                color: widget.liked ? TeamlyColors.danger : TeamlyColors.ink500,
                label: post.likeCount > 0 ? '${post.likeCount}' : 'Like',
                onTap: widget.meUid.isEmpty ? null : widget.onToggleLike,
              ),
              const SizedBox(width: 10),
              _Action(
                icon: Icons.chat_bubble_outline_rounded,
                color: TeamlyColors.ink500,
                label: post.commentCount > 0 ? '${post.commentCount}' : 'Comment',
                onTap: () => setState(() => _commentsOpen = !_commentsOpen),
              ),
              const SizedBox(width: 10),
              _Action(
                icon: Icons.reply_rounded,
                color: TeamlyColors.ink500,
                label: post.shareCount > 0 ? '${post.shareCount}' : 'Share',
                onTap: widget.meUid.isEmpty ? null : widget.onShare,
              ),
              const Spacer(),
              if (widget.meUid.isNotEmpty)
                _Action(
                  icon: widget.saved ? Icons.bookmark_rounded : Icons.bookmark_border_rounded,
                  color: widget.saved ? TeamlyColors.greenText : TeamlyColors.ink500,
                  label: widget.saved ? 'Saved' : 'Save',
                  onTap: widget.onToggleSave,
                ),
            ],
          ),
          if (_commentsOpen)
            _Comments(
              postId: post.id,
              meUid: widget.meUid,
              meName: widget.meName,
              onSend: widget.onComment,
            ),
        ],
      ),
    );
  }

  String _time(int ms) {
    if (ms == 0) return 'just now';
    final diff = DateTime.now().millisecondsSinceEpoch - ms;
    final s = diff ~/ 1000;
    if (s < 60) return '${s}s';
    if (s < 3600) return '${s ~/ 60}m';
    if (s < 86400) return '${s ~/ 3600}h';
    if (s < 604800) return '${s ~/ 86400}d';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    return '${d.day}/${d.month}';
  }
}

class _PostText extends StatelessWidget {
  const _PostText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final spans = <TextSpan>[];
    final re = RegExp(r'(https://[^\s]+)|(#([a-z0-9]{1,20}))', caseSensitive: false);
    var last = 0;
    for (final m in re.allMatches(text)) {
      if (m.start > last) {
        spans.add(TextSpan(text: text.substring(last, m.start)));
      }
      if (m.group(1) != null) {
        spans.add(TextSpan(
          text: m.group(1),
          style: const TextStyle(color: TeamlyColors.greenText, decoration: TextDecoration.underline),
        ));
      } else {
        spans.add(TextSpan(
          text: m.group(2),
          style: const TextStyle(color: TeamlyColors.greenText, fontWeight: FontWeight.w600),
        ));
      }
      last = m.end;
    }
    if (last < text.length) spans.add(TextSpan(text: text.substring(last)));
    return SelectableText.rich(
      TextSpan(
        style: const TextStyle(fontSize: 14.5, height: 1.45, color: TeamlyColors.ink900),
        children: spans,
      ),
    );
  }
}

class _LinkCard extends StatelessWidget {
  const _LinkCard({required this.url, required this.title, required this.image, required this.site});

  final String url;
  final String title;
  final String image;
  final String site;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {}, // Opening external links from the feed is left to the website; keep the card informational.
      child: Container(
        width: double.infinity,
        decoration: BoxDecoration(
          color: context.palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.md),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (image.isNotEmpty)
              ClipRRect(
                borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
                child: Image.network(
                  image,
                  width: double.infinity,
                  height: 150,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox(width: double.infinity, height: 0),
                ),
              ),
            Padding(
              padding: const EdgeInsets.all(10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (title.isNotEmpty)
                    Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: TeamlyColors.ink900)),
                  Text(
                    site.isEmpty ? url : site,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
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

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.color, required this.label, required this.onTap});

  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(TeamlyRadius.pill)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 5),
            Text(label, style: TextStyle(fontSize: 12.5, color: color, fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }
}

class _Comments extends StatelessWidget {
  const _Comments({
    required this.postId,
    required this.meUid,
    required this.meName,
    required this.onSend,
  });

  final String postId;
  final String meUid;
  final String meName;
  final void Function(String text) onSend;

  @override
  Widget build(BuildContext context) {
    final ctrl = TextEditingController();
    return Container(
      margin: const EdgeInsets.only(top: TeamlySpace.s3),
      padding: const EdgeInsets.all(TeamlySpace.s3),
      decoration: BoxDecoration(color: context.palette.chip, borderRadius: BorderRadius.circular(TeamlyRadius.md)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          StreamBuilder<List<FeedComment>>(
            stream: SocialService.streamComments(postId),
            builder: (context, snap) {
              final comments = snap.data ?? const <FeedComment>[];
              if (comments.isEmpty) {
                return const Text('No comments yet — start the thread.', style: TextStyle(fontSize: 12.5, color: TeamlyColors.ink300));
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  for (final c in comments)
                    Padding(
                      padding: const EdgeInsets.only(bottom: TeamlySpace.s2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          _Avatar(photo: c.photo, name: c.name, size: 24),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(c.name, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: TeamlyColors.ink900)),
                                Text(c.text, style: const TextStyle(fontSize: 13, height: 1.35, color: TeamlyColors.ink700)),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              );
            },
          ),
          if (meUid.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: TeamlySpace.s2),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: ctrl,
                      style: const TextStyle(fontSize: 13.5, color: TeamlyColors.ink900),
                      maxLength: SocialService.maxCommentChars,
                      decoration: const InputDecoration(
                        isCollapsed: true,
                        counterText: '',
                        border: OutlineInputBorder(borderSide: BorderSide(color: TeamlyColors.ink300)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                        hintText: 'Write a comment…',
                        hintStyle: TextStyle(color: TeamlyColors.ink300, fontSize: 13),
                      ),
                      onSubmitted: (v) {
                        if (v.trim().isNotEmpty) onSend(v.trim());
                        ctrl.clear();
                      },
                    ),
                  ),
                  IconButton(
                    onPressed: () {
                      if (ctrl.text.trim().isNotEmpty) onSend(ctrl.text.trim());
                      ctrl.clear();
                    },
                    icon: const Icon(Icons.send_rounded, size: 18, color: TeamlyColors.greenText),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ── Topic chips ────────────────────────────────────────────────────────────────

class _TopicChips extends StatelessWidget {
  const _TopicChips({required this.selected, required this.onSelected});

  final String selected;
  final void Function(String) onSelected;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
        children: <Widget>[
          for (final t in <String>['', ...kDiscoverTopics])
            Padding(
              padding: const EdgeInsets.only(right: TeamlySpace.s2),
              child: GestureDetector(
                onTap: () => onSelected(selected == t ? '' : t),
                child: Container(
                  height: 34,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: selected == t ? context.palette.accent : context.palette.chip,
                    borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                  ),
                  child: Text(
                    t.isEmpty ? 'All' : '#$t',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: selected == t ? context.palette.onAccent : TeamlyColors.ink700,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ── Profile sheet ──────────────────────────────────────────────────────────────

class _ProfileSheet extends StatefulWidget {
  const _ProfileSheet({
    required this.uid,
    required this.name,
    required this.photo,
    required this.savedIds,
    required this.onUnsave,
    required this.onDelete,
    required this.onComment,
  });

  final String uid;
  final String name;
  final String photo;
  final List<String> savedIds;
  final void Function(String postId) onUnsave;
  final void Function(String postId) onDelete;
  final void Function(FeedPost post, String text) onComment;

  @override
  State<_ProfileSheet> createState() => _ProfileSheetState();
}

class _ProfileSheetState extends State<_ProfileSheet> {
  String _tab = 'posts'; // 'posts' | 'saved'
  List<FeedPost>? _mine;
  List<FeedPost>? _saved;

  @override
  void initState() {
    super.initState();
    SocialService.streamFeed(authorUid: widget.uid, limitCount: 50).listen((list) {
      if (mounted) setState(() => _mine = list);
    });
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    final posts = await SocialService.hydratePosts(await SocialService.listSavedIds(widget.uid));
    if (mounted) setState(() => _saved = posts);
  }

  @override
  Widget build(BuildContext context) {
    final list = _tab == 'posts' ? _mine : _saved;
    return SizedBox(
      height: MediaQuery.of(context).size.height * 0.82,
      child: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(TeamlySpace.s4, TeamlySpace.s4, TeamlySpace.s4, TeamlySpace.s2),
            child: Row(
              children: <Widget>[
                _Avatar(photo: widget.photo, name: widget.name, size: 42),
                const SizedBox(width: TeamlySpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(widget.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: TeamlyColors.ink900)),
                      Text(
                        'Your public profile on Discover',
                        style: const TextStyle(fontSize: 12, color: TeamlyColors.ink500),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded, color: TeamlyColors.ink500),
                ),
              ],
            ),
          ),
          TeamlyTabs(
            labels: const <String>['My posts', 'Saved'],
            index: _tab == 'posts' ? 0 : 1,
            onChanged: (i) => setState(() => _tab = i == 0 ? 'posts' : 'saved'),
          ),
          Expanded(
            child: list == null
                ? const Center(child: Text('Loading…', style: TextStyle(color: TeamlyColors.ink300)))
                : list.isEmpty
                    ? Center(
                        child: Text(
                          _tab == 'posts' ? 'You have not posted yet.' : 'Nothing saved yet — tap Save on a post.',
                          style: const TextStyle(color: TeamlyColors.ink300),
                        ),
                      )
                    : RefreshIndicator(
                        onRefresh: _loadSaved,
                        child: ListView(
                          padding: const EdgeInsets.all(TeamlySpace.gutter),
                          children: <Widget>[
                            for (final p in list)
                              Padding(
                                padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
                                child: _PostCard(
                                  post: p,
                                  meUid: widget.uid,
                                  meName: widget.name,
                                  liked: false,
                                  saved: _tab == 'saved',
                                  following: false,
                                  onToggleLike: () {},
                                  onShare: () {},
                                  onToggleSave: _tab == 'saved' ? () => widget.onUnsave(p.id) : () {},
                                  onToggleFollow: () {},
                                  onComment: (text) => widget.onComment(p, text),
                                  onDelete: _tab == 'posts' ? () => widget.onDelete(p.id) : null,
                                ),
                              ),
                          ],
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}

// ── Shared bits ────────────────────────────────────────────────────────────────

class _Avatar extends StatelessWidget {
  const _Avatar({required this.photo, required this.name, required this.size});

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
        style: TextStyle(fontSize: size * 0.4, fontWeight: FontWeight.w700, color: const Color(0xFF1A6B52)),
      ),
    );
  }
}

class _SignInCard extends StatelessWidget {
  const _SignInCard();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
      child: TeamlyCard(
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: const Text(
          'Sign in (top right avatar) to post, react, comment and follow — browsing is open to everyone.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, color: TeamlyColors.ink500),
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.text, required this.palette});

  final String text;
  final MytoPalette palette;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.explore_outlined, size: 40, color: palette.muted),
            const SizedBox(height: 14),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14, height: 1.5, color: TeamlyColors.ink500)),
          ],
        ),
      ),
    );
  }
}

