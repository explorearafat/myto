import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/byok_config.dart';
import '../models/chat.dart';
import '../services/auth_service.dart';
import '../services/byok_service.dart';
import '../services/chat_client.dart';
import '../services/conversation_store.dart';
import '../theme.dart';
import '../widgets/chat_composer.dart';
import '../widgets/chat_empty_state.dart';
import '../widgets/effort_picker.dart';
import '../widgets/message_bubble.dart';
import '../widgets/model_picker.dart';
import '../widgets/myto_mark.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// MytoChatScreen — the plain 1-to-1 chat with the Myto assistant (the classic
/// bring-your-own-key streaming thread). Pushed as a route from the Chat tab's
/// "+" button or a saved plain conversation, so the bottom nav is hidden while
/// it is open.
/// ---------------------------------------------------------------------------
class MytoChatScreen extends StatefulWidget {
  const MytoChatScreen({super.key, this.conversationId});

  /// Resume this saved conversation; null starts a fresh chat.
  final String? conversationId;

  @override
  State<MytoChatScreen> createState() => _MytoChatScreenState();
}

class _MytoChatScreenState extends State<MytoChatScreen> {
  final ChatClient _client = ChatClient();
  final ScrollController _scroll = ScrollController();
  final TextEditingController _composer = TextEditingController();
  final FocusNode _composerFocus = FocusNode();
  StreamSubscription<ChatEvent>? _sub;
  bool _streaming = false;
  ChatMessage? _pending;
  // Speed-first default: reasoning models burn hidden thinking before the first
  // visible word, and 'auto' left the provider's own (often heavy) default in
  // charge. 'low' goes out on every request unless the user picks otherwise.
  String _effort = 'low';

  /// Live tokens write straight into the pending bubble; repaints are throttled
  /// to this interval so Markdown re-parsing stays cheap on mid-range phones.
  static const int _paintIntervalMs = 40;
  DateTime _lastPaint = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void initState() {
    super.initState();
    final store = context.read<ConversationStore>();
    if (widget.conversationId != null) {
      store.openConversation(widget.conversationId!);
    } else {
      store.newChat();
    }
    _scrollToBottom();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _client.abort();
    _scroll.dispose();
    _composer.dispose();
    _composerFocus.dispose();
    super.dispose();
  }

  ConversationStore get _store => context.read<ConversationStore>();

  void _send(String text) {
    final cfg = context.read<ByokService>().config;
    if (cfg == null || !cfg.isConfigured) {
      _snack('Add your provider and a model on the Myto website first.');
      return;
    }
    final store = _store;
    store.addMessage(ChatMessage(role: Role.user, content: text));

    final assistant = ChatMessage(role: Role.assistant, content: '');
    store.addMessage(assistant);
    setState(() {
      _streaming = true;
      _pending = assistant;
    });
    _scrollToBottom();
    final history = store.active.messages
        .where((m) => !identical(m, assistant))
        .map((m) => m.toWire())
        .toList();

    final modelId = cfg.models.any((m) => m.id == store.active.modelId)
        ? store.active.modelId
        : cfg.models.first.id;

    _sub = _client
        .send(
          model: modelId,
          messages: history,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          authSchema: cfg.authSchema,
          authHeaderName: cfg.authHeaderName,
          reasoningEffort: _effort == 'auto' ? null : _effort,
        )
        .listen(
      (event) {
        switch (event) {
          case ChatToken(:final text):
            // Paint tokens the moment they land — first words appear as soon as
            // the provider starts answering, not when the whole reply is done.
            assistant.content += text;
            _throttledRepaint();
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

  /// Repaint at most every [_paintIntervalMs]; the trailing token still lands
  /// via [_finish]'s setState, so nothing is ever left unpainted.
  void _throttledRepaint() {
    final now = DateTime.now();
    if (now.difference(_lastPaint).inMilliseconds < _paintIntervalMs) return;
    _lastPaint = now;
    if (!mounted) return;
    _scrollToBottomIfNear();
    setState(() {});
  }

  Future<void> _pickEffort() async {
    final chosen = await showEffortPicker(context, selected: _effort);
    if (chosen != null && chosen != _effort) setState(() => _effort = chosen);
  }

  void _finish() {
    if (!_streaming) return;
    _sub?.cancel();
    _sub = null;

    final ChatMessage? pending = _pending;
    if (pending != null && pending.content.isNotEmpty) {
      pending.content = pending.content.trim();
    }

    if (!mounted) return;
    _store.touch();
    setState(() {
      _streaming = false;
      _pending = null;
    });
    _scrollToBottomIfNear();
  }

  void _fail(ChatMessage assistant, String code, int? resetSeconds) {
    // Keep whatever streamed in before the failure, then explain the failure
    // only if nothing did.
    assistant.content = assistant.content.trim();
    if (assistant.content.isEmpty) {
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
    final models = context.read<ByokService>().config?.models ?? const <ByokModel>[];
    if (models.isEmpty) {
      _snack('Add your provider and a model on the Myto website first.');
      return;
    }
    final chosen = await showModelPicker(context, models: models, selectedId: store.active.modelId);
    if (chosen != null) store.setActiveModel(chosen);
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
    if (pos.maxScrollExtent - pos.pixels >= 260) return;
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
        return '_Couldn\'t reach Myto. Check your connection and try again._';
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

  String? _firstName(AuthService auth) {
    if (auth.user == null) return null;
    final name = auth.displayName.trim();
    if (name.isEmpty || name == 'Guest') return null;
    return name.split(RegExp(r'\s+')).first;
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final store = context.watch<ConversationStore>();
    final auth = context.watch<AuthService>();
    final byok = context.watch<ByokService>();
    final messages = store.active.messages;
    final configured = byok.config?.isConfigured ?? false;

    String modelLabel() {
      final models = byok.config?.models ?? const <ByokModel>[];
      final match = models.where((m) => m.id == store.active.modelId);
      if (match.isNotEmpty) return match.first.name;
      if (models.isNotEmpty) return models.first.name;
      return 'Model';
    }

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          tooltip: 'Back to chats',
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            MytoMark(size: 22, color: palette.text),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                store.active.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
        actions: <Widget>[
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(
              child: TeamlyFab(
                icon: Icons.add_rounded,
                onPressed: () {
                  _client.abort();
                  _finish();
                  store.newChat();
                  _composer.clear();
                },
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Expanded(
            child: !configured
                ? _SetupPrompt(palette: palette)
                : messages.isEmpty
                    ? ChatEmptyState(firstName: _firstName(auth))
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
          if (configured)
            ChatComposer(
              controller: _composer,
              focusNode: _composerFocus,
              onSend: _send,
              onStop: _stop,
              streaming: _streaming,
              modelLabel: modelLabel(),
              onPickModel: _pickModel,
              effortLabel: effortLabel(_effort),
              onPickEffort: _pickEffort,
              onNewChat: () {
                _client.abort();
                _finish();
                store.newChat();
                _composer.clear();
              },
            ),
        ],
      ),
    );
  }
}

/// Shown when the account has no bring-your-own-key config yet.
class _SetupPrompt extends StatelessWidget {
  const _SetupPrompt({required this.palette});

  final MytoPalette palette;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.key_rounded, size: 40, color: palette.muted),
            const SizedBox(height: 16),
            Text(
              'Add your model',
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.text, fontSize: 20, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 10),
            Text(
              'Open the Myto website, sign in, and add your provider’s base URL, API key, and a '
              'model on the Authentication page. It’ll sync here automatically.',
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.muted, fontSize: 14, height: 1.5),
            ),
            const SizedBox(height: 6),
            Text(
              'mytocode.vercel.app/authentication',
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.accentText, fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
    );
  }
}
