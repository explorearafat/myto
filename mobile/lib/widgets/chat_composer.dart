import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;

import '../theme.dart';
import 'myto_mark.dart';

class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onSend,
    required this.onStop,
    required this.streaming,
    required this.modelLabel,
    required this.onPickModel,
    required this.effortLabel,
    required this.onPickEffort,
    required this.onNewChat,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final void Function(String text) onSend;
  final VoidCallback onStop;
  final bool streaming;
  final String modelLabel;
  final VoidCallback onPickModel;
  final String effortLabel;
  final VoidCallback onPickEffort;
  final VoidCallback onNewChat;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _hasText = false;
  bool _speechChecked = false;
  bool _speechAvailable = false;
  bool _listening = false;
  String _base = ''; // text present before dictation started; results append to it

  @override
  void initState() {
    super.initState();
    _hasText = widget.controller.text.trim().isNotEmpty;
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    if (_listening) {
      _speech.cancel();
    }
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

  // ── Voice input (on-device speech recognition, graceful degrade) ────────────
  Future<void> _toggleMic() async {
    if (_listening) {
      await _stopListening();
    } else {
      await _startListening();
    }
  }

  Future<void> _startListening() async {
    if (widget.streaming) return;
    if (!_speechChecked) {
      _speechChecked = true;
      try {
        _speechAvailable = await _speech.initialize(
          onError: (_) {
            if (mounted) setState(() => _listening = false);
          },
          onStatus: (status) {
            if ((status == 'done' || status == 'notListening') && mounted) {
              setState(() => _listening = false);
            }
          },
        );
      } catch (_) {
        _speechAvailable = false;
      }
    }
    if (!_speechAvailable) {
      _toast('Voice input isn\'t available on this device.');
      return;
    }
    if (!mounted) return; // widget went away during initialize()
    // Preserve whatever's already typed; dictation appends after it.
    _base = widget.controller.text;
    if (_base.isNotEmpty && !_base.endsWith(' ')) _base += ' ';
    HapticFeedback.selectionClick();
    setState(() => _listening = true);
    try {
      await _speech.listen(
        onResult: (result) {
          final text = '$_base${result.recognizedWords}';
          widget.controller.value = TextEditingValue(
            text: text,
            selection: TextSelection.collapsed(offset: text.length),
          );
        },
      );
    } catch (_) {
      if (mounted) setState(() => _listening = false);
      _toast('Couldn\'t start voice input.');
    }
  }

  Future<void> _stopListening() async {
    try {
      await _speech.stop();
    } catch (_) {
      /* already stopped */
    }
    if (mounted) setState(() => _listening = false);
    widget.focusNode.requestFocus();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
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
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
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
                  contentPadding: const EdgeInsets.symmetric(vertical: 8),
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  // "+" — start a fresh chat, like Claude's composer.
                  _iconButton(palette, Icons.add_rounded, 'New chat', widget.onNewChat),
                  const SizedBox(width: 2),
                  Expanded(
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          _chip(
                            palette,
                            MytoMark(size: 15, color: palette.accent),
                            widget.modelLabel,
                            widget.onPickModel,
                          ),
                          const SizedBox(width: 8),
                          _chip(
                            palette,
                            Icon(Icons.bolt_rounded, size: 16, color: palette.accent),
                            widget.effortLabel,
                            widget.onPickEffort,
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 180),
                    transitionBuilder: (child, animation) => ScaleTransition(
                      scale: animation,
                      child: FadeTransition(opacity: animation, child: child),
                    ),
                    child: _button(palette),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  // Right-hand action. Precedence: streaming → stop; listening → mic stays tappable while
  // dictating (this wins over having text); text present → send; otherwise → idle mic.
  Widget _button(MytoPalette palette) {
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
    if (_listening) {
      return _circle(
        const ValueKey('listening'),
        palette.accent,
        Icons.mic_rounded,
        palette.onAccent,
        _toggleMic,
        'Stop listening',
      );
    }
    if (_hasText) {
      return _circle(
        const ValueKey('send'),
        palette.accent,
        Icons.arrow_upward_rounded,
        palette.onAccent,
        _submit,
        'Send',
      );
    }
    return _circle(
      const ValueKey('mic'),
      palette.surface2,
      Icons.mic_none_rounded,
      palette.muted,
      _toggleMic,
      'Voice input',
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

  Widget _iconButton(MytoPalette palette, IconData icon, String tooltip, VoidCallback onTap) {
    return IconButton(
      onPressed: onTap,
      icon: Icon(icon, size: 22),
      color: palette.muted,
      tooltip: tooltip,
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
    );
  }

  Widget _chip(MytoPalette palette, Widget leading, String label, VoidCallback onTap) {
    return Material(
      color: palette.surface2,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 6, 8, 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              leading,
              const SizedBox(width: 5),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 130),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: palette.text, fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 2),
              Icon(Icons.expand_more_rounded, size: 16, color: palette.muted),
            ],
          ),
        ),
      ),
    );
  }
}
