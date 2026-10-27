import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_service.dart';
import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'notifications_sheet.dart';

/// ---------------------------------------------------------------------------
/// DiscoverScreen — Home: the Myto community feed, backed by Firestore (the
/// same feed the website's /discover serves; see services/social_service.dart
/// + firestore.rules).
///
/// Header (per the design spec): back icon → tools menu, "Myto" in cursive,
/// notification bell → activity sheet.
///
/// The "For you" feed flows by PRIORITY, not pure recency: engagement +
/// recency + who-you-follow + a per-refresh jitter (see
/// SocialService.prioritizePosts), and cards enter with a step-by-step
/// staggered animation.
/// ---------------------------------------------------------------------------
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key, this.onOpenTools});

  /// Opens the tools menu (AI Chat / Helper / Agents / Memory / Artifacts).
  final VoidCallback? onOpenTools;

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  // Three destinations: 'foryou' | 'viral' | 'following'.
  String _dest = 'foryou';
  String _topic = '';
  int _seed = 0; // re-jittered on pull-to-refresh so the flow changes
  final Set<String> _likedIds = <String>{};
  final Set<String> _savedIds = <String>{};
  final Set<String> _followingIds = <String>{};
  bool _setsLoaded = false;
  List<FeedPost>? _followingPosts;

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
      backgroundColor: palette.bg,
      appBar: AppBar(
        // The spec's header: back icon · Myto (cursive) · notification bell.
        leading: IconButton(
          tooltip: 'Myto tools',
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: widget.onOpenTools,
        ),
        title: const Text(
          'Myto',
          style: TextStyle(
            fontFamily: 'Dancing Script',
            fontSize: 30,
            fontWeight: FontWeight.w700,
            color: TeamlyColors.ink900,
          ),
        ),
        centerTitle: false,
        actions: <Widget>[
          IconButton(
            tooltip: 'Notifications',
            icon: const Icon(Icons.notifications_none_rounded, size: 24),
            onPressed: () => showNotificationsSheet(context),
          ),
          const SizedBox(width: TeamlySpace.s1),
        ],
      ),
      body: Column(
        children: <Widget>[
          const SizedBox(height: TeamlySpace.s2),
          // Three destinations — For you / Viral / Following.
          Container(
            margin: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            padding: const EdgeInsets.all(3),
            decoration: BoxDecoration(
              color: palette.chip,
              borderRadius: BorderRadius.circular(TeamlyRadius.pill),
            ),
            child: Row(
              children: <Widget>[
                for (final d in const <String, String>{
                  'foryou': 'For you',
                  'viral': 'Viral',
                  'following': 'Following',
                }.entries)
                  Expanded(
                    child: GestureDetector(
                      onTap: () => setState(() => _dest = d.key),
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: _dest == d.key ? palette.surface : Colors.transparent,
                          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                        ),
                        child: Text(
                          d.value,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: _dest == d.key ? FontWeight.w600 : FontWeight.w500,
                            color: _dest == d.key ? palette.text : palette.muted,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          _TopicChips(selected: _topic, onSelected: (t) => setState(() => _topic = t)),
          const SizedBox(height: TeamlySpace.s2),
          if (_uid.isEmpty) const _SignInCard(),
          Expanded(child: _feedArea(palette)),
        ],
      ),
    );
  }

  Widget _feedArea(MytoPalette palette) {
    if (_dest == 'following') {
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
        child: _StaggeredFeed(posts: list, buildCard: _buildCard),
      );
    }

    // For you + Viral both stream live; For you re-ranks with priority + jitter.
    return StreamBuilder<List<FeedPost>>(
      key: ValueKey<String>('feed:$_dest:$_topic'),
      stream: _dest == 'viral'
          ? SocialService().streamViralFeed(topic: _topic.isEmpty ? null : _topic)
          : SocialService.streamFeed(topic: _topic.isEmpty ? null : _topic),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
          return _Empty(text: 'Loading the feed…', palette: palette);
        }
        var posts = snap.data ?? const <FeedPost>[];
        if (_dest == 'foryou') {
          posts = SocialService.prioritizePosts(
            posts,
            following: _followingIds,
            seed: _seed,
          );
        }
        if (posts.isEmpty) {
          return _Empty(
            text: _dest == 'viral'
                ? 'No popular posts yet — likes decide what rises.'
                : 'Nothing here yet — tap the green + to post first.',
            palette: palette,
          );
        }
        return RefreshIndicator(
          // A pull-to-refresh re-jitters the For you flow (new order, same posts).
          onRefresh: () async => setState(() => _seed++),
          child: _StaggeredFeed(posts: posts, buildCard: _buildCard),
        );
      },
    );
  }

  Widget _buildCard(FeedPost post) {
    return _PostCard(
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
    );
  }
}

// ── Step-by-step staggered feed ────────────────────────────────────────────────

/// Wraps each post card in a fade+slide entrance, delayed by its index — the
/// "step by step" reveal. The stagger caps out so long feeds don't feel slow.
class _StaggeredFeed extends StatelessWidget {
  const _StaggeredFeed({required this.posts, required this.buildCard});

  final List<FeedPost> posts;
  final Widget Function(FeedPost post) buildCard;

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      itemCount: posts.length,
      itemBuilder: (context, i) {
        return _StaggerIn(
          delay: Duration(milliseconds: 60 * (i < 10 ? i : 10)),
          child: Padding(
            padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
            child: buildCard(posts[i]),
          ),
        );
      },
    );
  }
}

class _StaggerIn extends StatefulWidget {
  const _StaggerIn({required this.delay, required this.child});

  final Duration delay;
  final Widget child;

  @override
  State<_StaggerIn> createState() => _StaggerInState();
}

class _StaggerInState extends State<_StaggerIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
  );
  late final Animation<double> _fade = CurvedAnimation(parent: _c, curve: Curves.easeOut);
  late final Animation<Offset> _slide = Tween<Offset>(
    begin: const Offset(0, 0.05),
    end: Offset.zero,
  ).animate(_fade);

  @override
  void initState() {
    super.initState();
    Timer(widget.delay, () {
      if (mounted) _c.forward();
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _fade,
      child: SlideTransition(position: _slide, child: widget.child),
    );
  }
}

// ── Post card ──────────────────────────────────────────────────────────────────

class _PostCard extends StatelessWidget {
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
  Widget build(BuildContext context) {
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
              if (meUid.isNotEmpty && post.uid != meUid)
                GestureDetector(
                  onTap: onToggleFollow,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                    decoration: BoxDecoration(
                      color: following ? context.palette.chip : context.palette.accent,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                    child: Text(
                      following ? 'Following' : 'Follow',
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                        color: following ? TeamlyColors.ink700 : context.palette.onAccent,
                      ),
                    ),
                  ),
                ),
              if (meUid.isNotEmpty && post.uid == meUid && onDelete != null)
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
                              onDelete!();
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
                icon: liked ? Icons.favorite_rounded : Icons.favorite_border_rounded,
                color: liked ? TeamlyColors.danger : TeamlyColors.ink500,
                label: post.likeCount > 0 ? '${post.likeCount}' : 'Like',
                onTap: meUid.isEmpty ? null : onToggleLike,
              ),
              const SizedBox(width: 10),
              _CommentsAction(
                post: post,
                meUid: meUid,
                meName: meName,
                onComment: onComment,
              ),
              const SizedBox(width: 10),
              _Action(
                icon: Icons.reply_rounded,
                color: TeamlyColors.ink500,
                label: post.shareCount > 0 ? '${post.shareCount}' : 'Share',
                onTap: meUid.isEmpty ? null : onShare,
              ),
              const Spacer(),
              if (meUid.isNotEmpty)
                _Action(
                  icon: saved ? Icons.bookmark_rounded : Icons.bookmark_border_rounded,
                  color: saved ? TeamlyColors.greenText : TeamlyColors.ink500,
                  label: saved ? 'Saved' : 'Save',
                  onTap: onToggleSave,
                ),
            ],
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

/// Comment action that expands the thread inline beneath its own card.
class _CommentsAction extends StatefulWidget {
  const _CommentsAction({
    required this.post,
    required this.meUid,
    required this.meName,
    required this.onComment,
  });

  final FeedPost post;
  final String meUid;
  final String meName;
  final void Function(String text) onComment;

  @override
  State<_CommentsAction> createState() => _CommentsActionState();
}

class _CommentsActionState extends State<_CommentsAction> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _Action(
          icon: Icons.chat_bubble_outline_rounded,
          color: TeamlyColors.ink500,
          label: widget.post.commentCount > 0 ? '${widget.post.commentCount}' : 'Comment',
          onTap: () => setState(() => _open = !_open),
        ),
        if (_open)
          _Comments(
            postId: widget.post.id,
            meUid: widget.meUid,
            meName: widget.meName,
            onSend: widget.onComment,
          ),
      ],
    );
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
    return Container(
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
          'Sign in (Profile tab) to post, react, comment, follow and DM — browsing is open to everyone.',
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
