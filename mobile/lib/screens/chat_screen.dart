import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/chat.dart';
import '../models/byok_config.dart';
import '../services/auth_service.dart';
import '../services/byok_service.dart';
import '../services/chat_client.dart';
import '../services/conversation_store.dart';
import '../theme.dart';
import '../widgets/chat_composer.dart';
import '../widgets/chat_empty_state.dart';
import '../widgets/conversation_drawer.dart';
import '../widgets/effort_picker.dart';
import '../widgets/message_bubble.dart';
import '../widgets/model_picker.dart';
import '../widgets/myto_mark.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  final ChatClient _client = ChatClient();
  final ScrollController _scroll = ScrollController();
  final TextEditingController _composer = TextEditingController();
  final FocusNode _composerFocus = FocusNode();
  StreamSubscription<ChatEvent>? _sub;
  bool _streaming = false;
  ChatMessage? _pending;

  // Reasoning-effort selection from the composer chip. 'auto' → send nothing (model default);
  // low/medium/high → forwarded to the gateway as `reasoningEffort`.
  String _effort = 'auto';

  // Streaming tokens arrive far faster than the screen needs to repaint. We append
  // each token straight into the message model (cheap) and only rebuild on a throttle,
  // so a fast reply repaints ~15×/s instead of once per token — the difference between
  // a smooth stream and the whole transcript re-laying-out on every character.
  Timer? _flushTimer;
  bool _dirty = false;

  @override
  void dispose() {
    _flushTimer?.cancel();
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

    // Chat against the account's own endpoint. If the stored model was removed, fall back to the
    // first available one.
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
            // Mutate the model now (no rebuild); repaint on the throttle below.
            assistant.content += text;
            _scheduleFlush();
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

  /// Coalesce streamed tokens into a single repaint every ~66ms. Without this every
  /// token triggers a full `setState`, rebuilding the whole transcript (and re-parsing
  /// the streaming message's Markdown/tool blocks) — the main cause of streaming lag.
  void _scheduleFlush() {
    _dirty = true;
    if (_flushTimer != null) return;
    _flushTimer = Timer(const Duration(milliseconds: 66), () {
      _flushTimer = null;
      if (!mounted || !_dirty) return;
      _dirty = false;
      setState(() {});
      _scrollToBottomIfNear();
    });
  }

  Future<void> _pickEffort() async {
    final chosen = await showEffortPicker(context, selected: _effort);
    if (chosen != null && chosen != _effort) setState(() => _effort = chosen);
  }

  void _finish() {
    if (!_streaming) return;
    // Flush any tokens buffered since the last throttled repaint.
    _flushTimer?.cancel();
    _flushTimer = null;
    _dirty = false;
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
    final models = context.read<ByokService>().config?.models ?? const <ByokModel>[];
    if (models.isEmpty) {
      _snack('Add your provider and a model on the Myto website first.');
      return;
    }
    final chosen = await showModelPicker(context, models: models, selectedId: store.active.modelId);
    if (chosen != null) store.setActiveModel(chosen);
  }

  void _newChat() {
    if (_streaming) _stop();
    _store.newChat();
    _composer.clear();
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
      key: _scaffoldKey,
      drawer: ConversationDrawer(onSelect: _openConversation, onNewChat: _newChat),
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            MytoMark(size: 22, color: palette.text),
            const SizedBox(width: 8),
            Text(
              'Myto',
              style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
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
                      return TweenAnimationBuilder<double>(
                        key: ObjectKey(m),
                        tween: Tween(begin: 0, end: 1),
                        duration: const Duration(milliseconds: 280),
                        curve: Curves.easeOutCubic,
                        builder: (context, t, child) => Opacity(
                          opacity: t.clamp(0.0, 1.0),
                          child: Transform.translate(offset: Offset(0, (1 - t) * 10), child: child),
                        ),
                        child: MessageBubble(
                          message: m,
                          streaming: _streaming && identical(m, _pending),
                        ),
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
              onNewChat: _newChat,
            ),
        ],
      ),
    );
  }
  String? _firstName(AuthService auth) {
    if (auth.user == null) return null;
    final name = auth.displayName.trim();
    if (name.isEmpty || name == 'Guest') return null;
    return name.split(RegExp(r'\s+')).first;
  }
}

/// Shown when the account has no bring-your-own-key config yet: chat can't run until the user adds
/// their provider and a model on the website's Authentication page.
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
          children: [
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
              style: TextStyle(color: palette.accent, fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
    );
  }
}
