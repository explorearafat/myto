import 'dart:convert';

import 'package:flutter/material.dart';

import '../theme.dart';

/// Tool-call rendering for the mobile transcript. The Oraculum gateway runs the tool loop and
/// writes each round-trip into the reply as two fenced blocks — a ```sylor:tool call and a
/// ```sylor:tool_result <name> result (see src/server/tools.ts). This file splits an assistant
/// message into those segments and renders each tool round-trip as a collapsible card, matching
/// the website's ToolCard. The Dart mirror of src/lib/toolBlocks.ts + src/components/ToolCard.tsx.

/// One piece of an assistant reply: ordinary prose, or a tool round-trip.
sealed class ChatSegment {
  const ChatSegment();
}

class ProseSegment extends ChatSegment {
  const ProseSegment(this.text);
  final String text;
}

class ToolSegment extends ChatSegment {
  ToolSegment({this.name, this.input, this.result, required this.complete});

  /// Tool name from the call (or the result's info line as a fallback), or null.
  String? name;

  /// Parsed `input` from the call; the raw body string if the JSON was malformed; null for a
  /// result-only block.
  final Object? input;

  /// The result text, or null while only the call has streamed in (card shows "Running…").
  String? result;

  /// False while the most recent block's closing fence hasn't arrived yet.
  bool complete;
}

/// Cheap pre-check so the plain-Markdown path stays untouched when there are no tools.
bool hasToolBlocks(String s) => s.contains('```sylor:tool');

final RegExp _fence = RegExp(r'^(`{3,})[ \t]*(.*)$');
final RegExp _closeFence = RegExp(r'^(`{3,})[ \t]*$');

({String kind, String? name})? _parseToolInfo(String info) {
  final trimmed = info.trim();
  if (trimmed == 'sylor:tool') return (kind: 'call', name: null);
  if (trimmed == 'sylor:tool_result' || trimmed.startsWith('sylor:tool_result ')) {
    final name = trimmed.substring('sylor:tool_result'.length).trim();
    return (kind: 'result', name: name.isEmpty ? null : name);
  }
  return null;
}

({String? name, Object? input}) _parseCallBody(String body) {
  final trimmed = body.trim();
  try {
    final obj = jsonDecode(trimmed);
    if (obj is Map<String, dynamic>) {
      final tool = obj['tool'];
      final name = (tool is String && tool.trim().isNotEmpty) ? tool.trim() : null;
      return (name: name, input: obj.containsKey('input') ? obj['input'] : null);
    }
  } catch (_) {
    /* keep the raw text so the card can still show something */
  }
  return (name: null, input: trimmed.isEmpty ? null : trimmed);
}

/// Parse a reply into ordered prose + tool segments, coalescing each call with its following result.
List<ChatSegment> parseChatSegments(String md) {
  final lines = md.split('\n');
  final segments = <ChatSegment>[];
  var prose = <String>[];

  void flushProse() {
    final text = prose.join('\n');
    if (text.trim().isNotEmpty) segments.add(ProseSegment(text));
    prose = <String>[];
  }

  var i = 0;
  while (i < lines.length) {
    final open = _fence.firstMatch(lines[i]);
    final tool = open != null ? _parseToolInfo(open.group(2) ?? '') : null;
    if (open == null || tool == null) {
      prose.add(lines[i]);
      i++;
      continue;
    }

    final fenceLen = (open.group(1) ?? '```').length;
    final body = <String>[];
    var j = i + 1;
    var closed = false;
    for (; j < lines.length; j++) {
      final close = _closeFence.firstMatch(lines[j]);
      if (close != null && (close.group(1) ?? '').length >= fenceLen) {
        closed = true;
        break;
      }
      body.add(lines[j]);
    }

    flushProse();
    final bodyText = body.join('\n');
    if (tool.kind == 'call') {
      final parsed = _parseCallBody(bodyText);
      segments.add(ToolSegment(name: parsed.name, input: parsed.input, result: null, complete: closed));
    } else {
      final last = segments.isNotEmpty ? segments.last : null;
      if (last is ToolSegment && last.result == null) {
        last.result = bodyText;
        last.complete = closed;
        last.name ??= tool.name;
      } else {
        segments.add(ToolSegment(name: tool.name, input: null, result: bodyText, complete: closed));
      }
    }
    i = closed ? j + 1 : j;
  }

  flushProse();
  return segments;
}

String _toolLabel(String? name) {
  switch (name) {
    case 'web_search':
      return 'Web search';
    case 'web_fetch':
      return 'Fetch page';
    case 'wiki_search':
      return 'Wikipedia';
    default:
      return name ?? 'Tool';
  }
}

IconData _toolIcon(String? name) {
  switch (name) {
    case 'web_search':
      return Icons.search_rounded;
    case 'wiki_search':
      return Icons.menu_book_rounded;
    case 'web_fetch':
      return Icons.public_rounded;
    default:
      return Icons.build_rounded;
  }
}

String _formatInput(Object? input) {
  if (input == null) return '';
  if (input is String) return input;
  try {
    return const JsonEncoder.withIndent('  ').convert(input);
  } catch (_) {
    return input.toString();
  }
}

/// A collapsible card for one tool round-trip.
class ToolCard extends StatefulWidget {
  const ToolCard({super.key, required this.segment, required this.palette});

  final ToolSegment segment;
  final SylorPalette palette;

  @override
  State<ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<ToolCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    final seg = widget.segment;
    final running = seg.result == null;
    final phase = running ? (seg.complete ? 'Running…' : 'Preparing…') : (seg.complete ? null : 'Running…');
    final inputText = _formatInput(seg.input);

    return Container(
      decoration: BoxDecoration(
        color: palette.surface2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: palette.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(
                children: [
                  Icon(_toolIcon(seg.name), size: 15, color: palette.muted),
                  const SizedBox(width: 8),
                  Text(
                    _toolLabel(seg.name),
                    style: TextStyle(color: palette.text, fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(width: 8),
                  if (phase != null)
                    Text(phase, style: TextStyle(color: palette.accent, fontSize: 11.5, fontWeight: FontWeight.w500))
                  else
                    Text('done',
                        style: TextStyle(
                            color: palette.muted, fontSize: 10, fontWeight: FontWeight.w600, letterSpacing: 0.6)),
                  const Spacer(),
                  AnimatedRotation(
                    turns: _expanded ? 0.5 : 0,
                    duration: const Duration(milliseconds: 150),
                    child: Icon(Icons.keyboard_arrow_down_rounded, size: 18, color: palette.muted),
                  ),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            Divider(height: 1, color: palette.border),
            if (inputText.isNotEmpty) _block(context, 'Request', inputText, palette, maxHeight: 160),
            if (seg.result != null) _block(context, 'Result', seg.result!, palette, maxHeight: 280),
          ],
        ],
      ),
    );
  }

  Widget _block(BuildContext context, String label, String body, SylorPalette palette, {required double maxHeight}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(color: palette.muted, fontSize: 10, fontWeight: FontWeight.w600, letterSpacing: 0.7),
          ),
          const SizedBox(height: 5),
          Container(
            width: double.infinity,
            constraints: BoxConstraints(maxHeight: maxHeight),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: palette.bg,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: palette.border),
            ),
            child: SingleChildScrollView(
              child: SelectableText(
                body,
                style: TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.4, color: palette.text),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
