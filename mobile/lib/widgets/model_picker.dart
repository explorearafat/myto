import 'package:flutter/material.dart';

import '../models/oraculum_model.dart';
import '../theme.dart';
import 'sylor_star.dart';

/// Shows the Oraculum model chooser as a bottom sheet and resolves to the chosen id (or null
/// if dismissed). Both options route across the same real model pool server-side — this is a
/// branding-only choice, mirrored from the website.
Future<String?> showModelPicker(BuildContext context, {required String selectedId}) {
  final palette = Theme.of(context).palette;
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: palette.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (context) => _ModelPickerSheet(selectedId: selectedId),
  );
}

class _ModelPickerSheet extends StatelessWidget {
  const _ModelPickerSheet({required this.selectedId});

  final String selectedId;

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
                'Choose a model',
                style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
          ),
          for (final model in kOraculumModels) _tile(context, palette, model),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Widget _tile(BuildContext context, SylorPalette palette, OraculumModel model) {
    final selected = model.id == selectedId;
    return ListTile(
      leading: SylorStar(size: 24, color: palette.accent),
      title: Text(
        model.name,
        style: TextStyle(color: palette.text, fontSize: 15, fontWeight: FontWeight.w600),
      ),
      subtitle: Text(model.blurb, style: TextStyle(color: palette.muted, fontSize: 13)),
      trailing: selected ? Icon(Icons.check_rounded, color: palette.accent) : null,
      onTap: () => Navigator.of(context).pop(model.id),
    );
  }
}
