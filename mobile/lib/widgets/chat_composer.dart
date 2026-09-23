import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onSend,
    required this.onStop,
    required this.streaming,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final void Function(String text) onSend;
  final VoidCallback onStop;
  final bool streaming;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _hasText = widget.controller.text.trim().isNotEmpty;
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    final has = widget.controller.text.trim().isNotEmpty;
    if (has != _hasText) setState(() => _hasText = has);
  }

  void _submit() {
    final text = widget.controller.text.trim();
    if (text.isEmpty || widget.streaming) return;
    HapticFeedback.lightImpact();
    widget.onSend(text);
    widget.controller.clear();
    widget.focusNode.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final canSend = _hasText && !widget.streaming;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
        child: Container(
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: palette.border),
          ),
          padding: const EdgeInsets.only(left: 18, right: 6, top: 4, bottom: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: widget.controller,
                  focusNode: widget.focusNode,
                  minLines: 1,
                  maxLines: 6,
                  textInputAction: TextInputAction.newline,
                  keyboardType: TextInputType.multiline,
                  style: TextStyle(color: palette.text, fontSize: 15, height: 1.4),
                  cursorColor: palette.accent,
                  decoration: InputDecoration(
                    isCollapsed: true,
                    border: InputBorder.none,
                    hintText: 'Message Myto…',
                    hintStyle: TextStyle(color: palette.muted),
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                transitionBuilder: (child, animation) =>
                    ScaleTransition(scale: animation, child: FadeTransition(opacity: animation, child: child)),
                child: _button(palette, canSend),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _button(MytoPalette palette, bool canSend) {
    if (widget.streaming) {
      return _circle(
        const ValueKey('stop'),
        palette.accent,
        Icons.stop_rounded,
        palette.onAccent,
        widget.onStop,
        'Stop',
      );
    }
    return _circle(
      ValueKey(canSend ? 'send' : 'idle'),
      canSend ? palette.accent : palette.surface2,
      Icons.arrow_upward_rounded,
      canSend ? palette.onAccent : palette.muted,
      canSend ? _submit : null,
      'Send',
    );
  }

  Widget _circle(Key key, Color bg, IconData icon, Color fg, VoidCallback? onTap, String tooltip) {
    return Padding(
      key: key,
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: bg,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Tooltip(
            message: tooltip,
            child: SizedBox(width: 38, height: 38, child: Icon(icon, size: 20, color: fg)),
          ),
        ),
      ),
    );
  }
}
