import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../models/chat.dart';
import '../theme.dart';
import 'sylor_star.dart';
import 'typing_indicator.dart';

/// One rendered turn. The person's messages sit in a rounded terracotta-tinted bubble on the
/// right; Sylor's replies stream as Markdown on the left beside the star, like the desktop app.
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
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 8, right: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2, right: 12),
            child: SylorStar(size: 22, color: palette.accent),
          ),
          Expanded(
            child: (empty && streaming)
                ? const Padding(
                    padding: EdgeInsets.only(top: 3),
                    child: TypingIndicator(),
                  )
                : MarkdownBody(
                    data: message.content.isEmpty ? '…' : message.content,
                    selectable: true,
                    styleSheet: _markdownStyle(palette),
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
