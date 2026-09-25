import 'package:flutter/material.dart';

import '../theme.dart';

/// Reasoning-effort options for the composer. 'auto' sends nothing to the gateway (the model's
/// own default); low/medium/high forward as `reasoningEffort` — OpenAI-family models honour it,
/// Anthropic ignores it, and non-reasoning models never see it (only auto → nothing is sent).
const List<({String key, String label, String blurb, IconData icon})> kEffortOptions = [
  (key: 'auto', label: 'Auto', blurb: 'Let the model decide (default)', icon: Icons.auto_awesome),
  (key: 'low', label: 'Low', blurb: 'Faster, lighter reasoning', icon: Icons.speed_rounded),
  (key: 'medium', label: 'Medium', blurb: 'Balanced speed and depth', icon: Icons.bolt_rounded),
  (key: 'high', label: 'High', blurb: 'Deepest reasoning, slower', icon: Icons.psychology_rounded),
];

/// Human label for an effort key, e.g. for the composer chip. Unknown keys fall back to 'Auto'.
String effortLabel(String key) {
  for (final o in kEffortOptions) {
    if (o.key == key) return o.label;
  }
  return 'Auto';
}

/// Bottom sheet to choose a reasoning effort. Resolves to the chosen key ('auto'|'low'|'medium'|
/// 'high'), or null if dismissed without a choice.
Future<String?> showEffortPicker(BuildContext context, {required String selected}) {
  final palette = Theme.of(context).palette;
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: palette.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (context) => _EffortSheet(selected: selected),
  );
}

class _EffortSheet extends StatelessWidget {
  const _EffortSheet({required this.selected});

  final String selected;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            margin: const EdgeInsets.only(top: 10),
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: palette.border,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Reasoning effort',
                style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
          ),
          for (final o in kEffortOptions)
            ListTile(
              leading: Icon(o.icon, color: palette.accent),
              title: Text(
                o.label,
                style: TextStyle(color: palette.text, fontSize: 15, fontWeight: FontWeight.w600),
              ),
              subtitle: Text(o.blurb, style: TextStyle(color: palette.muted, fontSize: 13)),
              trailing: o.key == selected ? Icon(Icons.check_rounded, color: palette.accent) : null,
              onTap: () => Navigator.of(context).pop(o.key),
            ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
