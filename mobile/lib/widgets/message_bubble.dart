import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../models/chat.dart';
import '../theme.dart';
import 'myto_mark.dart';
import 'tool_card.dart';
import 'typing_indicator.dart';


class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.message, this.streaming = false});

  final ChatMessage message;

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
                  _content(context, palette),
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

  /// The assistant body: plain Markdown, or — when the reply carries tool blocks — an interleaved
  /// column of Markdown prose and tool cards (the gateway writes the tool round-trips inline).
  Widget _content(BuildContext context, MytoPalette palette) {
    final text = message.content;
    if (text.trim().isEmpty) {
      return MarkdownBody(data: '…', selectable: true, styleSheet: _markdownStyle(palette));
    }
    if (!hasToolBlocks(text)) {
      return MarkdownBody(data: text, selectable: true, styleSheet: _markdownStyle(palette));
    }
    final segments = parseChatSegments(text);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var k = 0; k < segments.length; k++)
          Padding(
            padding: EdgeInsets.only(bottom: k == segments.length - 1 ? 0 : 10),
            child: segments[k] is ToolSegment
                ? ToolCard(segment: segments[k] as ToolSegment, palette: palette)
                : MarkdownBody(
                    data: (segments[k] as ProseSegment).text,
                    selectable: true,
                    styleSheet: _markdownStyle(palette),
                  ),
          ),
      ],
    );
  }

  MarkdownStyleSheet _markdownStyle(MytoPalette palette) {
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

class _CopyButton extends StatelessWidget {
  const _CopyButton({required this.text, required this.palette});

  final String text;
  final MytoPalette palette;

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
