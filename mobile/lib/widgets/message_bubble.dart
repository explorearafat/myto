import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../models/chat.dart';
import '../theme.dart';
import 'sylor_star.dart';
import 'typing_indicator.dart';

/// One rendered turn. The person's messages sit in a rounded terracotta-tinted bubble on the
/// right; Sylor's replies stream as Markdown on the left beside the star, like the desktop app.
/// While a reply streams the star breathes and a caret trails the text; once it's done a quiet
/// Copy affordance appears.
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.message, this.streaming = false});

  final ChatMessage message;

  /// True for the assistant message currently receiving tokens (shows typing dots when empty).
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    return message.isUser ? _user(context) : _assistant(context);
  }

  Widget _user(BuildContext context) {
    final palette = Theme.of(context).palette;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(left: 48, top: 6, bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        decoration: BoxDecoration(
          color: palette.accent.withValues(alpha: 0.12),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(18),
            topRight: Radius.circular(18),
            bottomLeft: Radius.circular(18),
            bottomRight: Radius.circular(6),
          ),
        ),
        child: SelectableText(
          message.content,
          style: TextStyle(color: palette.text, fontSize: 15, height: 1.45),
        ),
      ),
    );
  }

  Widget _assistant(BuildContext context) {
    final palette = Theme.of(context).palette;
    final empty = message.content.trim().isEmpty;
    final showDots = empty && streaming;
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 8, right: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2, right: 12),
            child: PulsingStar(size: 22, color: palette.accent, active: streaming),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (showDots)
                  const Padding(padding: EdgeInsets.only(top: 3), child: TypingIndicator())
                else
                  MarkdownBody(
                    data: empty ? '…' : message.content,
                    selectable: true,
                    styleSheet: _markdownStyle(palette),
                  ),
                if (!empty && streaming)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: _StreamCaret(color: palette.accent),
                  ),
                if (!empty && !streaming)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: _CopyButton(text: message.content, palette: palette),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  MarkdownStyleSheet _markdownStyle(SylorPalette palette) {
    final base = TextStyle(color: palette.text, fontSize: 15, height: 1.5);
    return MarkdownStyleSheet(
      p: base,
      a: TextStyle(color: palette.accent, decoration: TextDecoration.underline),
      code: TextStyle(
        fontFamily: 'monospace',
        backgroundColor: palette.surface2,
        color: palette.text,
        fontSize: 13.5,
      ),
      codeblockDecoration: BoxDecoration(
        color: palette.surface2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: palette.border),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      blockquoteDecoration: BoxDecoration(
        color: palette.surface2,
        borderRadius: BorderRadius.circular(8),
      ),
      blockquotePadding: const EdgeInsets.all(12),
      h1: base.copyWith(fontSize: 22, fontWeight: FontWeight.w600),
      h2: base.copyWith(fontSize: 19, fontWeight: FontWeight.w600),
      h3: base.copyWith(fontSize: 16.5, fontWeight: FontWeight.w600),
      listBullet: base,
      strong: base.copyWith(fontWeight: FontWeight.w700),
      em: base.copyWith(fontStyle: FontStyle.italic),
    );
  }
}

/// A thin terracotta bar that blinks at the end of a streaming reply, so the text looks like
/// it's being typed in real time.
class _StreamCaret extends StatefulWidget {
  const _StreamCaret({required this.color});

  final Color color;

  @override
  State<_StreamCaret> createState() => _StreamCaretState();
}

class _StreamCaretState extends State<_StreamCaret> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 1.0, end: 0.15).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: Container(
        width: 2.5,
        height: 16,
        decoration: BoxDecoration(
          color: widget.color,
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}

/// A quiet "Copy" affordance under a finished reply — copies the whole message, buzzes lightly,
/// and confirms with a snackbar. Text stays selectable too, for copying just part of a reply.
class _CopyButton extends StatelessWidget {
  const _CopyButton({required this.text, required this.palette});

  final String text;
  final SylorPalette palette;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: text));
        HapticFeedback.selectionClick();
        if (context.mounted) {
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(const SnackBar(content: Text('Copied to clipboard')));
        }
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.content_copy_rounded, size: 14, color: palette.muted),
            const SizedBox(width: 6),
            Text('Copy', style: TextStyle(color: palette.muted, fontSize: 12.5)),
          ],
        ),
      ),
    );
  }
}
