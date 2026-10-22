import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../models/chat.dart';
import '../services/byok_service.dart';
import '../services/team_chat_store.dart';
import '../theme.dart';
import '../widgets/agent_avatar.dart';
import '../widgets/team_composer.dart';
import '../widgets/teamly/kit.dart';

/// ---------------------------------------------------------------------------
/// TeamChatScreen — one full-screen chat, used for BOTH chat surfaces:
///
///   • 1-to-1  — `TeamChatScreen.direct(agent)` — user + one specialist.
///   • Room    — `TeamChatScreen.room(team)` — every member takes a turn after
///     the user speaks, then a Research Report bubble closes the discussion.
///
/// It is pushed as a route, so the bottom nav (Chat · Agents · Discover · ...)
/// is hidden while the conversation is open. The transcript sits on the faint
/// hand-drawn doodle wall; each agent's reply wears their generated vector
/// avatar and a sender label; the composer is borderless (no green focus ring).
/// ---------------------------------------------------------------------------
class TeamChatScreen extends StatefulWidget {
  TeamChatScreen.direct({super.key, required this.agent, this.resumeTitle})
      : room = null,
        channelKey = TeamChatStore.directKey(agent.id);

  TeamChatScreen.room({super.key, required this.room, this.resumeTitle})
      : agent = null,
        channelKey = TeamChatStore.roomKey(room.id);

  /// Resume an existing thread by its channel key (from the saved chats list).
  TeamChatScreen.resume(this.channelKey, {this.resumeTitle, this.room, this.agent});

  final Agent? agent;
  final AgentTeam? room;
  final String channelKey;
  final String? resumeTitle;

  bool get isRoom => channelKey.startsWith('room:');

  @override
  State<TeamChatScreen> createState() => _TeamChatScreenState();
}

class _TeamChatScreenState extends State<TeamChatScreen> {
  final ScrollController _scroll = ScrollController();

  String get _title {
    if (widget.resumeTitle != null) return widget.resumeTitle!;
    if (widget.isRoom) return widget.room?.name ?? 'Room';
    return widget.agent?.name ?? 'Agent';
  }

  String get _subtitle {
    if (widget.isRoom) {
      final room = widget.room;
      if (room == null) return 'Research room';
      if (room.memberCount > 0) return '${room.memberCount} specialists';
      return room.subtitle;
    }
    return widget.agent?.category ?? 'Specialist';
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 240),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _send(String text) async {
    final store = context.read<TeamChatStore>();
    final config = context.read<ByokService>().config;
    final id = TeamChatStore.idFromKey(widget.channelKey);
    if (widget.isRoom) {
      final room = widget.room ?? store.roomById(id);
      if (room == null) return;
      await store.sendToRoom(room: room, text: text, config: config);
    } else {
      final agent = widget.agent ?? agentById(id);
      if (agent == null) return;
      await store.sendDirect(agent: agent, text: text, config: config);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final store = context.watch<TeamChatStore>();
    final messages = store.messagesFor(widget.channelKey);
    final streaming = store.isStreaming(widget.channelKey);

    if (streaming) _scrollToBottom();

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          tooltip: 'Back',
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        titleSpacing: 0,
        title: Row(
          children: <Widget>[
            if (widget.isRoom)
              _RoomAvatarStack(room: widget.room)
            else
              AgentAvatar(
                emblem: emblemForGlyph(widget.agent?.glyph ?? 'spark'),
                pastelIndex: widget.agent?.pastelIndex ?? 0,
                size: 36,
              ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    _title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    store.roomSpeaker != null
                        ? '${agentById(store.roomSpeaker!)?.name ?? 'Agent'} is typing...'
                        : _subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: palette.muted, fontSize: 12.5),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      body: Stack(
        children: <Widget>[
          // The faint hand-drawn doodle wall behind the whole transcript.
          const DoodleBackground(opacity: 0.05),
          Column(
            children: <Widget>[
              Expanded(
                child: messages.isEmpty
                    ? _EmptyThread(
                        isRoom: widget.isRoom,
                        agent: widget.agent,
                        room: widget.room,
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                        itemCount: messages.length,
                        itemBuilder: (context, i) =>
                            _bubble(context, messages[i], store),
                      ),
              ),
              TeamComposer(
                onSend: _send,
                hint: widget.isRoom
                    ? 'Ask the room...'
                    : 'Message ${widget.agent?.name ?? 'agent'}...',
                disabled: streaming,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _bubble(BuildContext context, ChatMessage m, TeamChatStore store) {
    if (m.isUser) return _userBubble(context, m);
    if (m.senderName == 'Research Report') return _reportBubble(context, m);
    final agent = m.senderName == null ? null : _agentBySenderName(m.senderName!);
    return _agentBubble(context, m, agent);
  }

  Agent? _agentBySenderName(String name) {
    for (final Agent a in kSeedAgents) {
      if (a.name == name) return a;
    }
    return null;
  }

  Widget _userBubble(BuildContext context, ChatMessage m) {
    final palette = Theme.of(context).palette;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(left: 56, top: 5, bottom: 5),
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 10),
        decoration: BoxDecoration(
          color: palette.accent.withValues(alpha: 0.14),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(18),
            topRight: Radius.circular(18),
            bottomLeft: Radius.circular(18),
            bottomRight: Radius.circular(6),
          ),
        ),
        child: SelectableText(
          m.content,
          style: TextStyle(color: palette.text, fontSize: 15, height: 1.45),
        ),
      ),
    );
  }

  Widget _agentBubble(BuildContext context, ChatMessage m, Agent? agent) {
    final palette = Theme.of(context).palette;
    final empty = m.content.trim().isEmpty;
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 2, right: 10),
            child: AgentAvatar(
              emblem: emblemForGlyph(agent?.glyph ?? 'spark'),
              pastelIndex: agent?.pastelIndex ?? 0,
              size: 32,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (m.senderName != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 4, bottom: 3),
                    child: Text(
                      m.senderName!,
                      style: const TextStyle(
                        color: TeamlyColors.greenText,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: palette.surface,
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(6),
                      topRight: Radius.circular(18),
                      bottomLeft: Radius.circular(18),
                      bottomRight: Radius.circular(18),
                    ),
                    boxShadow: TeamlyElevation.e1,
                  ),
                  child: empty
                      ? const _TypingDots()
                      : MarkdownBody(
                          data: m.content,
                          selectable: true,
                          styleSheet: _markdownStyle(palette),
                        ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _reportBubble(BuildContext context, ChatMessage m) {
    final palette = Theme.of(context).palette;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: palette.tagBg,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: palette.tagFg.withValues(alpha: 0.35)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.description_rounded, size: 18, color: palette.tagFg),
                const SizedBox(width: 8),
                const Text(
                  'RESEARCH REPORT',
                  style: TextStyle(
                    color: TeamlyColors.greenText,
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            m.content.trim().isEmpty
                ? const _TypingDots()
                : MarkdownBody(
                    data: m.content,
                    selectable: true,
                    styleSheet: _markdownStyle(palette),
                  ),
          ],
        ),
      ),
    );
  }

  MarkdownStyleSheet _markdownStyle(MytoPalette palette) {
    final base = TextStyle(color: palette.text, fontSize: 15, height: 1.5);
    return MarkdownStyleSheet(
      p: base,
      a: TextStyle(color: palette.accentText, decoration: TextDecoration.underline),
      code: TextStyle(
        fontFamily: 'monospace',
        backgroundColor: palette.surface2,
        color: palette.text,
        fontSize: 13.5,
      ),
      codeblockDecoration: BoxDecoration(
        color: palette.surface2,
        borderRadius: BorderRadius.circular(10),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      h1: base.copyWith(fontSize: 21, fontWeight: FontWeight.w700),
      h2: base.copyWith(fontSize: 18, fontWeight: FontWeight.w700),
      h3: base.copyWith(fontSize: 16, fontWeight: FontWeight.w700),
      listBullet: base,
      strong: base.copyWith(fontWeight: FontWeight.w700),
      em: base.copyWith(fontStyle: FontStyle.italic),
    );
  }
}

/// Three small pulsing dots while an agent's reply is being generated.
class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (int i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.only(right: 5),
                child: Opacity(
                  opacity:
                      0.3 + 0.7 * ((_controller.value + i * 0.2) % 1.0).clamp(0.0, 1.0),
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: palette.muted,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// The stacked avatar row in a room's app bar.
class _RoomAvatarStack extends StatelessWidget {
  const _RoomAvatarStack({required this.room});

  final AgentTeam? room;

  @override
  Widget build(BuildContext context) {
    final members = <Agent>[
      for (final id in (room?.agentIds ?? const <String>[]))
        if (agentById(id) != null) agentById(id)!,
    ];
    final shown = members.take(3).toList();
    if (shown.isEmpty) {
      return const AgentAvatar(emblem: 10, pastelIndex: 0, size: 36);
    }
    return SizedBox(
      width: 64,
      height: 36,
      child: Stack(
        children: <Widget>[
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * 16.0,
              top: 0,
              child: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: Theme.of(context).scaffoldBackgroundColor,
                    width: 2,
                  ),
                ),
                child: AgentAvatar(
                  emblem: emblemForGlyph(shown[i].glyph),
                  pastelIndex: shown[i].pastelIndex,
                  size: 32,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Shown before the first message: who you're talking to, with zero demo data.
class _EmptyThread extends StatelessWidget {
  const _EmptyThread({required this.isRoom, this.agent, this.room});

  final bool isRoom;
  final Agent? agent;
  final AgentTeam? room;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final members = <Agent>[
      for (final id in (room?.agentIds ?? const <String>[]))
        if (agentById(id) != null) agentById(id)!,
    ];
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (isRoom)
              _RoomAvatarStack(room: room)
            else
              AgentAvatar(
                emblem: emblemForGlyph(agent?.glyph ?? 'spark'),
                pastelIndex: agent?.pastelIndex ?? 0,
                size: 64,
              ),
            const SizedBox(height: 16),
            Text(
              isRoom ? (room?.name ?? 'Room') : (agent?.name ?? 'Agent'),
              textAlign: TextAlign.center,
              style: TextStyle(
                color: palette.text,
                fontSize: 18,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              isRoom
                  ? '${members.length} specialists will research your question together and hand you a report.'
                  : (agent?.description ?? ''),
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.muted, fontSize: 14, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}
