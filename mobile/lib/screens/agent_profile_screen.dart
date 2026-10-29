import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/agent_accounts.dart';
import '../services/social_service.dart';
import '../theme.dart';
import '../widgets/crypto_widget.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// AgentProfileScreen — the verified publisher's profile, opened by tapping
/// an agent's name or avatar in the feed. Instagram-style header (same
/// composition as the user profile): avatar top-left, the fixed identity
/// stats to the right (CryptoExpert shows 674K followers / 326 following),
/// bio, link chip, blue tick everywhere. Below: the account's posts.
///
/// Agent accounts have no uid of their own — their posts are fetched by
/// display name (see SocialService.fetchPostsByName) and rendered with the
/// same card as the feed.
/// ---------------------------------------------------------------------------
class AgentProfileScreen extends StatefulWidget {
  const AgentProfileScreen({super.key, required this.agent});

  final AgentAccount agent;

  @override
  State<AgentProfileScreen> createState() => _AgentProfileScreenState();
}

class _AgentProfileScreenState extends State<AgentProfileScreen> {
  List<FeedPost>? _posts;
  bool _following = false;

  /// Agents participate in the follow graph under a stable pseudo-uid derived
  /// from the handle, so a follow survives roster edits.
  String get _agentUid => 'agent:${widget.agent.handle}';

  @override
  void initState() {
    super.initState();
    _load();
    _loadFollowState();
  }

  Future<void> _load() async {
    try {
      final posts = await SocialService.fetchPostsByName(widget.agent.name);
      if (!mounted) return;
      setState(() => _posts = posts);
    } catch (_) {
      // A failed lookup must not leave the profile on "Loading…" forever.
      if (!mounted) return;
      setState(() => _posts = const <FeedPost>[]);
    }
  }

  Future<void> _loadFollowState() async {
    final me = FirebaseAuth.instance.currentUser?.uid ?? '';
    if (me.isEmpty) return;
    try {
      final edge = await FirebaseFirestore.instance
          .collection('follows')
          .doc(me)
          .collection('following')
          .doc(_agentUid)
          .get();
      if (!mounted) return;
      setState(() => _following = edge.exists);
    } on FirebaseException {
      // Badge only.
    }
  }

  Future<void> _toggleFollow() async {
    final me = FirebaseAuth.instance.currentUser?.uid ?? '';
    if (me.isEmpty) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Sign in to follow.')));
      return;
    }
    try {
      if (_following) {
        await SocialService.unfollowAuthor(me, _agentUid);
        if (!mounted) return;
        setState(() => _following = false);
      } else {
        await SocialService.followAuthor(me, _agentUid);
        if (!mounted) return;
        setState(() => _following = true);
      }
    } on FirebaseException {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Could not update — try again.')));
    }
  }

  void _message() {
    // Agents are publishers, not chat partners: the button exists (the roster
    // reads better with it) but a direct message would never get a reply.
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(
        content: Text('AI agents do not reply to direct messages.'),
        duration: Duration(seconds: 2),
      ));
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final agent = widget.agent;
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.maybePop(context),
        ),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Flexible(
              child: Text(
                agent.atHandle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
              ),
            ),
            const SizedBox(width: 5),
            const Icon(Icons.verified_rounded, size: 19, color: Color(0xFF1D9BF0)),
          ],
        ),
        centerTitle: true,
      ),
      body: ListView(
        padding: const EdgeInsets.all(TeamlySpace.gutter),
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Transform.translate(
                offset: const Offset(0, -6),
                child: _AgentAvatar(photo: agent.photo, name: agent.name, size: 84),
              ),
              const SizedBox(width: TeamlySpace.s5),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 14),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: <Widget>[
                      _Stat(label: 'posts', count: '${_posts?.length ?? 0}'),
                      _Stat(label: 'followers', count: agent.followersLabel),
                      _Stat(label: 'following', count: agent.followingLabel),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: TeamlySpace.s3),
          // Follow / Message — the same row real profiles have. Follow wires
          // into the follow graph; Message is honest about being one-way.
          Row(
            children: <Widget>[
              Expanded(
                child: SizedBox(
                  height: 44,
                  child: Material(
                    color: _following ? context.palette.chip : context.palette.accent,
                    borderRadius: BorderRadius.circular(12),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(12),
                      onTap: _toggleFollow,
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          Icon(
                            _following ? Icons.person_rounded : Icons.person_add_alt_rounded,
                            size: 17,
                            color: _following ? TeamlyColors.greenText : context.palette.onAccent,
                          ),
                          const SizedBox(width: 7),
                          Text(
                            _following ? 'Following' : 'Follow',
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: _following ? TeamlyColors.greenText : context.palette.onAccent,
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
                  height: 44,
                  child: Material(
                    color: context.palette.chip,
                    borderRadius: BorderRadius.circular(12),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(12),
                      onTap: _message,
                      child: const Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          Icon(Icons.chat_bubble_outline_rounded, size: 16, color: TeamlyColors.ink900),
                          SizedBox(width: 7),
                          Text(
                            'Message',
                            style: TextStyle(
                              fontSize: 14,
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
          const SizedBox(height: TeamlySpace.s3),
          Row(
            children: <Widget>[
              Flexible(
                child: Text(
                  agent.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
                ),
              ),
              const SizedBox(width: 5),
              const Icon(Icons.verified_rounded, size: 16, color: Color(0xFF1D9BF0)),
            ],
          ),
          const SizedBox(height: 4),
          Text(agent.bio, style: const TextStyle(fontSize: 13.5, height: 1.45, color: TeamlyColors.ink700)),
          const SizedBox(height: TeamlySpace.s3),
          Wrap(
            spacing: TeamlySpace.s2,
            runSpacing: TeamlySpace.s2,
            children: <Widget>[
              for (final t in agent.topics)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                  decoration: BoxDecoration(
                    color: palette.chip,
                    borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    border: Border.all(color: palette.border),
                  ),
                  child: Text(
                    '#$t',
                    style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: TeamlyColors.ink700),
                  ),
                ),
            ],
          ),
          const SizedBox(height: TeamlySpace.s4),
          const TeamlyGroupHeader(label: 'POSTS'),
          const SizedBox(height: TeamlySpace.s1),
          if (_posts == null)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: Text('Loading…', style: TextStyle(color: TeamlyColors.ink300))),
            )
          else if (_posts!.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Center(
                child: Text(
                  'No posts yet — the next one lands at the usual time.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: TeamlyColors.ink300),
                ),
              ),
            )
          else
            for (final p in _posts!)
              Padding(
                padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
                // The same feed card, in read-only-ish mode: the agent's own
                // posts never offer follow/delete, and comments stay off.
                child: _AgentPostCard(post: p),
              ),
        ],
      ),
    );
  }
}

/// The feed's post card is private to discover_screen.dart; the agent profile
/// renders a compact card of its own — text, crypto widget or link card, and
/// the display like count.
class _AgentPostCard extends StatelessWidget {  const _AgentPostCard({required this.post});

  final FeedPost post;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final shown = displayLikeCount(post);
    final likeLabel = shown <= 0
        ? 'Like'
        : shown < 10000
            ? '$shown'
            : '${(shown / 1000).toStringAsFixed(shown < 100000 ? 1 : 0)}K';
    final cryptoPair = cryptoMarkerPair(post.text);
    return TeamlyCard(
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            _relTime(post.createdAtMs),
            style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Text(
            stripCryptoMarkers(post.text),
            style: const TextStyle(fontSize: 14.5, height: 1.45, color: TeamlyColors.ink900),
          ),
          // The crypto desk's live-rate widget, same as the feed card.
          if (cryptoPair != null) ...<Widget>[
            const SizedBox(height: TeamlySpace.s3),
            CryptoMiniCard(pair: cryptoPair),
          ],
          if (post.linkTitle.isNotEmpty || post.linkSite.isNotEmpty) ...<Widget>[
            const SizedBox(height: TeamlySpace.s3),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: palette.chip,
                borderRadius: BorderRadius.circular(TeamlyRadius.md),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (post.linkImage.isNotEmpty)
                    ClipRRect(
                      borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
                      child: Image.network(
                        post.linkImage,
                        width: double.infinity,
                        height: 150,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => const SizedBox(width: double.infinity, height: 0),
                      ),
                    ),
                  if (post.linkTitle.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        post.linkTitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: TeamlyColors.ink900),
                      ),
                    ),
                  Text(
                    post.linkSite.isEmpty ? post.link : post.linkSite,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11.5, color: TeamlyColors.ink300),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: TeamlySpace.s2),
          Row(
            children: <Widget>[
              const Icon(Icons.favorite_rounded, size: 16, color: TeamlyColors.danger),
              const SizedBox(width: 5),
              Text(
                likeLabel,
                style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: TeamlyColors.ink500),
              ),
              const SizedBox(width: 14),
              const Icon(Icons.chat_bubble_rounded, size: 16, color: TeamlyColors.ink300),
              const SizedBox(width: 5),
              const Text(
                'Comments off',
                style: TextStyle(fontSize: 12.5, color: TeamlyColors.ink300),
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _relTime(int ms) {
    if (ms == 0) return 'just now';
    final diff = DateTime.now().millisecondsSinceEpoch - ms;
    final s = diff ~/ 1000;
    if (s < 60) return '${s}s ago';
    if (s < 3600) return '${s ~/ 60}m ago';
    if (s < 86400) return '${s ~/ 3600}h ago';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    return '${d.day}/${d.month}';
  }
}

/// The agent's avatar: CDN art with the initial-disc fallback.
class _AgentAvatar extends StatelessWidget {
  const _AgentAvatar({required this.photo, required this.name, required this.size});

  final String photo;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: context.palette.pastel(2),
        shape: BoxShape.circle,
        border: Border.all(color: context.palette.surface, width: 2),
      ),
      clipBehavior: Clip.antiAlias,
      alignment: Alignment.center,
      child: photo.isEmpty
          ? Text(
              name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
              style: TextStyle(fontSize: size * 0.36, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
            )
          : Image.network(
              photo,
              width: size,
              height: size,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Text(
                name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
                style: TextStyle(fontSize: size * 0.36, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
              ),
            ),
    );
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
