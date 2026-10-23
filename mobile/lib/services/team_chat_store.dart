import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/agent.dart';
import '../models/byok_config.dart';
import '../models/chat.dart';
import 'chat_client.dart';
import 'conversation_store.dart';
import 'studio_store.dart';

/// ---------------------------------------------------------------------------
/// TeamChatStore — the engine behind the agent chats and the research rooms.
///
/// Two surfaces share this store:
///   • 1-to-1 agent chats (key `agent:<id>`): the user talks to one roster
///     specialist. The agent's persona [Agent.prompt] is sent as the system
///     message, so replies stay in character.
///   • Rooms (key `room:<id>`): a group chat where every member takes a turn
///     after the user speaks — each reply is a real model call wearing that
///     agent's persona, then a final "Research Report" message summarises the
///     discussion.
///
/// Threads are kept in memory for the session and mirrored into
/// [ConversationStore] (with a `channel` marker) so they persist and appear in
/// the Chat tab's saved list. No demo data anywhere: every thread starts empty.
/// ---------------------------------------------------------------------------
class TeamChatStore extends ChangeNotifier {
  TeamChatStore(this._conversations, this._studio);

  final ConversationStore _conversations;
  final StudioStore _studio;
  final ChatClient _client = ChatClient();

  /// channelKey -> live thread (hydrated from saved conversations on first use).
  final Map<String, List<ChatMessage>> _threads = <String, List<ChatMessage>>{};

  /// channelKey -> currently streaming assistant message.
  final Map<String, ChatMessage> _streaming = <String, ChatMessage>{};

  /// channelKey -> the room turn queue (agent ids still to speak).
  final Map<String, List<String>> _roomQueue = <String, List<String>>{};

  final Map<String, AgentTeam> _roomCache = <String, AgentTeam>{};

  /// Look up a room by id — seeded rooms from the roster first, then any
  /// persisted user rooms from the studio store.
  AgentTeam? roomById(String id) {
    final cached = _roomCache[id];
    if (cached != null) return cached;
    for (final AgentTeam t in kSeedTeams) {
      if (t.id == id) {
        _roomCache[id] = t;
        return t;
      }
    }
    final studioRoom = _studio.teamById(id);
    if (studioRoom != null) _roomCache[id] = studioRoom;
    return studioRoom;
  }

  bool _busy = false;
  int _generation = 0;
  String? _roomSpeaker;

  // -- thread access ---------------------------------------------------------

  List<ChatMessage> messagesFor(String channelKey) {
    final thread = _threads[channelKey] ??= <ChatMessage>[];
    // Hydrate from a persisted conversation with this channel marker.
    if (thread.isEmpty) {
      for (final Conversation c in _conversations.conversations) {
        if (c.channel == channelKey) {
          thread.addAll(c.messages);
          break;
        }
      }
    }
    return List<ChatMessage>.unmodifiable(thread);
  }

  bool isStreaming(String channelKey) => _streaming.containsKey(channelKey);

  /// The assistant message currently streaming in a thread (for the typing dots).
  ChatMessage? streamingMessageFor(String channelKey) => _streaming[channelKey];

  bool get anyStreaming => _busy;

  /// The roster agent id currently speaking inside a room (null otherwise).
  String? get roomSpeaker => _roomSpeaker;

  /// The channel key for a 1-to-1 chat with an agent.
  static String directKey(String agentId) => 'agent:$agentId';

  /// The channel key for a room.
  static String roomKey(String roomId) => 'room:$roomId';

  /// Extract the agent/room id from a channel key (`agent:x` → `x`).
  static String idFromKey(String channelKey) {
    final i = channelKey.indexOf(':');
    return i < 0 ? channelKey : channelKey.substring(i + 1);
  }

  // -- 1-to-1 chat -----------------------------------------------------------

  Future<void> sendDirect({
    required Agent agent,
    required String text,
    required ByokConfig? config,
  }) async {
    final key = directKey(agent.id);
    final thread = _threads[key] ??= <ChatMessage>[];

    thread.add(ChatMessage(role: Role.user, content: text));
    final assistant = ChatMessage(role: Role.assistant, content: '');
    thread.add(assistant);
    _streaming[key] = assistant;
    _busy = true;
    notifyListeners();

    await _streamOne(
      key: key,
      message: assistant,
      system: agent.prompt,
      config: config,
      fallback: _directFallback(agent, text),
    );

    _streaming.remove(key);
    _busy = _streaming.isNotEmpty || _roomQueue.isNotEmpty;
    _sync(key);
    notifyListeners();
  }

  // -- rooms -----------------------------------------------------------------

  /// Kick off a room discussion: user message, then one turn per member in
  /// roster order, then the research report.
  Future<void> sendToRoom({
    required AgentTeam room,
    required String text,
    required ByokConfig? config,
  }) async {
    final key = roomKey(room.id);
    final thread = _threads[key] ??= <ChatMessage>[];

    thread.add(ChatMessage(role: Role.user, content: text));
    final members = <Agent>[
      for (final id in room.agentIds)
        if (agentById(id) != null) agentById(id)!,
    ];
    if (members.isEmpty) {
      // No model members — reflect the message back plainly.
      thread.add(ChatMessage(
        role: Role.assistant,
        content: 'This room has no agents yet. Add members from the Agents tab.',
        senderName: 'System',
      ));
      notifyListeners();
      return;
    }

    _roomQueue[key] = <String>[for (final a in members) a.id];
    _busy = true;
    notifyListeners();

    // Agents take turns; each one sees the whole transcript so the discussion
    // actually builds on what the previous specialist said.
    while (_roomQueue[key]?.isNotEmpty ?? false) {
      final queue = _roomQueue[key]!;
      final agentId = queue.removeAt(0);
      _roomSpeaker = agentId;

      final agent = agentById(agentId)!;
      final msg = ChatMessage(role: Role.assistant, content: '', senderName: agent.name);
      thread.add(msg);
      _streaming[key] = msg;
      notifyListeners();

      final system = '${agent.prompt}\n\n'
          'You are one member of a research room. The user asked: "$text".\n'
          'Other specialists have already shared their views. Add YOUR expert '
          'angle, disagree where the evidence says so, and keep it focused. '
          'Do not repeat what others said.';

      await _streamOne(
        key: key,
        message: msg,
        system: system,
        config: config,
        fallback: _roomFallback(agent, text),
      );

      // Small human pause between speakers.
      await Future<void>.delayed(const Duration(milliseconds: 450));
    }

    _roomQueue.remove(key);
    _roomSpeaker = null;

    // Final report: one consolidated summary over the whole discussion.
    if (thread.isNotEmpty) {
      final report = ChatMessage(
        role: Role.assistant,
        content: '',
        senderName: 'Research Report',
      );
      thread.add(report);
      _streaming[key] = report;
      notifyListeners();

      final transcript = thread
          .where((m) => !identical(m, report))
          .map((m) => m.isUser ? 'User: ${m.content}' : '${m.senderName ?? 'Agent'}: ${m.content}')
          .join('\n');

      await _streamOne(
        key: key,
        message: report,
        system: 'You are the research room\'s lead. Write a clear, structured '
            '"Research Report" answering the user\'s original question using the '
            'discussion below. Use short sections (Findings, Recommendation, '
            'Next steps). Be concrete and honest about unknowns.',
        context: transcript,
        config: config,
        fallback: _reportFallback(text),
      );

      _streaming.remove(key);
    }

    _busy = _streaming.isNotEmpty || _roomQueue.isNotEmpty;
    _sync(key);
    notifyListeners();
  }

  // -- shared streaming ------------------------------------------------------

  Future<void> _streamOne({
    required String key,
    required ChatMessage message,
    required String system,
    required ByokConfig? config,
    String? context,
    required String fallback,
  }) async {
    // No configured model (or offline): answer with the honest offline frame
    // instead of hitting the gateway with an empty key.
    if (config == null || !config.isConfigured) {
      message.content = fallback;
      notifyListeners();
      return;
    }

    final int gen = ++_generation;
    final history = <Map<String, String>>[
      <String, String>{'role': 'system', 'content': system},
    ];
    final thread = _threads[key] ?? <ChatMessage>[];
    for (final m in thread) {
      if (identical(m, message)) continue;
      final role = m.isUser ? 'user' : 'assistant';
      final content = m.senderName == null
          ? m.content
          : '[${m.senderName}] ${m.content}';
      history.add(<String, String>{'role': role, 'content': content});
    }
    if (context != null && context.isNotEmpty) {
      history.add(<String, String>{'role': 'user', 'content': context});
    }

    final modelId = config.models.isNotEmpty ? config.models.first.id : '';

    await for (final event in _client.send(
      model: modelId,
      messages: history,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      authSchema: config.authSchema,
      authHeaderName: config.authHeaderName,
    )) {
      if (gen != _generation) return; // aborted / superseded
      switch (event) {
        case ChatToken(:final text):
          message.content += text;
          notifyListeners();
        case ChatDone():
          if (message.content.trim().isEmpty) message.content = fallback;
          return;
        case ChatFailure():
          if (message.content.trim().isEmpty) message.content = fallback;
          return;
      }
    }
    if (message.content.trim().isEmpty) message.content = fallback;
  }

  // -- fallbacks (offline / unconfigured) ------------------------------------

  String _directFallback(Agent agent, String text) {
    final t = text.trim();
    final short = t.length > 140 ? '${t.substring(0, 140)}...' : t;
    return '**${agent.name}** · I\'m ${agent.description}\n\n'
        'I\'ll do my best on “$short” — connect a model on the Myto website '
        '(mytocode.vercel.app/authentication) and I\'ll answer with my full '
        'expertise, streaming live.';
  }

  String _roomFallback(Agent agent, String text) {
    final t = text.trim();
    final short = t.length > 140 ? '${t.substring(0, 140)}...' : t;
    return '**${agent.name}** — taking the “$short” brief from my side. '
        'Connecting a model lets me research it properly; meanwhile here\'s my '
        'first read: ${agent.category}';
  }

  String _reportFallback(String text) {
    final t = text.trim();
    final short = t.length > 140 ? '${t.substring(0, 140)}...' : t;
    return '### Research Report — “$short”\n\n'
        '**Findings** · The room split the problem into its specialist angles '
        '(quality, health, debugging, review, finance, market).\n\n'
        '**Recommendation** · Connect a model on the Myto website and re-run '
        'this room: every member will then research your question with real '
        'reasoning instead of this offline summary.\n\n'
        '**Next steps** · 1) Add your model at mytocode.vercel.app/authentication. '
        '2) Re-ask your question here. 3) Ask the room for a deeper report.';
  }

  // -- persistence -----------------------------------------------------------

  /// Mirror a live thread into the saved conversation list so it survives a
  /// restart and shows in the Chat tab under its channel marker.
  void _sync(String channelKey) {
    final thread = _threads[channelKey];
    if (thread == null || thread.isEmpty) return;
    final id = idFromKey(channelKey);
    final isRoom = channelKey.startsWith('room:');
    final String title;
    if (isRoom) {
      title = _studio.teamById(id)?.name ?? 'Room';
    } else {
      title = agentById(id)?.name ?? 'Agent chat';
    }

    Conversation? existing;
    for (final c in _conversations.conversations) {
      if (c.channel == channelKey) {
        existing = c;
        break;
      }
    }

    if (existing == null) {
      _conversations.import(Conversation(
        id: 'ch-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}',
        title: title,
        modelId: '',
        channel: channelKey,
        messages: List<ChatMessage>.from(thread),
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      ));
    } else {
      existing.title = title;
      existing.messages
        ..clear()
        ..addAll(thread);
      existing.updatedAt = DateTime.now();
      // Dedupe + re-insert + persist in one call.
      _conversations.import(existing);
    }
  }

  /// Abort everything (called when a chat screen is closed mid-stream).
  void abortAll() {
    _generation++;
    _client.abort();
    _roomQueue.clear();
    _streaming.clear();
    _roomSpeaker = null;
    _busy = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _client.abort();
    super.dispose();
  }
}
