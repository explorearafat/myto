import 'package:flutter/material.dart';

import '../theme.dart';

/// The bottom input row: a rounded multiline field with a send button that turns into a stop
/// button while a reply is streaming.
class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.onSend,
    required this.onStop,
    required this.streaming,
  });

  final void Function(String text) onSend;
  final VoidCallback onStop;
  final bool streaming;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final has = _controller.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _controller.text.trim();
    if (text.isEmpty || widget.streaming) return;
    widget.onSend(text);
    _controller.clear();
    _focus.requestFocus();
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
                  controller: _controller,
                  focusNode: _focus,
                  minLines: 1,
                  maxLines: 6,
                  textInputAction: TextInputAction.newline,
                  keyboardType: TextInputType.multiline,
                  style: TextStyle(color: palette.text, fontSize: 15, height: 1.4),
                  cursorColor: palette.accent,
                  decoration: InputDecoration(
                    isCollapsed: true,
                    border: InputBorder.none,
                    hintText: 'Message Sylor…',
                    hintStyle: TextStyle(color: palette.muted),
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              _button(palette, canSend),
            ],
          ),
        ),
      ),
    );
  }

  Widget _button(SylorPalette palette, bool canSend) {
    if (widget.streaming) {
      return _circle(palette.accent, Icons.stop_rounded, Colors.white, widget.onStop, 'Stop');
    }
    return _circle(
      canSend ? palette.accent : palette.surface2,
      Icons.arrow_upward_rounded,
      canSend ? Colors.white : palette.muted,
      canSend ? _submit : null,
      'Send',
    );
  }

  Widget _circle(Color bg, IconData icon, Color fg, VoidCallback? onTap, String tooltip) {
    return Padding(
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
