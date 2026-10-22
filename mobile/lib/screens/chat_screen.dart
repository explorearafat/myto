import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/chat.dart';
import '../models/byok_config.dart';
import '../models/agent.dart';
import '../services/auth_service.dart';
import '../services/byok_service.dart';
import '../services/chat_client.dart';
import '../services/conversation_store.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/chat_composer.dart';
import '../widgets/chat_empty_state.dart';
import '../widgets/effort_picker.dart';
import '../widgets/message_bubble.dart';
import '../widgets/model_picker.dart';
import '../widgets/myto_mark.dart';
import '../widgets/teamly/kit.dart';
import '../widgets/teamly/parts.dart';

/// The Chat tab — the app's inbox and hub, laid out exactly like the reference:\n///
///   [avatar] [Teamly AI]                              [+]\n///   [🔍 Search]                                      search pill\n///   Little T — Your YouTube Short is ready!  Tue     agent notification row\n///   ⌄ PINNED · 1\n///   Teamly Agent ✔ — You are now friends\n///   ⌄ CHATS · 15\n///   AI Feature Build Room — AI Engineer, Prompt Eng... (stacked avatars)\n///   Code Review Guild — Code Reviewer, Senior Devel...\n///   Software Architect — You are now friends\n///   ...\n///\n/// Tapping a row opens that thread (the classic Myto conversation UI below the\n/// list); the back button returns to the list. All streaming/auth plumbing is\n/// unchanged from the original single-screen app.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  // -- original streaming machinery (unchanged) -------------------------------
  final ChatClient _client = ChatClient();
  final ScrollController _scroll = ScrollController();
  final TextEditingController _composer = TextEditingController();
  final FocusNode _composerFocus = FocusNode();
  StreamSubscription<ChatEvent>? _sub;
  bool _streaming = false;
  ChatMessage? _pending;
  String _effort = 'auto';
  Timer? _flushTimer;
  bool _dirty = false;

  // -- new shell state --------------------------------------------------------
  bool _inThread = false;
  String _query = '';

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

  // -- shell transitions ------------------------------------------------------

  /// Open a saved conversation (from the Chats group) and enter the thread.
  void _openConversation(String id) {
    if (_streaming) _stop();
    _store.openConversation(id);
    setState(() => _inThread = true);
    _scrollToBottom();
  }

  /// Fresh draft + thread.
  void _newChat() {
    if (_streaming) _stop();
    _store.newChat();
    _composer.clear();
    setState(() => _inThread = true);
  }

  void _backToList() {
    if (_streaming) _stop();
    _store.newChat();
    _composer.clear();
    setState(() => _inThread = false);
  }

  /// Chat button on an agent row → befriend + start a thread with them.
  void _chatWithAgent(Agent agent, StudioStore studio) {
    if (!studio.isFriend(agent.id)) {
      studio.toggleFriend(agent.id);
      _snack('You are now friends with ${agent.name}.');
    }
    _store.newChat();
    setState(() => _inThread = true);
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
    if (_inThread) return _buildThread(context);
    return _buildList(context);
  }

  // ---------------------------------------------------------------------------
  // Thread: the original conversation UI, restyled to the Teamly surface.
  // ---------------------------------------------------------------------------
  Widget _buildThread(BuildContext context) {
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
          onPressed: _backToList,
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
            child: Center(child: TeamlyFab(icon: Icons.add_rounded, onPressed: _newChat)),
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
              onNewChat: _newChat,
            ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // List: the reference Chat tab.
  // ---------------------------------------------------------------------------
  Widget _buildList(BuildContext context) {
    final palette = Theme.of(context).palette;
    final store = context.watch<ConversationStore>();
    final studio = context.watch<StudioStore>();
    final auth = context.watch<AuthService>();

    final q = _query.trim().toLowerCase();
    final conversations = store.conversations
        .where((c) => q.isEmpty || c.title.toLowerCase().contains(q))
        .toList(growable: false);

    return Scaffold(
      appBar: AppBar(
        leading: Padding(
          padding: const EdgeInsets.only(left: TeamlySpace.s3),
          child: Center(
            child: auth.photoURL != null
                ? ClipOval(
                    child: Image.network(auth.photoURL!, width: 34, height: 34, fit: BoxFit.cover),
                  )
                : TeamlyAvatar(pastelIndex: 1, size: 34),
          ),
        ),
        centerTitle: true,
        title: const Text('Teamly AI'),
        actions: <Widget>[
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(child: TeamlyFab(icon: Icons.add_rounded, onPressed: _newChat)),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: TeamlySearch(
              hint: 'Search',
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Expanded(
            child: ListView(
              children: <Widget>[
                _notificationRow(context, palette),
                TeamlyGroupHeader(
                  label: 'Pinned',
                  count: 1,
                  onToggle: () {},
                ),
                if (studio.agents.isNotEmpty)
                  _agentRow(context, studio.agents.firstWhere(
                    (a) => a.id == 'content-creator',
                    orElse: () => studio.agents.first,
                  ), studio),
                TeamlyGroupHeader(
                  label: 'Chats',
                  count: conversations.length,
                  onToggle: () {},
                ),
                if (conversations.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(TeamlySpace.s6),
                    child: Text(
                      'Your conversations will appear here.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: TeamlyColors.ink300, fontSize: 14),
                    ),
                  )
                else
                  ...conversations.map((c) => _conversationRow(context, c)),
                const SizedBox(height: TeamlySpace.s6),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Little T — the agent completion notification, pinned above everything.
  Widget _notificationRow(BuildContext context, MytoPalette palette) {
    return TeamlyCard(
      onTap: _newChat,
      padding: const EdgeInsets.all(TeamlySpace.s4),
      child: Row(
        children: <Widget>[
          TeamlyAvatar(
            pastelIndex: 0,
            size: 44,
            badgeIcon: Icons.play_arrow_rounded,
          ),
          const SizedBox(width: TeamlySpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Little T',
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                const Text(
                  'Your YouTube Short is ready! 🐦⚡',
                  style: TextStyle(color: TeamlyColors.ink500, fontSize: 14),
                ),
              ],
            ),
          ),
          const Text(
            'Tue',
            style: TextStyle(color: TeamlyColors.ink300, fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _agentRow(BuildContext context, Agent agent, StudioStore studio) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
      child: TeamlyCard(
        onTap: () => _chatWithAgent(agent, studio),
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            TeamlyAvatar(pastelIndex: agent.pastelIndex, size: 44, dot: agent.friends),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    agent.name,
                    style: TextStyle(
                      color: TeamlyColors.ink900,
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    agent.friends ? 'You are now friends' : 'Say hi',
                    style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                  ),
                ],
              ),
            ),
            const Icon(Icons.check_circle_rounded, size: 18, color: TeamlyColors.green500),
          ],
        ),
      ),
    );
  }

  Widget _conversationRow(BuildContext context, Conversation c) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
      child: TeamlyCard(
        onTap: () => _openConversation(c.id),
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            TeamlyStackedAvatars(pastelIndices: const <int>[2, 0], size: 40),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    c.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: TeamlyColors.ink900,
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    c.messages.isEmpty
                        ? 'New chat'
                        : c.messages.last.content.replaceAll(RegExp(r'\s+'), ' '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                  ),
                ],
              ),
            ),
            const SizedBox(width: TeamlySpace.s2),
            Text(
              _timeLabel(c.updatedAt),
              style: const TextStyle(color: TeamlyColors.ink300, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }

  String _timeLabel(DateTime at) {
    final now = DateTime.now();
    if (now.difference(at).inMinutes < 1) return 'now';
    if (now.difference(at).inMinutes < 60) return '${now.difference(at).inMinutes}m';
    if (at.day == now.day) {
      final h = at.hour % 12 == 0 ? 12 : at.hour % 12;
      return '$h:${at.minute.toString().padLeft(2, '0')}';
    }
    return '${at.day}/${at.month}';
  }
}

/// Shown when the account has no bring-your-own-key config yet: chat can't run
/// until the user adds their provider and a model on the website.
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
              style: TextStyle(color: palette.accent, fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
    );
  }
}