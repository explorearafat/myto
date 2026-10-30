import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/agent_accounts.dart';
import '../services/agent_feed_service.dart';
import '../services/auth_service.dart';
import '../services/notification_service.dart';
import '../services/verified.dart';
import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/crypto_widget.dart';
import '../widgets/teamly/kit.dart';
import 'agent_profile_screen.dart';
import 'messages_screen.dart';
import 'notifications_sheet.dart';
import 'post_composer_page.dart';
import 'user_profile_screen.dart';

/// ---------------------------------------------------------------------------
/// DiscoverScreen — the Myto community feed, backed by Firestore (the
/// same feed the website's /discover serves; see services/social_service.dart
/// + firestore.rules).
///
/// Header (per the design spec): back icon → the Chat landing tab, "Myto" in
/// cursive, notification bell → activity sheet.
///
/// The "For you" feed flows by PRIORITY, not pure recency: engagement +
/// recency + who-you-follow + a per-refresh jitter (see
/// SocialService.prioritizePosts), and cards enter with a step-by-step
/// staggered animation.
///
/// Verified agents (see services/agent_accounts.dart) post on a daily
/// schedule: their cards show the blue tick, a display-only reaction count
/// that climbs into the 90K–180K band, no comment composer, and — for the
/// crypto desk — a live rate + chart widget in place of the plain text marker.
/// ---------------------------------------------------------------------------
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  int _seed = 0; // re-jittered on pull-to-refresh so the flow changes
  final Set<String> _likedIds = <String>{};
  final Set<String> _savedIds = <String>{};
  final Set<String> _followingIds = <String>{};

  // Smart search — community people + post hits, debounced one-shots. While a
  // query is active the results replace the feed.
  Timer? _searchDebounce;
  String _query = '';
  List<DiscoverProfile>? _people;
  List<FeedPost>? _postHits;

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
    // The verified agents publish on a daily schedule — any slot that passed
    // without a post (app was closed) seeds now. Best-effort, never blocks UI.
    AgentFeedService.seedIfDue().catchError((_) {});
  }

  Future<void> _loadSets() async {
    if (_uid.isEmpty) return;
    final saved = await SocialService.listSavedIds(_uid);
    final following = await SocialService.getFollowingIds(_uid);
    if (!mounted) return;
    setState(() {
      _savedIds.addAll(saved);
      _followingIds.addAll(following);
    });
  }

  Future<void> _toast(String message) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 2)));
  }

  void _onSearch(String v) {
    setState(() => _query = v);
    _searchDebounce?.cancel();
    final q = v.trim().toLowerCase();
    if (q.length < 2) {
      _people = null;
      _postHits = null;
      return;
    }
    _searchDebounce = Timer(const Duration(milliseconds: 450), () async {
      try {
        final profiles = await SocialService.fetchProfileSample();
        final posts = await SocialService.fetchRecentPosts();
        if (!mounted) return;
        setState(() {
          _people = profiles
              .where((p) => p.name.toLowerCase().contains(q) || p.username.contains(q))
              .take(10)
              .toList();
          _postHits = posts.where((p) => p.text.toLowerCase().contains(q)).take(20).toList();
        });
      } catch (_) {
        // Search quietly shows nothing new when Firestore is unreachable.
      }
    });
  }

  Future<void> _compose() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PostComposerPage(
          onPosted: () {
            if (!mounted) return;
            ScaffoldMessenger.of(context)
              ..hideCurrentSnackBar()
              ..showSnackBar(const SnackBar(content: Text('Posted to Discover.')));
          },
        ),
      ),
    );
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
        // The spec's header: Myto (cursive) · messages · notifications bell.
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
            tooltip: 'Messages',
            icon: const Icon(Icons.chat_bubble_outline_rounded, size: 22),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const MessagesScreen()),
            ),
          ),
          _BellWithBadge(onTap: () => showNotificationsSheet(context)),
          const SizedBox(width: TeamlySpace.s1),
        ],
      ),
      body: Column(
        children: <Widget>[
          const SizedBox(height: TeamlySpace.s2),
          // Smart search — people + posts — with the post button at its right.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TeamlySearch(
                    hint: 'Search people and posts',
                    onChanged: _onSearch,
                  ),
                ),
                const SizedBox(width: TeamlySpace.s2),
                GestureDetector(
                  onTap: _uid.isEmpty ? null : _compose,
                  child: Icon(
                    Icons.add_circle_rounded,
                    size: 30,
                    color: _uid.isEmpty ? palette.muted : palette.accent,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          if (_uid.isEmpty) const _SignInCard(),
          Expanded(child: _feedArea(palette)),
        ],
      ),
    );
  }

  Widget _feedArea(MytoPalette palette) {
    // While a search query is active, its results replace the feed.
    final q = _query.trim().toLowerCase();
    if (q.length >= 2) {
      final people = _people;
      final hits = _postHits;
      if (people == null || hits == null) {
        return _Empty(text: 'Searching…', palette: palette);
      }
      if (people.isEmpty && hits.isEmpty) {
        return _Empty(text: 'Nothing matches “$_query”.', palette: palette);
      }
      return ListView(
        padding: const EdgeInsets.all(TeamlySpace.gutter),
        children: <Widget>[
          if (people.isNotEmpty) ...<Widget>[
            const TeamlyGroupHeader(label: 'PEOPLE'),
            for (final p in people)
              InkWell(
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => UserProfileScreen(uid: p.uid, name: p.name, photo: p.photo),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    children: <Widget>[
                      _SearchAvatar(photo: p.photo, name: p.name),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              p.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: TeamlyColors.ink900,
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            if (p.username.isNotEmpty)
                              Text(
                                '@${p.username}',
                                style: const TextStyle(
                                  color: TeamlyColors.greenText,
                                  fontSize: 12.5,
                                ),
                              ),
                          ],
                        ),
                      ),
                      const Icon(Icons.chat_bubble_outline_rounded, size: 18, color: TeamlyColors.ink300),
                    ],
                  ),
                ),
              ),
          ],
          if (hits.isNotEmpty) ...<Widget>[
            const SizedBox(height: TeamlySpace.s3),
            const TeamlyGroupHeader(label: 'POSTS'),
            for (final post in hits) _buildCard(post),
          ],
        ],
      );
    }

    // The single live feed, re-ranked with priority + jitter.
    return StreamBuilder<List<FeedPost>>(
      key: ValueKey<String>('feed:$_seed'),
      stream: SocialService.streamFeed(),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
          return _Empty(text: 'Loading the feed…', palette: palette);
        }
        var posts = snap.data ?? const <FeedPost>[];
        posts = SocialService.prioritizePosts(
          posts,
          following: _followingIds,
          seed: _seed,
        );
        if (posts.isEmpty) {
          return _Empty(
            text: 'Nothing here yet — tap the + to post first.',
            palette: palette,
          );
        }
        return RefreshIndicator(
          // A pull-to-refresh re-jitters the flow (new order, same posts).
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
      onToggleLike: () {
        // Optimistic: the heart flips instantly from local state; the write
        // lands in the background and reverts on failure. No await in the UI
        // path — the feed never waits on the network for a like.
        final wasLiked = _likedIds.contains(post.id);
        setState(() => wasLiked ? _likedIds.remove(post.id) : _likedIds.add(post.id));
        SocialService.toggleLike(post.id, _uid).then((nowLiked) {
          if (!mounted) return;
          setState(() {
            if (nowLiked) {
              _likedIds.add(post.id);
            } else {
              _likedIds.remove(post.id);
            }
          });
        }).catchError((_) {
          if (!mounted) return;
          setState(() => wasLiked ? _likedIds.add(post.id) : _likedIds.remove(post.id));
          _toast('Could not save that — try again.');
        });
      },
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
            });
          } else {
            await SocialService.followAuthor(_uid, post.uid);
            setState(() {
              _followingIds.add(post.uid);
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
          key: ValueKey<String>(posts[i].id),
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
  const _StaggerIn({super.key, required this.delay, required this.child});

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
    final agent = agentForPost(post);
    final cryptoPair = cryptoMarkerPair(post.text);
    return TeamlyCard(
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              GestureDetector(
                onTap: () => _openAuthor(context, agent, post),
                child: _Avatar(photo: post.photo, name: post.name, size: 38),
              ),
              const SizedBox(width: TeamlySpace.s3),
              Expanded(
                child: GestureDetector(
                  onTap: () => _openAuthor(context, agent, post),
                  behavior: HitTestBehavior.opaque,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          _AuthorLabel(post: post, agent: agent),
                          // Blue verified tick — publisher accounts and the
                          // verified real account.
                          if (agent != null) ...<Widget>[
                            const SizedBox(width: 4),
                            const _VerifiedTick(size: 15),
                          ],
                        ],
                      ),
                      Text(
                        _time(post.createdAtMs),
                        style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
                      ),
                    ],
                  ),
                ),
              ),
              // Real accounts follow real accounts — agents carry the tick
              // instead, and the seeder never sees a delete button on them.
              if (agent == null && meUid.isNotEmpty && post.uid != meUid)
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
              if (agent == null && meUid.isNotEmpty && post.uid == meUid && onDelete != null)
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
          // The crypto desk's live-rate marker renders as the chart widget.
          if (cryptoPair != null) ...<Widget>[
            const SizedBox(height: TeamlySpace.s3),
            CryptoMiniCard(pair: cryptoPair),
          ],
          if (post.link.isNotEmpty && cryptoPair == null) ...<Widget>[
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
                // Verified agents display their pseudo-count (90K–180K base,
                // real likes stack on top); everyone else shows the real one.
                label: _likeLabel(post),
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

  void _openAgentProfile(BuildContext context, AgentAccount agent) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => AgentProfileScreen(agent: agent)),
    );
  }

  /// An author row: verified agents open their agent profile; real users open
  /// their public profile (Follow / Message).
  void _openAuthor(BuildContext context, AgentAccount? agent, FeedPost post) {
    if (agent != null) {
      _openAgentProfile(context, agent);
      return;
    }
    if (post.uid.isEmpty) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => UserProfileScreen(uid: post.uid, name: post.name, photo: post.photo),
      ),
    );
  }

  /// The like pill's label: raw count under 10K, K-compact above it (agent
  /// pseudo-counts live in the 90K–180K band, so they always compact).
  String _likeLabel(FeedPost post) {
    final shown = displayLikeCount(post);
    if (shown <= 0) return 'Like';
    if (shown < 10000) return '$shown';
    return '${(shown / 1000).toStringAsFixed(shown < 100000 ? 1 : 0)}K';
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
/// Verified agents' posts have comments turned OFF — the row reads "Off" and
/// expanding shows the notice instead of a thread/composer.
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
    final open = commentsOpenFor(widget.post);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _Action(
          icon: open ? Icons.chat_bubble_outline_rounded : Icons.chat_bubble_rounded,
          color: open ? TeamlyColors.ink500 : TeamlyColors.ink300,
          label: !open
              ? 'Off'
              : widget.post.commentCount > 0
                  ? '${widget.post.commentCount}'
                  : 'Comment',
          onTap: open ? () => setState(() => _open = !_open) : null,
        ),
        if (!open)
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Text(
              'Comments are turned off.',
              style: TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
            ),
          ),
        if (open && _open)
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
    // Crypto markers render as the live chart widget one row below — the raw
    // `[[crypto:…]]` token never shows in the text itself.
    final body = stripCryptoMarkers(text);
    final spans = <TextSpan>[];
    final re = RegExp(r'(https://[^\s]+)|(#([a-z0-9]{1,20}))', caseSensitive: false);
    var last = 0;
    for (final m in re.allMatches(body)) {
      if (m.start > last) {
        spans.add(TextSpan(text: body.substring(last, m.start)));
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
    if (last < body.length) spans.add(TextSpan(text: body.substring(last)));
    return SelectableText.rich(
      TextSpan(
        style: const TextStyle(fontSize: 14.5, height: 1.45, color: TeamlyColors.ink900),
        children: spans,
      ),
    );
  }
}

/// The blue verified badge next to a publisher's name.
class _VerifiedTick extends StatelessWidget {
  const _VerifiedTick({this.size = 15});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Icon(Icons.verified_rounded, size: size, color: const Color(0xFF1D9BF0));
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
                                Row(
                                  children: <Widget>[
                                    Flexible(
                                      child: Text(
                                        c.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                                      ),
                                    ),
                                    if (isAgentAuthor(c.name)) ...<Widget>[
                                      const SizedBox(width: 3),
                                      const _VerifiedTick(size: 12),
                                    ],
                                  ],
                                ),
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
          'Sign in (avatar on the Chat tab) to post, react, comment, follow and DM — browsing is open to everyone.',
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

/// A circular avatar for a search hit: photo when present, initial otherwise.
class _SearchAvatar extends StatelessWidget {
  const _SearchAvatar({required this.photo, required this.name});

  final String photo;
  final String name;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipOval(
        child: Image.network(
          photo,
          width: 42,
          height: 42,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(context),
        ),
      );
    }
    return _initial(context);
  }

  Widget _initial(BuildContext context) {
    return Container(
      width: 42,
      height: 42,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: context.palette.pastel(1),
        shape: BoxShape.circle,
      ),
      child: Text(
        name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
      ),
    );
  }
}

/// The post's author line: real users show their @handle (falling back to the
/// display name) with the blue tick once their profile is verified; agents
/// render as before. The profile facts load once per author and are cached for
/// the whole session, so the feed never re-fetches while scrolling.
class _AuthorLabel extends StatefulWidget {
  const _AuthorLabel({required this.post, required this.agent});

  final FeedPost post;
  final AgentAccount? agent;

  @override
  State<_AuthorLabel> createState() => _AuthorLabelState();
}

class _AuthorLabelState extends State<_AuthorLabel> {
  ({bool verified, String username})? _facts;

  @override
  void initState() {
    super.initState();
    if (widget.agent == null && widget.post.uid.isNotEmpty) {
      final cached = authorFactsCached(widget.post.uid);
      if (cached != null) {
        _facts = cached;
      } else {
        loadAuthorFacts(widget.post.uid).then((f) {
          if (!mounted || f == null) return;
          setState(() => _facts = f);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.agent != null) {
      return Flexible(
        child: Text(
          widget.post.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
        ),
      );
    }
    final facts = _facts;
    final label = (facts != null && facts.username.isNotEmpty) ? '@${facts.username}' : widget.post.name;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
          ),
        ),
        if (facts != null && facts.verified) ...<Widget>[
          const SizedBox(width: 4),
          const Icon(Icons.verified_rounded, size: 14, color: Color(0xFF1D9BF0)),
        ],
      ],
    );
  }
}

/// The header bell with a live red unread badge. The count is the user's
/// unread notifications (NotificationService), so a new DM, like, comment or
/// share lights the badge as it arrives; opening the sheet (or the messages
/// list, for DMs) marks things read and the badge clears on the same stream.
class _BellWithBadge extends StatelessWidget {
  const _BellWithBadge({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final uid = FirebaseAuth.instance.currentUser?.uid ?? '';
    if (uid.isEmpty) {
      return IconButton(
        tooltip: 'Notifications',
        icon: const Icon(Icons.notifications_none_rounded, size: 24),
        onPressed: onTap,
      );
    }
    return StreamBuilder<List<AppNotification>>(
      stream: NotificationService.stream(uid),
      builder: (context, snap) {
        final unread =
            (snap.data ?? const <AppNotification>[]).where((n) => !n.read).length;
        return IconButton(
          tooltip: 'Notifications',
          icon: Stack(
            clipBehavior: Clip.none,
            children: <Widget>[
              const Icon(Icons.notifications_none_rounded, size: 24),
              if (unread > 0)
                Positioned(
                  right: -5,
                  top: -5,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                    constraints: const BoxConstraints(minWidth: 15),
                    decoration: BoxDecoration(
                      color: TeamlyColors.danger,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: Colors.white, width: 1),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      unread > 9 ? '9+' : '$unread',
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w700,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          onPressed: onTap,
        );
      },
    );
  }
}
