import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/chat.dart';
import '../models/oraculum_model.dart';
import '../services/chat_client.dart';
import '../services/conversation_store.dart';
import '../theme.dart';
import '../widgets/chat_composer.dart';
import '../widgets/conversation_drawer.dart';
import '../widgets/message_bubble.dart';
import '../widgets/model_picker.dart';
import '../widgets/sylor_star.dart';

/// The main chat surface: a message list that streams the reply in, the model chooser in the
/// app bar, the history drawer, and the composer. This is where the gateway is actually driven.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  final ChatClient _client = ChatClient();
  final ScrollController _scroll = ScrollController();
  StreamSubscription<ChatEvent>? _sub;
  bool _streaming = false;
  ChatMessage? _pending; // the assistant message currently being filled

  @override
  void dispose() {
    _sub?.cancel();
    _client.abort();
    _scroll.dispose();
    super.dispose();
  }

  ConversationStore get _store => context.read<ConversationStore>();

  void _send(String text) {
    final store = _store;
    store.addMessage(ChatMessage(role: Role.user, content: text));

    final assistant = ChatMessage(role: Role.assistant, content: '');
    store.addMessage(assistant);
    setState(() {
      _streaming = true;
      _pending = assistant;
    });
    _scrollToBottom();

    // Send the full history (minus the just-added empty assistant turn) to the gateway.
    final history = store.active.messages
        .where((m) => !identical(m, assistant))
        .map((m) => m.toWire())
        .toList();

    _sub = _client.send(model: store.active.modelId, messages: history).listen(
      (event) {
        switch (event) {
          case ChatToken(:final text):
            setState(() => assistant.content += text);
            _scrollToBottomIfNear();
          case ChatDone():
            _finish();
          case ChatFailure(:final code, :final resetSeconds):
            _fail(assistant, code, resetSeconds);
        }
      },
      onError: (_) => _fail(assistant, 'network', null),
      onDone: _finish,
    );
  }

  void _finish() {
    if (!_streaming) return;
    _sub?.cancel();
    _sub = null;
    if (!mounted) return;
    _store.touch();
    setState(() {
      _streaming = false;
      _pending = null;
    });
  }

  void _fail(ChatMessage assistant, String code, int? resetSeconds) {
    if (assistant.content.trim().isEmpty) {
      assistant.content = _failureText(code, resetSeconds);
    }
    if (code == 'quota') {
      _snack('Daily limit reached — try again ${_resetPhrase(resetSeconds)}.');
    }
    _finish();
  }

  void _stop() {
    _client.abort();
    _finish();
  }

  Future<void> _pickModel() async {
    final store = _store;
    final chosen = await showModelPicker(context, selectedId: store.active.modelId);
    if (chosen != null) store.setActiveModel(chosen);
  }

  void _newChat() {
    if (_streaming) _stop();
    _store.newChat();
    _scaffoldKey.currentState?.closeDrawer();
    setState(() {});
  }

  void _openConversation(String id) {
    if (_streaming) _stop();
    _store.openConversation(id);
    _scaffoldKey.currentState?.closeDrawer();
    _scrollToBottom();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _scrollToBottomIfNear() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    if (pos.maxScrollExtent - pos.pixels >= 260) return; // person scrolled up — leave them be
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  String _failureText(String code, int? resetSeconds) {
    switch (code) {
      case 'quota':
        return '_You\'ve reached the shared daily limit. Please try again '
            '${_resetPhrase(resetSeconds)}._';
      case 'network':
        return '_Couldn\'t reach Sylor. Check your connection and try again._';
      default:
        return '_Something went wrong reaching the model. Please try again._';
    }
  }

  String _resetPhrase(int? resetSeconds) {
    if (resetSeconds == null || resetSeconds <= 0) return 'later';
    if (resetSeconds < 3600) return 'in ${(resetSeconds / 60).ceil()} min';
    return 'in ${(resetSeconds / 3600).ceil()} h';
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final store = context.watch<ConversationStore>();
    final messages = store.active.messages;

    return Scaffold(
      key: _scaffoldKey,
      drawer: ConversationDrawer(onSelect: _openConversation, onNewChat: _newChat),
      appBar: AppBar(
        title: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: _pickModel,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  oraculumModelName(store.active.modelId),
                  style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w600),
                ),
                Icon(Icons.expand_more_rounded, color: palette.muted, size: 20),
              ],
            ),
          ),
        ),
        actions: [
          IconButton(
            icon: Icon(Icons.edit_square, color: palette.text, size: 22),
            tooltip: 'New chat',
            onPressed: _newChat,
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: messages.isEmpty
                ? _emptyState(palette)
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                    itemCount: messages.length,
                    itemBuilder: (context, i) {
                      final m = messages[i];
                      return MessageBubble(
                        message: m,
                        streaming: _streaming && identical(m, _pending),
                      );
                    },
                  ),
          ),
          ChatComposer(onSend: _send, onStop: _stop, streaming: _streaming),
        ],
      ),
    );
  }

  Widget _emptyState(SylorPalette palette) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SylorStar(size: 52, color: palette.accent),
            const SizedBox(height: 18),
            Text(
              'How can I help today?',
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.text, fontSize: 20, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Text(
              'Ask anything. Sylor streams answers in real time.',
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.muted, fontSize: 14, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }
}
