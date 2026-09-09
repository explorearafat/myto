import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';
import 'sylor_star.dart';

/// The screen shown before the first message: a soft aura behind the star, a time-of-day
/// greeting (with the person's first name when signed in), and a grid of tappable conversation
/// starters. Tapping a starter prefills the composer via [onStarter] so the person can tweak it
/// before sending — the "guided" part of the app's feel.
class ChatEmptyState extends StatelessWidget {
  const ChatEmptyState({super.key, required this.onStarter, this.firstName});

  /// Called with a ready-to-edit prompt when a starter card is tapped.
  final void Function(String prompt) onStarter;

  /// The signed-in person's first name, or null for guests (greeting omits the name then).
  final String? firstName;

  static const List<_Starter> _starters = [
    _Starter(
      icon: Icons.edit_outlined,
      label: 'Write a draft',
      prompt: 'Help me write a first draft. Ask me what it\'s for and the key points to include.',
    ),
    _Starter(
      icon: Icons.code_rounded,
      label: 'Explain code',
      prompt: 'Explain how a piece of code works, step by step. I\'ll paste it in my next message.',
    ),
    _Starter(
      icon: Icons.lightbulb_outline_rounded,
      label: 'Brainstorm',
      prompt: 'Brainstorm ideas with me. Ask me the topic and any constraints first.',
    ),
    _Starter(
      icon: Icons.checklist_rounded,
      label: 'Make a plan',
      prompt: 'Help me turn a goal into a clear, step-by-step plan. Ask me what the goal is.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: const Duration(milliseconds: 420),
            curve: Curves.easeOutCubic,
            builder: (context, t, child) => Opacity(
              opacity: t.clamp(0.0, 1.0),
              child: Transform.translate(offset: Offset(0, (1 - t) * 12), child: child),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SylorStarAura(auraSize: 132, starSize: 56),
                const SizedBox(height: 20),
                Text(
                  _greeting(firstName),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.3,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'What can we make today?',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: palette.muted, fontSize: 15, height: 1.4),
                ),
                const SizedBox(height: 28),
                _grid(palette),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _grid(SylorPalette palette) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(child: _card(palette, _starters[0])),
            const SizedBox(width: 10),
            Expanded(child: _card(palette, _starters[1])),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(child: _card(palette, _starters[2])),
            const SizedBox(width: 10),
            Expanded(child: _card(palette, _starters[3])),
          ],
        ),
      ],
    );
  }

  Widget _card(SylorPalette palette, _Starter s) {
    return Material(
      color: palette.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () {
          HapticFeedback.selectionClick();
          onStarter(s.prompt);
        },
        child: Container(
          height: 76,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: palette.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Icon(s.icon, size: 20, color: palette.accent),
              Text(
                s.label,
                style: TextStyle(color: palette.text, fontSize: 14, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _greeting(String? name) {
    final hour = DateTime.now().hour;
    final part = hour < 12
        ? 'Good morning'
        : hour < 17
            ? 'Good afternoon'
            : 'Good evening';
    return (name != null && name.isNotEmpty) ? '$part, $name' : part;
  }
}

/// The star sitting inside a soft terracotta radial glow lives in [SylorStarAura] (sylor_star.dart).

class _Starter {
  const _Starter({required this.icon, required this.label, required this.prompt});

  final IconData icon;
  final String label;
  final String prompt;
}
