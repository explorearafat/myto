import 'package:flutter/material.dart';

import '../../theme.dart';

/// ---------------------------------------------------------------------------
/// The Teamly component kit — every reusable part of the reference UI.
///
/// Everything here reads colour from `context.palette` and geometry from
/// [TeamlySpace] / [TeamlyRadius] / [TeamlyElevation], so no screen ever
/// hard-codes a hex value or a magic number. The four screens are then written
/// almost entirely out of these pieces, which is exactly how the reference
/// feels: one visual system, five different jobs.
/// ---------------------------------------------------------------------------

/// The full-width search field that sits directly under every screen header.
/// Always a white pill with a leading 20px search glyph — no exceptions in the
/// reference, on all five tabs.
class TeamlySearch extends StatelessWidget {
  const TeamlySearch({
    super.key,
    required this.hint,
    this.controller,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
  });

  final String hint;
  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      height: 52,
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
        boxShadow: TeamlyElevation.e1,
      ),
      child: Row(
        children: <Widget>[
          const SizedBox(width: TeamlySpace.s5),
          Icon(Icons.search_rounded, size: 20, color: TeamlyColors.ink300),
          const SizedBox(width: TeamlySpace.s3),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              onSubmitted: onSubmitted,
              autofocus: autofocus,
              textInputAction: TextInputAction.search,
              style: TextStyle(color: palette.text, fontSize: 15),
              cursorColor: palette.accent,
              decoration: InputDecoration(
                isCollapsed: true,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                hintText: hint,
                hintStyle: const TextStyle(color: TeamlyColors.ink300, fontSize: 15),
              ),
            ),
          ),
          const SizedBox(width: TeamlySpace.s4),
        ],
      ),
    );
  }
}

/// One chip in a filter rail. [selected] chips are filled green and a touch
/// taller than the neutral ones — the reference makes the active filter
/// physically dominant rather than just recolouring it.
class TeamlyChip extends StatelessWidget {
  const TeamlyChip({
    super.key,
    required this.label,
    this.selected = false,
    this.onTap,
    this.trailing,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  /// Optional glyph after the label — the selected "All ⟳" reset affordance.
  final IconData? trailing;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final height = selected ? 44.0 : 40.0;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        curve: Curves.easeOut,
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 18),
        decoration: BoxDecoration(
          color: selected ? palette.accent : palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
          boxShadow: selected ? TeamlyElevation.green : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                color: selected ? palette.onAccent : TeamlyColors.ink700,
                fontSize: 14,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
            if (trailing != null) ...<Widget>[
              const SizedBox(width: TeamlySpace.s2),
              Icon(trailing, size: 14, color: palette.onAccent),
            ],
          ],
        ),
      ),
    );
  }
}

/// A horizontally scrolling chip rail. It deliberately runs edge-to-edge and
/// clips the last chip — the reference uses that cut-off as the "there is more"
/// cue instead of a gradient.
class TeamlyChipRail extends StatelessWidget {
  const TeamlyChipRail({
    super.key,
    required this.labels,
    required this.selected,
    required this.onSelected,
    this.resettable = false,
  });

  final List<String> labels;
  final String selected;
  final ValueChanged<String> onSelected;

  /// Draws the reset glyph inside the selected chip (the Discover rail).
  final bool resettable;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
        itemCount: labels.length,
        separatorBuilder: (_, __) => const SizedBox(width: TeamlySpace.s2),
        itemBuilder: (context, i) {
          final label = labels[i];
          final isSelected = label == selected;
          return Center(
            child: TeamlyChip(
              label: label,
              selected: isSelected,
              trailing: isSelected && resettable ? Icons.refresh_rounded : null,
              onTap: () => onSelected(label),
            ),
          );
        },
      ),
    );
  }
}

/// The uppercase, letterspaced section label — `⌄ CHATS · 15`. Collapsible
/// groups are a system pattern, not a one-off.
class TeamlyGroupHeader extends StatelessWidget {
  const TeamlyGroupHeader({
    super.key,
    required this.label,
    this.count,
    this.expanded = true,
    this.onToggle,
  });

  final String label;
  final int? count;
  final bool expanded;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onToggle,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: TeamlySpace.s3),
        child: Row(
          children: <Widget>[
            AnimatedRotation(
              turns: expanded ? 0 : -0.25,
              duration: const Duration(milliseconds: 180),
              child: const Icon(Icons.keyboard_arrow_down_rounded,
                  size: 16, color: TeamlyColors.ink300),
            ),
            const SizedBox(width: TeamlySpace.s1),
            Text(
              count == null ? label : '$label $count',
              style: const TextStyle(
                color: TeamlyColors.ink300,
                fontSize: 11,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.3,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A pale-green status tag with a sparkle — `✧ Agent generated`. Fill is the
/// tint, the text is the darker green: the one rule of the palette.
class TeamlyStatusTag extends StatelessWidget {
  const TeamlyStatusTag({super.key, required this.label, this.icon = Icons.auto_awesome});

  final String label;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(
        color: palette.tagBg,
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 13, color: palette.tagFg),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(color: palette.tagFg, fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

/// The small green counter that sits on the Memory nav item and anywhere a
/// numeric delta is worth surfacing.
class TeamlyBadge extends StatelessWidget {
  const TeamlyBadge({super.key, required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    return Container(
      constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
        color: context.palette.accent,
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
      ),
      alignment: Alignment.center,
      child: Text(
        '$count',
        style: const TextStyle(
          color: Colors.white,
          fontSize: 11,
          fontWeight: FontWeight.w600,
          height: 1.1,
        ),
      ),
    );
  }
}

/// The text tabs at the top of a screen, with a green underline under the
/// active one (Following | Feeds, Agents | Agent Teams, Recent | Saved | …).
class TeamlyTabs extends StatelessWidget {
  const TeamlyTabs({
    super.key,
    required this.labels,
    required this.index,
    required this.onChanged,
  });

  final List<String> labels;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (var i = 0; i < labels.length; i++)
          GestureDetector(
            onTap: () => onChanged(i),
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.s3),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const SizedBox(height: TeamlySpace.s2),
                  Text(
                    labels[i],
                    style: TextStyle(
                      color: i == index ? palette.text : TeamlyColors.ink300,
                      fontSize: 15,
                      fontWeight: i == index ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: TeamlySpace.s2),
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    height: 3,
                    width: i == index ? 28 : 0,
                    decoration: BoxDecoration(
                      color: palette.accent,
                      borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// The pill-track segmented control (Agents | Automations): a neutral pill with
/// a white active half floating on top of it.
class TeamlySegmented extends StatelessWidget {
  const TeamlySegmented({
    super.key,
    required this.labels,
    required this.index,
    required this.onChanged,
  });

  final List<String> labels;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      height: 44,
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: palette.chip,
        borderRadius: BorderRadius.circular(TeamlyRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (var i = 0; i < labels.length; i++)
            GestureDetector(
              onTap: () => onChanged(i),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                padding: const EdgeInsets.symmetric(horizontal: 22),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: i == index ? palette.surface : Colors.transparent,
                  borderRadius: BorderRadius.circular(TeamlyRadius.pill),
                  boxShadow: i == index ? TeamlyElevation.e1 : null,
                ),
                child: Text(
                  labels[i],
                  style: TextStyle(
                    color: i == index ? palette.text : TeamlyColors.ink500,
                    fontSize: 14,
                    fontWeight: i == index ? FontWeight.w600 : FontWeight.w500,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A white rounded card — the agent row, feed post, artifact card and every
/// other list container in the app. White on near-white, separated by radius
/// and whitespace rather than by shadow.
class TeamlyCard extends StatelessWidget {
  const TeamlyCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(TeamlySpace.cardPad),
    this.radius = TeamlyRadius.lg,
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: context.palette.surface,
        borderRadius: BorderRadius.circular(radius),
        boxShadow: TeamlyElevation.e2,
      ),
      child: child,
    );
    if (onTap == null) return card;
    return GestureDetector(onTap: onTap, child: card);
  }
}

/// The primary action: a green pill button with a soft green glow. The label is
/// white on the fill, which is only safe at this size and weight — the palette's
/// one contrast rule.
class TeamlyPillButton extends StatelessWidget {
  const TeamlyPillButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.compact = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  /// The smaller 72×44 "Chat" button used inside an agent row.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onPressed,
      child: Container(
        height: 44,
        padding: EdgeInsets.symmetric(horizontal: compact ? 20 : 26),
        decoration: BoxDecoration(
          color: palette.accent,
          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
          boxShadow: TeamlyElevation.green,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (icon != null) ...<Widget>[
              Icon(icon, size: 17, color: palette.onAccent),
              const SizedBox(width: 6),
            ],
            Text(
              label,
              style: TextStyle(
                color: palette.onAccent,
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The floating green action button in a header (the `+` on Chat and Discover).
class TeamlyFab extends StatelessWidget {
  const TeamlyFab({super.key, this.icon = Icons.add_rounded, this.onPressed});

  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onPressed,
      child: Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: palette.accent,
          shape: BoxShape.circle,
          boxShadow: TeamlyElevation.green,
        ),
        child: Icon(icon, size: 22, color: palette.onAccent),
      ),
    );
  }
}

/// A bordered circular icon button — the comment / share / overflow row under an
/// artifact card.
class TeamlyIconButton extends StatelessWidget {
  const TeamlyIconButton({super.key, required this.icon, this.onPressed, this.size = 40});

  final IconData icon;
  final VoidCallback? onPressed;
  final double size;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onPressed,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: palette.surface,
          shape: BoxShape.circle,
          border: Border.all(color: palette.border),
        ),
        child: Icon(icon, size: size * 0.42, color: TeamlyColors.ink500),
      ),
    );
  }
}

/// The standard 16px screen gutter wrapper, so every body lines up.
class TeamlyGutter extends StatelessWidget {
  const TeamlyGutter({super.key, required this.child, this.vertical = 0});

  final Widget child;
  final double vertical;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.symmetric(
          horizontal: TeamlySpace.gutter,
          vertical: vertical,
        ),
        child: child,
      );
}