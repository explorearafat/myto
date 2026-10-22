import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/artifact.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';

/// The Artifacts tab — the vault where everything an agent produced lands.
///
/// Reference screenshot: a header row (menu · Home · grid/list toggle · list ·
/// bell), tabs (Recent | Recently saved | Memory), a sort control, then one
/// card whose content is a 9:16 stage on a black letterbox with ‹ › arrows, a
/// `1/2` counter, a bookmark, the `✧ Agent generated` tag, a `VIDEO` label and
/// an action row of circled outline icons.
class ArtifactsScreen extends StatefulWidget {
  const ArtifactsScreen({super.key});

  @override
  State<ArtifactsScreen> createState() => _ArtifactsScreenState();
}

class _ArtifactsScreenState extends State<ArtifactsScreen> {
  ArtifactTab _tab = ArtifactTab.recent;
  ArtifactView _view = ArtifactView.list;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final store = context.watch<StudioStore>();
    final artifacts = store.artifactsFor(_tab);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Home'),
        actions: <Widget>[
          // Grid / list view toggle, rendered as a white pill per the reference.
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(
              child: Container(
                height: 34,
                padding: const EdgeInsets.all(3),
                decoration: BoxDecoration(
                  color: palette.chip,
                  borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    _ViewToggle(
                      icon: Icons.grid_view_rounded,
                      active: _view == ArtifactView.grid,
                      onTap: () => setState(() => _view = ArtifactView.grid),
                    ),
                    _ViewToggle(
                      icon: Icons.view_list_rounded,
                      active: _view == ArtifactView.list,
                      onTap: () => setState(() => _view = ArtifactView.list),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          const SizedBox(height: TeamlySpace.s2),
          // Tabs with the sort control on the right.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TeamlyTabs(
                    labels: const <String>['Recent', 'Recently saved', 'Memory'],
                    index: _tab.index,
                    onChanged: (i) => setState(() => _tab = ArtifactTab.values[i]),
                  ),
                ),
                Icon(Icons.swap_vert_rounded, size: 20, color: TeamlyColors.ink500),
              ],
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Expanded(
            child: artifacts.isEmpty
                ? _empty(palette)
                : _view == ArtifactView.list
                    ? ListView.separated(
                        padding: const EdgeInsets.all(TeamlySpace.gutter),
                        itemCount: artifacts.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 20),
                        itemBuilder: (context, i) =>
                            _ArtifactCard(artifact: artifacts[i], store: store),
                      )
                    : GridView.builder(
                        padding: const EdgeInsets.all(TeamlySpace.gutter),
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          crossAxisSpacing: TeamlySpace.s3,
                          mainAxisSpacing: TeamlySpace.s3,
                          childAspectRatio: 0.78,
                        ),
                        itemCount: artifacts.length,
                        itemBuilder: (context, i) =>
                            _ArtifactGridTile(artifact: artifacts[i], store: store),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _empty(MytoPalette palette) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.layers_outlined, size: 44, color: palette.muted),
            const SizedBox(height: 16),
            Text(
              'Nothing here yet',
              style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            const Text(
              'When an agent finishes its work, the result lands here.',
              textAlign: TextAlign.center,
              style: TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}

class _ViewToggle extends StatelessWidget {
  const _ViewToggle({required this.icon, required this.active, required this.onTap});

  final IconData icon;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 30,
        height: 28,
        decoration: BoxDecoration(
          color: active ? palette.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
          boxShadow: active ? TeamlyElevation.e1 : null,
        ),
        child: Icon(
          icon,
          size: 16,
          color: active ? palette.accentText : TeamlyColors.ink500,
        ),
      ),
    );
  }
}

/// The full artifact card from the reference, in list mode.
class _ArtifactCard extends StatefulWidget {
  const _ArtifactCard({required this.artifact, required this.store});

  final Artifact artifact;
  final StudioStore store;

  @override
  State<_ArtifactCard> createState() => _ArtifactCardState();
}

class _ArtifactCardState extends State<_ArtifactCard> {
  int _page = 0;

  Artifact get artifact => widget.artifact;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final media = artifact.media;
    final current = media[_page.clamp(0, media.length - 1)];

    return TeamlyCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Stage: 9:16 frame on a black letterbox with arrows + counter.
          Container(
            width: double.infinity,
            color: palette.stage,
            child: AspectRatio(
              aspectRatio: 16 / 12,
              child: Stack(
                alignment: Alignment.center,
                children: <Widget>[
                  // 9:16 placeholder frame.
                  Container(
                    width: 150,
                    height: 260,
                    decoration: BoxDecoration(
                      color: palette.pastel(current.accentIndex),
                      borderRadius: BorderRadius.circular(TeamlyRadius.md),
                    ),
                    child: _FrameArt(icon: current.icon, size: 64, color: TeamlyColors.ink800),
                  ),
                  // Left arrow.
                  Positioned(
                    left: 10,
                    child: _StageArrow(
                      icon: Icons.chevron_left_rounded,
                      onTap: media.length > 1
                          ? () => setState(() => _page = (_page - 1 + media.length) % media.length)
                          : null,
                    ),
                  ),
                  // Right arrow.
                  Positioned(
                    right: 10,
                    child: _StageArrow(
                      icon: Icons.chevron_right_rounded,
                      onTap: media.length > 1
                          ? () => setState(() => _page = (_page + 1) % media.length)
                          : null,
                    ),
                  ),
                  // Counter pill top-left.
                  Positioned(
                    top: 10,
                    left: 10,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                      decoration: BoxDecoration(
                        color: palette.surface.withValues(alpha: 0.92),
                        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                      ),
                      child: Text(
                        '${_page + 1}/${media.length}',
                        style: const TextStyle(
                          color: TeamlyColors.ink900,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  // Bookmark button top-right.
                  Positioned(
                    top: 8,
                    right: 8,
                    child: GestureDetector(
                      onTap: () => widget.store.toggleArtifactSaved(artifact.id),
                      child: Container(
                        width: 34,
                        height: 34,
                        decoration: BoxDecoration(
                          color: palette.surface,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          artifact.saved
                              ? Icons.bookmark_rounded
                              : Icons.bookmark_border_rounded,
                          size: 17,
                          color: artifact.saved ? palette.accent : TeamlyColors.ink500,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          // Meta: tag + kind label, title, timestamp, actions.
          Padding(
            padding: const EdgeInsets.all(TeamlySpace.s4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    if (artifact.agentGenerated)
                      const TeamlyStatusTag(label: 'Agent generated'),
                    const SizedBox(width: TeamlySpace.s2),
                    Text(
                      artifact.kind.label,
                      style: const TextStyle(
                        color: TeamlyColors.ink300,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: TeamlySpace.s2 + 2),
                Text(
                  current.label,
                  style: const TextStyle(
                    color: TeamlyColors.ink300,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  artifact.title,
                  style: const TextStyle(
                    color: TeamlyColors.ink900,
                    fontSize: 19,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  artifact.createdLabel,
                  style: const TextStyle(color: TeamlyColors.ink300, fontSize: 12),
                ),
                const SizedBox(height: TeamlySpace.s3),
                Row(
                  children: <Widget>[
                    TeamlyIconButton(icon: Icons.chat_bubble_outline_rounded, onPressed: () {}),
                    const SizedBox(width: TeamlySpace.s3),
                    TeamlyIconButton(icon: Icons.send_outlined, onPressed: () {}),
                    const SizedBox(width: TeamlySpace.s3),
                    TeamlyIconButton(icon: Icons.more_horiz_rounded, onPressed: () {}),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ArtifactGridTile extends StatelessWidget {
  const _ArtifactGridTile({required this.artifact, required this.store});

  final Artifact artifact;
  final StudioStore store;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final media = artifact.media;
    final first = media.isNotEmpty ? media.first : null;
    return TeamlyCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Container(
              width: double.infinity,
              color: palette.stage,
              child: Center(
                child: first == null
                    ? const SizedBox.shrink()
                    : Container(
                        width: 84,
                        height: 130,
                        decoration: BoxDecoration(
                          color: palette.pastel(first.accentIndex),
                          borderRadius: BorderRadius.circular(TeamlyRadius.sm),
                        ),
                        child: _FrameArt(icon: first.icon, size: 34, color: TeamlyColors.ink800),
                      ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(TeamlySpace.s3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  artifact.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: TeamlyColors.ink900,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  artifact.createdLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: TeamlyColors.ink300, fontSize: 11),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StageArrow extends StatelessWidget {
  const _StageArrow({required this.icon, this.onTap});

  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: context.palette.surface,
          shape: BoxShape.circle,
          boxShadow: TeamlyElevation.e2,
        ),
        child: Icon(
          icon,
          size: 20,
          color: enabled ? TeamlyColors.ink900 : TeamlyColors.ink300,
        ),
      ),
    );
  }
}

/// A tiny placeholder "scene" so each carousel page reads differently without
/// shipping binary assets. The reference frame was a flat illustration; this
/// keeps the same stage geometry (9:16 on letterbox) with a generated glyph.
class _FrameArt extends StatelessWidget {
  const _FrameArt({required this.icon, required this.size, required this.color});

  final int icon;
  final double size;
  final Color color;

  static const List<IconData> _glyphs = <IconData>[
    Icons.animation_rounded,
    Icons.play_arrow_rounded,
    Icons.description_outlined,
    Icons.language_rounded,
  ];

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Icon(_glyphs[icon % _glyphs.length], size: size, color: color),
    );
  }
}