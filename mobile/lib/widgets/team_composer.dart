import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// The chat composer used by the agent chats and rooms.
///
/// Deliberately borderless: no green focus ring, no outline at all — a flat
/// rounded surface that only changes its fill slightly while the field is
/// focused. The send button is the green accent.
class TeamComposer extends StatefulWidget {
  const TeamComposer({
    super.key,
    required this.onSend,
    this.hint = 'Message...',
    this.disabled = false,
    this.actions,
  });

  final void Function(String text) onSend;
  final String hint;
  final bool disabled;

  /// Extra leading actions (e.g. new chat).
  final List<Widget>? actions;

  @override
  State<TeamComposer> createState() => _TeamComposerState();
}

class _TeamComposerState extends State<TeamComposer> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onChanged() {
    final has = _controller.text.trim().isNotEmpty;
    if (has != _hasText) setState(() => _hasText = has);
  }

  void _submit() {
    final text = _controller.text.trim();
    if (text.isEmpty || widget.disabled) return;
    HapticFeedback.lightImpact();
    widget.onSend(text);
    _controller.clear();
    _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          decoration: BoxDecoration(
            color: _focus.hasFocus ? palette.surface2 : palette.surface,
            borderRadius: BorderRadius.circular(24),
          ),
          padding: const EdgeInsets.fromLTRB(16, 6, 6, 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              if (widget.actions != null) ...widget.actions!,
              Expanded(
                child: TextField(
                  controller: _controller,
                  focusNode: _focus,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  keyboardType: TextInputType.multiline,
                  style: TextStyle(color: palette.text, fontSize: 15, height: 1.4),
                  cursorColor: palette.accent,
                  decoration: InputDecoration(
                    isCollapsed: true,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    hintText: widget.hint,
                    hintStyle: TextStyle(color: palette.muted),
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                ),
              ),
              const SizedBox(width: 4),
              // Send / stop affordance.
              GestureDetector(
                onTap: widget.disabled ? null : _submit,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: _hasText ? palette.accent : palette.surface2,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    _hasText ? Icons.arrow_upward_rounded : Icons.arrow_upward_rounded,
                    size: 19,
                    color: _hasText ? palette.onAccent : palette.muted,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
