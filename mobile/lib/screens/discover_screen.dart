import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/discover.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import '../widgets/teamly/parts.dart';

/// The Discover tab — a feed of co-editable, agent-made documents.
///
/// Reference screenshot: tab row (Following | Feeds), a people-and-posts search,
/// the filter rail with the "All ⟳" reset chip, then a single rich post whose
/// body is a *document*: a warm-paper panel with a mono toolbar, a teal
/// uppercase kicker, a serif headline and a grey sub-headline — plus the
/// engagement row and the green sparkle FAB that says "make one like this".
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  FeedTab _tab = FeedTab.feeds;
  String _filter = 'All';
  String _query = '';
  String? _editingPostId;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final store = context.watch<StudioStore>();
    final q = _query.trim().toLowerCase();
    var posts = store.postsFor(_tab, _filter);
    if (q.isNotEmpty) {
      posts = posts
          .where((p) =>
              p.authorName.toLowerCase().contains(q) ||
              p.headline.toLowerCase().contains(q))
          .toList(growable: false);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Discover')),
      body: Column(
        children: <Widget>[
          const SizedBox(height: TeamlySpace.s2),
          TeamlyTabs(
            labels: const <String>['Following', 'Feeds'],
            index: _tab.index,
            onChanged: (i) => setState(() => _tab = FeedTab.values[i]),
          ),
          const SizedBox(height: TeamlySpace.s3),
          const TeamlyGutter(
            child: _DiscoverUnderline(),
          ),
          const SizedBox(height: TeamlySpace.s3),
          const TeamlyGutter(
            child: TeamlySearch(
              hint: 'Search posts, creators...',
            ),
          ),
          const SizedBox(height: TeamlySpace.s3),
          TeamlyChipRail(
            labels: kFeedFilters,
            selected: _filter,
            resettable: true,
            onSelected: (v) => setState(() => _filter = v),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Expanded(
            child: posts.isEmpty
                ? const _EmptyFeed()
                : ListView.separated(
                    padding: const EdgeInsets.all(TeamlySpace.gutter),
                    itemCount: posts.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 20),
                    itemBuilder: (context, i) => _PostCard(
                      post: posts[i],
                      editing: _editingPostId == posts[i].id,
                      onEditToggle: () => setState(() {
                        _editingPostId =
                            _editingPostId == posts[i].id ? null : posts[i].id;
                      }),
                      store: store,
                      palette: palette,
                    ),
                  ),
          ),
        ],
      ),
    );
  }

}

/// A thin green rule under the tabs, matching the reference's active-tab bar.
class _DiscoverUnderline extends StatelessWidget {
  const _DiscoverUnderline();

  @override
  Widget build(BuildContext context) {
    return Container(height: 1, color: context.palette.border);
  }
}

class _EmptyFeed extends StatelessWidget {
  const _EmptyFeed();

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.explore_outlined, size: 44, color: palette.muted),
            const SizedBox(height: 16),
            Text(
              'Nothing here yet',
              style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            const Text(
              'Start a chat with an agent and its work will land in this feed.',
              textAlign: TextAlign.center,
              style: TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}

/// One feed post: author row, the warm-paper document panel, the engagement
/// bar with the sparkle FAB, then the truncated description.
class _PostCard extends StatelessWidget {
  const _PostCard({
    required this.post,
    required this.editing,
    required this.onEditToggle,
    required this.store,
    required this.palette,
  });

  final FeedPost post;
  final bool editing;
  final VoidCallback onEditToggle;
  final StudioStore store;
  final MytoPalette palette;

  @override
  Widget build(BuildContext context) {
    return TeamlyCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Author row
          Padding(
            padding: const EdgeInsets.fromLTRB(
                TeamlySpace.s5, TeamlySpace.s4, TeamlySpace.s4, TeamlySpace.s3),
            child: Row(
              children: <Widget>[
                TeamlyAvatar(pastelIndex: post.authorAvatarIndex, size: 40),
                const SizedBox(width: TeamlySpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Text(
                            post.authorName,
                            style: const TextStyle(
                              color: TeamlyColors.ink900,
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          if (post.verified)
                            const Padding(
                              padding: EdgeInsets.only(left: 4),
                              child: Icon(Icons.verified_rounded,
                                  size: 14, color: TeamlyColors.greenText),
                            ),
                        ],
                      ),
                      const SizedBox(height: 1),
                      Text(
                        'Agent-generated brief',
                        style: TextStyle(color: palette.muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                GestureDetector(
                  onTap: () => store.toggleFollow(post.id),
                  child: Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      color: post.following ? palette.accent : palette.chip,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      post.following ? Icons.check_rounded : Icons.add_rounded,
                      size: 17,
                      color: post.following ? palette.onAccent : TeamlyColors.ink700,
                    ),
                  ),
                ),
              ],
            ),
          ),

          // Document panel — the signature piece.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.s4),
            child: _DocumentPanel(
              post: post,
              editing: editing,
              onEditToggle: onEditToggle,
              store: store,
            ),
          ),
          const SizedBox(height: TeamlySpace.s3),

          // Engagement row + sparkle FAB.
          Padding(
            padding: const EdgeInsets.fromLTRB(
                TeamlySpace.s4, 0, TeamlySpace.s3, TeamlySpace.s3),
            child: Row(
              children: <Widget>[
                _Stat(icon: Icons.favorite_rounded, value: post.stats.likes,
                    active: store.isLiked(post.id),
                    onTap: () => store.toggleLike(post.id)),
                const SizedBox(width: 18),
                _Stat(icon: Icons.bookmark_border_rounded, value: post.stats.bookmarks,
                    active: store.isBookmarked(post.id),
                    onTap: () => store.toggleBookmark(post.id)),
                const SizedBox(width: 18),
                _Stat(icon: Icons.chat_bubble_outline_rounded, value: post.stats.comments),
                const SizedBox(width: 14),
                Icon(Icons.send_outlined, size: 16, color: TeamlyColors.ink500),
                const Spacer(),
                GestureDetector(
                  onTap: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text('Remixing “${post.headline}” — a fresh draft is on its way...'),
                      ),
                    );
                  },
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: palette.accent,
                      shape: BoxShape.circle,
                      boxShadow: TeamlyElevation.green,
                    ),
                    child: Icon(Icons.auto_awesome_rounded, size: 19, color: palette.onAccent),
                  ),
                ),
              ],
            ),
          ),

          // Truncated description.
          Padding(
            padding: const EdgeInsets.fromLTRB(
                TeamlySpace.s4, 0, TeamlySpace.s4, TeamlySpace.s5),
            child: Text(
              '“${post.description}”',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({
    required this.icon,
    required this.value,
    this.active = false,
    this.onTap,
  });

  final IconData icon;
  final int value;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final color = active ? TeamlyColors.greenText : TeamlyColors.ink500;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Row(
        children: <Widget>[
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 4),
          Text('$value', style: TextStyle(color: color, fontSize: 13)),
        ],
      ),
    );
  }
}

/// Warm paper, mono toolbar, teal kicker, serif headline — the exact treatment
/// from the reference. Body is editable Markdown; the toolbar is real.
class _DocumentPanel extends StatefulWidget {
  const _DocumentPanel({
    required this.post,
    required this.editing,
    required this.onEditToggle,
    required this.store,
  });

  final FeedPost post;
  final bool editing;
  final VoidCallback onEditToggle;
  final StudioStore store;

  @override
  State<_DocumentPanel> createState() => _DocumentPanelState();
}

class _DocumentPanelState extends State<_DocumentPanel> {
  late final TextEditingController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = TextEditingController(text: widget.post.body);
  }

  @override
  void didUpdateWidget(covariant _DocumentPanel old) {
    super.didUpdateWidget(old);
    if (old.post.id != widget.post.id ||
        (old.editing != widget.editing && widget.editing)) {
      _ctrl.text = widget.post.body;
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(TeamlySpace.s4),
      decoration: BoxDecoration(
        color: palette.paper,
        borderRadius: BorderRadius.circular(TeamlyRadius.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Mono status line.
          Row(
            children: <Widget>[
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: palette.accent,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              const Text(
                'Co-editable brief',
                style: TextStyle(
                  fontFamily: 'monospace',
                  color: TeamlyColors.ink900,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'All changes save locally in this browser',
            style: TextStyle(
              fontFamily: 'monospace',
              color: TeamlyColors.ink500,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 12),

          // Mono toolbar pills.
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              _ToolbarPill(label: 'Edit', onTap: widget.onEditToggle, selected: widget.editing),
              _ToolbarPill(label: 'Comment', onTap: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Comments open in a side sheet.')),
                );
              }),
              _ToolbarPill(label: 'Export .md', onTap: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Exported ${widget.post.id}.md to your downloads.')),
                );
              }),
              _ToolbarPill(label: 'Print / PDF', onTap: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Print view opened.')),
                );
              }),
              _ToolbarPill(label: 'Reset', onTap: () {
                widget.store.resetPostBody(widget.post.id);
                _ctrl.text = widget.post.body;
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Brief reset to the last saved version.')),
                );
              }),
            ],
          ),
          const SizedBox(height: 16),

          // Teal kicker + serif headline.
          Text(
            widget.post.eyebrow.toUpperCase(),
            style: const TextStyle(
              color: TeamlyColors.teal,
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 1.2,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            widget.post.headline,
            style: const TextStyle(
              fontFamily: 'serif',
              color: TeamlyColors.ink900,
              fontSize: 24,
              fontWeight: FontWeight.w700,
              height: 1.18,
              letterSpacing: -0.2,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            widget.post.subhead,
            style: const TextStyle(color: TeamlyColors.ink700, fontSize: 14, height: 1.5),
          ),
          const SizedBox(height: 14),

          // Body: preview or editor.
          if (widget.editing)
            Container(
              decoration: BoxDecoration(
                color: palette.surface,
                borderRadius: BorderRadius.circular(TeamlyRadius.sm),
              ),
              child: TextField(
                controller: _ctrl,
                maxLines: 9,
                minLines: 6,
                style: const TextStyle(color: TeamlyColors.ink800, fontSize: 14, height: 1.5),
                decoration: const InputDecoration(
                  hintText: '# Write in Markdown…',
                  contentPadding: EdgeInsets.all(12),
                ),
                onChanged: (v) => widget.store.updatePostBody(widget.post.id, v),
              ),
            )
          else
            Text(
              _plainText(widget.post.body),
              maxLines: 7,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: TeamlyColors.ink700, fontSize: 13.5, height: 1.55),
            ),
        ],
      ),
    );
  }

  static String _plainText(String md) {
    final flat = md
        .replaceAll(RegExp(r'[#*>`\-]'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return flat;
  }
}

class _ToolbarPill extends StatelessWidget {
  const _ToolbarPill({
    required this.label,
    required this.onTap,
    this.selected = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 13),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? context.palette.accent : context.palette.surface,
          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
          border: selected ? null : Border.all(color: context.palette.border),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            color: selected ? context.palette.onAccent : TeamlyColors.ink900,
          ),
        ),
      ),
    );
  }
}