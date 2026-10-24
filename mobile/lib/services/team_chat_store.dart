import 'dart:async';
import 'dart:convert';

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
///   • Rooms (key `room:<id>`): a group chat where every member answers the
///     user's message AT THE SAME TIME, each reply being a real model call
///     wearing that agent's persona, followed by a short consolidation.
///
/// Presentation contract (important):
///   Each reply streams into its bubble LIVE — the first words paint the moment
///   the provider starts answering (repaints throttled, see [_paintInterval]),
///   so a slow provider never looks like dead air. While an agent is working
///   its name also sits in the live typing line ("QA Tester, Bug analyzer and
///   2 others are typing..."). Replies therefore appear in the order their
///   models START, not roster order. Answers are deliberately kept to a couple
///   of short lines.
///
/// Threads are kept in memory for the session and mirrored into
/// [ConversationStore] (with a `channel` marker) so they persist and appear in
/// the Chat tab's saved list. No demo data anywhere: every thread starts empty.
/// ---------------------------------------------------------------------------
class TeamChatStore extends ChangeNotifier {
  TeamChatStore(this._conversations, this._studio);

  final ConversationStore _conversations;
  final StudioStore _studio;

  /// channelKey -> live thread (hydrated from saved conversations on first use).
  final Map<String, List<ChatMessage>> _threads = <String, List<ChatMessage>>{};

  /// channelKey -> agent ids whose answers are still being generated, in the
  /// order they started. Drives the combined "…is typing" line.
  final Map<String, List<String>> _typing = <String, List<String>>{};

  /// channelKey -> what the working agent is doing right now (parsed from the
  /// gateway's tool blocks) — "Searching the web", "Reading a page", … shown in
  /// the typing line Claude-mobile style instead of a bare "is typing".
  final Map<String, String> _activity = <String, String>{};

  final Map<String, AgentTeam> _roomCache = <String, AgentTeam>{};

  /// Bumped by [abortAll]; any task from an older generation drops its result.
  int _generation = 0;

  /// Set once the store is torn down, so a late model reply cannot notify a
  /// disposed ChangeNotifier (that would throw).
  bool _disposed = false;

  /// Hard ceiling on a reply: three short lines, so a room stays readable.
  static const int _maxReplyLines = 3;
  static const int _maxReplyChars = 300;

  /// Coalesce token bursts into at most one UI rebuild per interval — a room
  /// of agents streaming at once must not rebuild the transcript per token.
  static const Duration _paintInterval = Duration(milliseconds: 50);
  Timer? _paintTimer;

  void _throttledNotify() {
    if (_paintTimer != null) return;
    _paintTimer = Timer(_paintInterval, () {
      _paintTimer = null;
      notifyListeners();
    });
  }

  /// Synthetic speaker id for the closing consolidation (not a roster agent).
  static const String _reportId = 'research-report';

  /// Shared brevity instruction appended to every agent's system prompt.
  static const String _brevity =
      'STYLE: answer in at most 3 short lines (under 300 characters). '
      'No headings, no bullet lists, no preamble — just the useful answer.';

  // -- roster lookup ---------------------------------------------------------

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

  bool isStreaming(String channelKey) =>
      _typing[channelKey]?.isNotEmpty ?? false;

  bool get anyStreaming => _typing.values.any((List<String> l) => l.isNotEmpty);

  /// The stacked typing line for a thread, or null when nobody is working:
  ///
  ///   "hello"                              ← the user's message
  ///   "QA Tester, Bug analyzer and 2 others are typing..."
  ///
  /// In a 1-to-1 chat it is simply "Ada is typing...". Names, never ids.
  String? typingLabelFor(String channelKey) {
    final typing = _typing[channelKey];
    if (typing == null || typing.isEmpty) return null;

    final names = <String>[
      for (final id in typing) _displayName(id),
    ];

    final String who;
    if (names.length == 1) {
      who = names.first;
    } else if (names.length == 2) {
      who = '${names[0]} and ${names[1]}';
    } else {
      final others = names.length - 2;
      who = '${names[0]}, ${names[1]} and $others '
          '${others == 1 ? 'other' : 'others'}';
    }
    final activity = _activity[channelKey];
    if (activity != null && activity.isNotEmpty) {
      return activity;
    }
    return '$who ${names.length == 1 ? 'is' : 'are'} typing...';
  }

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
    _markTyping(key, agent.id);
    notifyListeners();

    await _runOne(
      key: key,
      agentId: agent.id,
      system: '${agent.prompt}\n\n$_brevity',
      history: _historyFor(key),
      config: config,
      fallback: _directFallback(agent, text),
    );

    _sync(key);
    notifyListeners();
  }

  // -- rooms -----------------------------------------------------------------

  /// Kick off a room discussion. Every member starts generating at once; each
  /// bubble streams in live as its member's tokens arrive, then a short
  /// "Research Report" note closes the round.
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
      // No roster members — say so plainly instead of faking a discussion.
      thread.add(ChatMessage(
        role: Role.assistant,
        content: 'This room has no agents yet. Add members from the Agents tab.',
        senderName: 'System',
      ));
      notifyListeners();
      return;
    }

    for (final Agent a in members) {
      _markTyping(key, a.id);
    }
    notifyListeners();

    // One snapshot of the conversation to hand to every member: they all
    // answer the same user message in parallel and never block each other.
    final history = _historyFor(key);

    await Future.wait(<Future<void>>[
      for (final Agent a in members)
        _runOne(
          key: key,
          agentId: a.id,
          system: _roomSystem(a, text),
          history: history,
          config: config,
          fallback: _roomFallback(a, text),
        ),
    ]);

    // Closing note: one short consolidation of what the room just said.
    if (thread.isNotEmpty) {
      final transcript = thread
          .map((ChatMessage m) => m.isUser
              ? 'User: ${m.content}'
              : '${m.senderName ?? 'Agent'}: ${m.content}')
          .join('\n');

      await _runOne(
        key: key,
        agentId: _reportId,
        system: 'You are the research room\'s lead. In at most 3 short lines, '
            'tell the user the single best answer from the discussion below '
            'and one concrete next step. No headings. Use the discussion:',
        history: history,
        context: transcript,
        config: config,
        fallback: _reportFallback(text),
        senderName: 'Research Report',
      );
    }

    _sync(key);
    notifyListeners();
  }

  String _roomSystem(Agent agent, String text) {
    return '${agent.prompt}\n\n'
        'You are one member of a research room. The user asked: "$text".\n'
        'The other specialists are answering at the same time — you cannot see '
        'their replies, so give YOUR expert angle, be decisive, and do not pad. '
        '$_brevity';
  }

  // -- one agent, one answer -------------------------------------------------

  /// Generate a single reply, painting tokens into a live bubble as they
  /// arrive. The bubble grows in place and is complete the moment the model
  /// finishes — no waiting for the whole answer before anything shows.
  Future<void> _runOne({
    required String key,
    required String agentId,
    required String system,
    required List<Map<String, String>> history,
    required ByokConfig? config,
    required String fallback,
    String? context,
    String? senderName,
  }) async {
    final int gen = _generation;
    final thread = _threads[key];
    final sender = senderName ?? _displayName(agentId);

    final streamed = StringBuffer();
    ChatMessage? live;

    if (config != null && config.isConfigured && config.models.isNotEmpty) {
      await _collect(
        config: config,
        system: system,
        history: history,
        context: context,
        onDelta: (String delta) {
          if (gen != _generation || thread == null) return;
          // First token: swap the typing line for a live, growing bubble.
          live ??= () {
            final m = ChatMessage(
              role: Role.assistant,
              content: '',
              senderName: sender,
            );
            thread.add(m);
            return m;
          }();
          streamed.write(delta);
          live!.content = _short(streamed.toString());
          _throttledNotify();
        },
      );
    }

    // Aborted or superseded while the model was working: leave whatever already
    // painted and let whoever owns the newer generation run the typing line.
    if (gen != _generation) return;

    final answer = streamed.toString().trim();
    final done = live;
    if (done == null) {
      // No tokens arrived (offline, unconfigured, or an empty upstream reply):
      // append the fallback as one whole message.
      thread?.add(ChatMessage(
        role: Role.assistant,
        content: _short(answer.isEmpty ? fallback : answer),
        senderName: sender,
      ));
    } else {
      done.content = _short(answer.isEmpty ? fallback : answer);
    }

    _activity.remove('$key:$agentId');
    _unmarkTyping(key, agentId);
    notifyListeners();
  }

  /// Friendly labels for the gateway's server-side tools, shown Claude-style
  /// while the agent works ("Myto is searching the web…").
  static String _toolLabel(String tool) {
    switch (tool) {
      case 'web_search':
        return 'Searching the web';
      case 'web_fetch':
        return 'Reading a page';
      case 'wiki_search':
        return 'Checking Wikipedia';
      default:
        return 'Working';
    }
  }

  static final RegExp _toolBlockRe = RegExp(
    '```myto:tool\s*\n(\{[^`]*?\})\s*\n?```',
    multiLine: true,
  );
  static final RegExp _urlRe = RegExp(r'https://[^\s`"<>]+');

  /// Drive one model call, forwarding visible tokens to [onDelta] and tool
  /// activity to [onActivity]. Tool blocks ride the text protocol from the
  /// gateway (web_search / web_fetch / wiki_search); we hold their raw fences
  /// OUT of the reply so the bubble stays clean, and collect the result URLs as
  /// sources for the citation chips.
  Future<void> _collect({
    required ByokConfig config,
    required String system,
    required List<Map<String, String>> history,
    String? context,
    required void Function(String delta) onDelta,
    void Function(String label)? onActivity,
    void Function(List<String> sources)? onSources,
  }) async {
    final client = ChatClient();

    final messages = <Map<String, String>>[
      <String, String>{'role': 'system', 'content': system},
      ...history,
      if (context != null && context.isNotEmpty)
        <String, String>{'role': 'user', 'content': context},
    ];

    final modelId = config.models.isNotEmpty ? config.models.first.id : '';

    // The gateway runs the server-side tool loop (web_search / web_fetch /
    // wiki_search) and streams the blocks as fenced text. We hide the fences
    // from the visible bubble, announce each tool as a Claude-style activity,
    // and harvest the result URLs as citation sources.
    final raw = StringBuffer();
    final seenTools = <String>{};
    final sources = <String>[];
    var carry = '';
    var inBlock = false;

    void pushVisible(String piece) {
      carry += piece;
      for (;;) {
        if (inBlock) {
          final close = carry.indexOf('```');
          if (close >= 0) {
            // Harvest result URLs before dropping the block.
            for (final m in _urlRe.allMatches(carry)) {
              final g = m.group(0);
              final host = (g == null ? '' : Uri.tryParse(g)?.host) ?? '';
              if (host.isNotEmpty && !sources.contains(host) && sources.length < 3) {
                sources.add(host);
              }
            }
            carry = carry.substring(close + 3);
            inBlock = false;
            continue;
          }
          // Hold the tail that could be a partial closing fence.
          final keep = carry.length < 3 ? carry.length : 3;
          final emitLen = carry.length - keep;
          if (emitLen > 0) {
            onDelta(carry.substring(0, emitLen));
            carry = carry.substring(emitLen);
          }
          return;
        }
        final open = carry.indexOf('```myto:');
        if (open >= 0) {
          if (open > 0) onDelta(carry.substring(0, open));
          carry = carry.substring(open);
          inBlock = true;
          continue;
        }
        // No fence: emit everything except a possible partial fence prefix.
        const maxHold = 9;
        if (carry.length > maxHold) {
          final emitLen = carry.length - maxHold;
          onDelta(carry.substring(0, emitLen));
          carry = carry.substring(emitLen);
        }
        return;
      }
    }

    try {
      outer:
      await for (final ChatEvent event in client.send(
        model: modelId,
        messages: messages,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        authSchema: config.authSchema,
        authHeaderName: config.authHeaderName,
        reasoningEffort: 'low',
      )) {
        switch (event) {
          case ChatToken(:final String text):
            raw.write(text);
            // Announce tools as soon as their name streams in.
            if (inBlock) {
              final m = RegExp('"tool"\s*:\s*"([a-z_]+)"').firstMatch(carry + text.length.toString());
            }
            pushVisible(text);
            for (final match in _toolBlockRe.allMatches(raw.toString())) {
              final body = match.group(1);
              if (body == null) continue;
              try {
                final parsed = jsonDecode(body) as Map<String, dynamic>;
                final tool = (parsed['tool'] ?? '') as String;
                if (tool.isNotEmpty && seenTools.add(tool)) {
                  onActivity?.call(_toolLabel(tool));
                }
              } catch (_) {}
            }
          case ChatDone():
            break outer;
          case ChatFailure():
            break outer;
        }
      }
    } catch (_) {
      // Network hiccup mid-stream: keep whatever already arrived.
    } finally {
      client.abort();
    }

    // Flush the hold-back buffer (a partial fence at the very end is dropped).
    if (carry.isNotEmpty && !inBlock) {
      onDelta(carry);
    }
    if (sources.isNotEmpty) {
      onSources?.call(sources);
    }
  }

  /// Trim a reply to the room's brevity budget: at most three non-empty lines
  /// and [_maxReplyChars] characters, with an ellipsis when something was cut.
  String _short(String raw) {
    final lines = raw
        .split('\n')
        .map((String l) => l.trimRight())
        .where((String l) => l.trim().isNotEmpty)
        .toList();
    var out = lines.take(_maxReplyLines).join('\n').trim();
    if (lines.length > _maxReplyLines) out = '$out…';
    if (out.length > _maxReplyChars) {
      out = '${out.substring(0, _maxReplyChars - 1).trimRight()}…';
    }
    return out;
  }

  /// Build the model history from the live thread (the user's message is
  /// already in it; the reply being generated is not).
  List<Map<String, String>> _historyFor(String key) {
    final thread = _threads[key] ?? <ChatMessage>[];
    return <Map<String, String>>[
      for (final ChatMessage m in thread)
        if (m.content.trim().isNotEmpty)
          <String, String>{
            'role': m.isUser ? 'user' : 'assistant',
            'content': m.senderName == null
                ? m.content
                : '[${m.senderName}] ${m.content}',
          },
    ];
  }

  // -- typing bookkeeping ----------------------------------------------------

  /// Human name for a speaker id — the report writer is not a roster agent.
  String _displayName(String agentId) {
    if (agentId == _reportId) return 'Research Report';
    return agentById(agentId)?.name ?? agentId;
  }

  void _markTyping(String key, String agentId) {
    final list = _typing[key] ??= <String>[];
    if (!list.contains(agentId)) list.add(agentId);
  }

  void _unmarkTyping(String key, String agentId) {
    final list = _typing[key];
    if (list == null) return;
    list.remove(agentId);
    if (list.isEmpty) _typing.remove(key);
  }

  // -- fallbacks (offline / unconfigured) ------------------------------------

  String _directFallback(Agent agent, String text) {
    final short = _clip(text);
    return '${agent.name} here — ${agent.description}. '
        'On “$short”: connect a model at mytocode.vercel.app/authentication '
        'and I will answer with my full expertise.';
  }

  String _roomFallback(Agent agent, String text) {
    final short = _clip(text);
    return 'Taking “$short” from my side: my angle is ${agent.category}. '
        'Connect a model and I will research it properly.';
  }

  String _reportFallback(String text) {
    final short = _clip(text);
    return 'Best next step on “$short”: connect a model at '
        'mytocode.vercel.app/authentication, then re-ask the room.';
  }

  String _clip(String text) {
    final t = text.trim().replaceAll('\n', ' ');
    return t.length > 90 ? '${t.substring(0, 90)}…' : t;
  }

  // -- persistence -----------------------------------------------------------

  /// Mirror a live thread into the saved conversation list so it survives a
  /// restart and shows in the Chat tab under its channel marker.
  void _sync(String channelKey) {
    final thread = _threads[channelKey];
    if (thread == null || thread.isEmpty) return;
    final id = idFromKey(channelKey);
    final isRoom = channelKey.startsWith('room:');
    final String title =
        isRoom ? (roomById(id)?.name ?? 'Room') : (agentById(id)?.name ?? 'Agent chat');

    Conversation? existing;
    for (final Conversation c in _conversations.conversations) {
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
    _typing.clear();
    notifyListeners();
  }

  /// A late model reply can land after the screen (and this store) is gone;
  /// ChangeNotifier throws if you notify after dispose, so swallow it.
  @override
  void notifyListeners() {
    if (_disposed) return;
    super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _paintTimer?.cancel();
    _typing.clear();
    super.dispose();
  }
}
