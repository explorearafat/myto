import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/memory.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import '../widgets/teamly/parts.dart';

/// The Memory tab — the auto-built private wiki.
///
/// Reference screenshot: search, then a toolbar (All 3 · Updates 1 · Tags ⌄ ·
/// + New), then four pinned colour-tile system pages, then a collapsible
/// uppercase group (⌄ GETTING STARTED 3) of document rows with NEW dots.
///
/// The one signal that unifies all of it: `isNew`. It drives the NEW dot on the
/// row, the `Updates n` chip, and the badge on the bottom nav — three places,
/// one number, and [StudioStore.newCount] is that number.
class MemoryScreen extends StatefulWidget {
  const MemoryScreen({super.key, this.onOpenProfile, this.onOpenArtifacts});

  /// "My Profile" tile → the user's Discover profile (tab 3 of the old shell
  /// lives behind this callback now).
  final VoidCallback? onOpenProfile;

  /// "My Artifacts" tile → the Artifacts tab.
  final VoidCallback? onOpenArtifacts;

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  MemoryScope _scope = MemoryScope.all;
  String? _selectedTag;
  final Set<String> _collapsed = <String>{};

  @override
  Widget build(BuildContext context) {
    final store = context.watch<StudioStore>();
    final system = store.systemDocs;

    // Build the body once, cheaply, per scope.
    final Widget body;
    if (_scope == MemoryScope.updates) {
      final updates = store.docsFor(MemoryScope.updates);
      body = updates.isEmpty
          ? _empty('You\'re all caught up.', 'No new pages since you last looked.', Icons.done_all_rounded)
          : _docsList(updates, store);
    } else if (_scope == MemoryScope.tags) {
      final tag = _selectedTag ?? (store.allTags.isNotEmpty ? store.allTags.first : null);
      final tagged = tag == null ? <WikiDoc>[] : store.docsFor(MemoryScope.tags, tag: tag);
      body = tagged.isEmpty
          ? _empty('Nothing tagged yet.', 'Tags appear automatically as your wiki grows.', Icons.sell_outlined)
          : _docsList(tagged, store);
    } else {
      body = ListView(
        padding: const EdgeInsets.only(bottom: TeamlySpace.s8),
        children: <Widget>[
          // Pinned system pages — the only place solid accent colour appears.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: Wrap(
              spacing: TeamlySpace.s3,
              runSpacing: TeamlySpace.s3,
              children: <Widget>[
                for (final d in system)
                  _SystemTile(doc: d, store: store, onOpenProfile: widget.onOpenProfile, onOpenArtifacts: widget.onOpenArtifacts),
              ],
            ),
          ),
          const SizedBox(height: TeamlySpace.s6),
          // Collapsible groups.
          for (final group in store.docGroups) ...<Widget>[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
              child: TeamlyGroupHeader(
                label: group.toUpperCase(),
                count: store.docsIn(group).length,
                expanded: !_collapsed.contains(group),
                onToggle: () => setState(() {
                  if (!_collapsed.add(group)) _collapsed.remove(group);
                }),
              ),
            ),
            if (!_collapsed.contains(group))
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
                child: Column(
                  children: <Widget>[
                    for (final d in store.docsIn(group))
                      Padding(
                        padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
                        child: TeamlyDocRow(
                          doc: d,
                          onTap: () {
                            store.markDocRead(d.id);
                            _openDoc(d, store);
                          },
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ],
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Memory')),
      body: Column(
        children: <Widget>[
          const SizedBox(height: TeamlySpace.s2),
          const TeamlyGutter(child: TeamlySearch(hint: 'Search topics...')),
          const SizedBox(height: TeamlySpace.s3),
          // Toolbar: All · Updates · Tags · + New
          TeamlyGutter(
            child: Row(
              children: <Widget>[
                _ToolbarChip(
                  label: 'All ${store.docs.where((d) => !d.isSystem).length}',
                  selected: _scope == MemoryScope.all,
                  onTap: () => setState(() => _scope = MemoryScope.all),
                ),
                const SizedBox(width: TeamlySpace.s2),
                _ToolbarChip(
                  label: 'Updates ${store.newCount}',
                  selected: _scope == MemoryScope.updates,
                  dot: store.newCount > 0,
                  onTap: () => setState(() => _scope = MemoryScope.updates),
                ),
                const SizedBox(width: TeamlySpace.s2),
                _ToolbarChip(
                  label: 'Tags',
                  chevron: true,
                  selected: _scope == MemoryScope.tags,
                  onTap: () => _pickTag(store),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () => _newDoc(store),
                  child: const Text(
                    '+ New',
                    style: TextStyle(
                      color: TeamlyColors.greenLink,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          if (_scope == MemoryScope.tags)
            Padding(
              padding: const EdgeInsets.only(bottom: TeamlySpace.s2),
              child: TeamlyGutter(
                child: SizedBox(
                  height: 36,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: <Widget>[
                      for (final t in store.allTags)
                        Padding(
                          padding: const EdgeInsets.only(right: TeamlySpace.s2),
                          child: TeamlyChip(
                            label: '#$t',
                            selected: _selectedTag == t,
                            onTap: () => setState(() => _selectedTag = t),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          Expanded(child: body),
        ],
      ),
    );
  }

  Widget _docsList(List<WikiDoc> docs, StudioStore store) {
    return ListView.separated(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      itemCount: docs.length,
      separatorBuilder: (_, __) => const SizedBox(height: TeamlySpace.s3),
      itemBuilder: (context, i) {
        final d = docs[i];
        return TeamlyDocRow(
          doc: d,
          onTap: () {
            store.markDocRead(d.id);
            _openDoc(d, store);
          },
        );
      },
    );
  }

  Widget _empty(String title, String sub, IconData icon) {
    final palette = context.palette;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 44, color: palette.muted),
            const SizedBox(height: 16),
            Text(title, style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(sub,
                textAlign: TextAlign.center,
                style: const TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5)),
          ],
        ),
      ),
    );
  }

  Future<void> _pickTag(StudioStore store) async {
    final tags = store.allTags;
    if (tags.isEmpty) {
      _snack('No tags yet — they appear as your wiki grows.');
      return;
    }
    final chosen = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: context.palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (final t in tags)
              ListTile(
                leading: Icon(Icons.sell_outlined, size: 20, color: context.palette.accentText),
                title: Text('#$t', style: const TextStyle(color: TeamlyColors.ink900)),
                trailing: _selectedTag == t
                    ? Icon(Icons.check_rounded, color: context.palette.accent)
                    : null,
                onTap: () => Navigator.pop(context, t),
              ),
          ],
        ),
      ),
    );
    if (chosen != null && mounted) {
      setState(() {
        _selectedTag = chosen;
        _scope = MemoryScope.tags;
      });
    }
  }

  void _newDoc(StudioStore store) async {
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: context.palette.surface,
        title: const Text('New page'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(TeamlyRadius.lg)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Page title'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Create', style: TextStyle(color: TeamlyColors.greenText)),
          ),
        ],
      ),
    );
    if (ok == true && ctrl.text.trim().isNotEmpty && mounted) {
      final d = store.addDoc(title: ctrl.text);
      setState(() => _scope = MemoryScope.all);
      _openDoc(d, store);
    }
  }

  void _openDoc(WikiDoc doc, StudioStore store) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.palette.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) {
        final ctrl = TextEditingController(text: doc.body);
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.75,
          maxChildSize: 0.95,
          builder: (context, scroll) => Column(
            children: <Widget>[
              Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(top: 10, bottom: 8),
                decoration: BoxDecoration(
                  color: context.palette.border,
                  borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.s5),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        doc.title,
                        style: const TextStyle(
                          color: TeamlyColors.ink900,
                          fontSize: 19,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Done', style: TextStyle(color: TeamlyColors.greenText)),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  controller: scroll,
                  padding: const EdgeInsets.all(TeamlySpace.s5),
                  children: <Widget>[
                    if (doc.isSystem)
                      Row(
                        children: <Widget>[
                          TeamlyTopicTile(accentIndex: doc.accentIndex, icon: Icons.menu_book_rounded, size: 32),
                          const SizedBox(width: TeamlySpace.s3),
                          Expanded(
                            child: Text(
                              doc.subtitle,
                              style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                            ),
                          ),
                        ],
                      ),
                    const SizedBox(height: TeamlySpace.s3),
                    Container(
                      decoration: BoxDecoration(
                        color: context.palette.paper,
                        borderRadius: BorderRadius.circular(TeamlyRadius.md),
                      ),
                      padding: const EdgeInsets.all(TeamlySpace.s4),
                      child: TextField(
                        controller: ctrl,
                        maxLines: null,
                        style: const TextStyle(color: TeamlyColors.ink800, fontSize: 14.5, height: 1.55),
                        onChanged: (v) => store.updateDocBody(doc.id, v),
                        decoration: const InputDecoration(
                          hintText: 'Write in Markdown...',
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          filled: false,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }
}

/// A small tile for the four fixed system pages. Solid accent colour, white
/// glyph — the pattern the reference uses for Overview · My Profile · Next
/// Actions · My Artifacts.
class _SystemTile extends StatelessWidget {
  const _SystemTile({
    required this.doc,
    required this.store,
    this.onOpenProfile,
    this.onOpenArtifacts,
  });

  final WikiDoc doc;
  final StudioStore store;
  final VoidCallback? onOpenProfile;
  final VoidCallback? onOpenArtifacts;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => _open(context),
      child: Container(
        width: 156,
        padding: const EdgeInsets.all(TeamlySpace.s4),
        decoration: BoxDecoration(
          color: context.palette.surface,
          borderRadius: BorderRadius.circular(TeamlyRadius.lg),
          boxShadow: TeamlyElevation.e2,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            TeamlyTopicTile(
              accentIndex: doc.accentIndex,
              icon: _iconFor(doc),
            ),
            const SizedBox(height: TeamlySpace.s3),
            Text(
              doc.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: TeamlyColors.ink900, fontSize: 15, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 2),
            Text(
              doc.subtitle,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: TeamlyColors.ink500, fontSize: 12, height: 1.35),
            ),
          ],
        ),
      ),
    );
  }

  IconData _iconFor(WikiDoc doc) {
    switch (doc.id) {
      case 'overview':
        return Icons.dashboard_rounded;
      case 'my-profile':
        return Icons.person_outline_rounded;
      case 'next-actions':
        return Icons.event_note_rounded;
      case 'my-artifacts':
        return Icons.layers_outlined;
      default:
        return Icons.menu_book_rounded;
    }
  }

  void _open(BuildContext context) {
    final d = doc;
    final s = store;
    s.markDocRead(d.id);
    // Two tiles navigate instead of opening the editor: the profile lives on
    // its own destination, and artifacts on the Artifacts tab.
    if (d.id == 'my-profile' && onOpenProfile != null) {
      onOpenProfile!();
      return;
    }
    if (d.id == 'my-artifacts' && onOpenArtifacts != null) {
      onOpenArtifacts!();
      return;
    }
    // Reuse the same bottom-sheet reader by pushing a lightweight dialog.
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.palette.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) {
        final ctrl = TextEditingController(text: d.body);
        final palette = context.palette;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(top: 10, bottom: 8),
              decoration: BoxDecoration(
                color: palette.border,
                borderRadius: BorderRadius.circular(TeamlyRadius.pill),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.s5),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      d.title,
                      style: const TextStyle(color: TeamlyColors.ink900, fontSize: 19, fontWeight: FontWeight.w700),
                    ),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Done', style: TextStyle(color: TeamlyColors.greenText)),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(TeamlySpace.s5),
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.5),
                child: SingleChildScrollView(
                  child: Container(
                    decoration: BoxDecoration(
                      color: palette.paper,
                      borderRadius: BorderRadius.circular(TeamlyRadius.md),
                    ),
                    padding: const EdgeInsets.all(TeamlySpace.s4),
                    child: TextField(
                      controller: ctrl,
                      maxLines: null,
                      style: const TextStyle(color: TeamlyColors.ink800, fontSize: 14.5, height: 1.55),
                      onChanged: (v) => s.updateDocBody(d.id, v),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        hintText: 'Write in Markdown...',
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _ToolbarChip extends StatelessWidget {
  const _ToolbarChip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.dot = false,
    this.chevron = false,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool dot;
  final bool chevron;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 13),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? palette.accent : palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (dot)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: selected ? palette.onAccent : palette.accent,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            Text(
              label,
              style: TextStyle(
                color: selected ? palette.onAccent : TeamlyColors.ink700,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (chevron)
              Icon(
                Icons.arrow_drop_down_rounded,
                size: 16,
                color: selected ? palette.onAccent : TeamlyColors.ink500,
              ),
          ],
        ),
      ),
    );
  }
}