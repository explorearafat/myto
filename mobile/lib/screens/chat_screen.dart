import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../models/chat.dart';
import '../services/conversation_store.dart';
import '../services/studio_store.dart';
import '../services/team_chat_store.dart';
import '../theme.dart';
import '../widgets/agent_avatar.dart';
import '../widgets/teamly/kit.dart';
import 'myto_chat_screen.dart';
import 'team_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// ChatScreen — the Chat tab list. Three groups, no demo data:
///
///   AGENTS    — the 1-to-1 roster (QA Tester, Doctor, Bug Analyzer, ...).
///               Tapping one opens a full-screen chat with that specialist.
///   ROOMS     — the research rooms from the Agents tab. Tapping one opens the
///               group discussion (every member replies, then a report).
///   CHATS     — your saved conversations, including past agent/room threads
///               (reopened by their channel marker) and plain Myto chats.
///
/// Every thread opens as a pushed route, so the bottom nav (Chat · Agents ·
/// Discover · ...) disappears while a conversation is open.
/// ---------------------------------------------------------------------------
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  String _query = '';

  void _openAgent(Agent agent) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.direct(agent: agent, resumeTitle: agent.name),
      ),
    );
  }

  void _openRoom(AgentTeam room) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.room(room: room, resumeTitle: room.name),
      ),
    );
  }

  void _openSaved(Conversation c) {
    final channel = c.channel;
    if (channel == null) {
      // Plain Myto chat.
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MytoChatScreen(conversationId: c.id),
        ),
      );
      return;
    }
    final id = TeamChatStore.idFromKey(channel);
    if (channel.startsWith('room:')) {
      final room = _roomById(id);
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TeamChatScreen.resume(
            channel,
            resumeTitle: c.title,
            room: room,
          ),
        ),
      );
    } else {
      final agent = agentById(id);
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TeamChatScreen.resume(
            channel,
            resumeTitle: c.title,
            agent: agent,
          ),
        ),
      );
    }
  }

  AgentTeam? _roomById(String id) {
    for (final t in kSeedTeams) {
      if (t.id == id) return t;
    }
    return context.read<StudioStore>().teamById(id);
  }

  void _newMytoChat() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const MytoChatScreen()),
    );
  }

  String _timeLabel(DateTime at) {
    final now = DateTime.now();
    if (now.difference(at).inMinutes < 1) return 'now';
    if (now.difference(at).inMinutes < 60) return '${now.difference(at).inMinutes}m';
    if (at.day == now.day && at.month == now.month) {
      final h = at.hour % 12 == 0 ? 12 : at.hour % 12;
      return '$h:${at.minute.toString().padLeft(2, '0')}';
    }
    return '${at.day}/${at.month}';
  }

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).palette;
    final studio = context.watch<StudioStore>();
    final conversations = context.watch<ConversationStore>().conversations;

    final q = _query.trim().toLowerCase();
    final rooms = studio.teams
        .where((t) => q.isEmpty || t.name.toLowerCase().contains(q))
        .toList(growable: false);
    final agents = kSeedAgents
        .where((a) => q.isEmpty || a.name.toLowerCase().contains(q))
        .toList(growable: false);
    final saved = conversations
        .where((c) => q.isEmpty || c.title.toLowerCase().contains(q))
        .toList(growable: false);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Chats'),
        actions: <Widget>[
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(child: TeamlyFab(icon: Icons.add_rounded, onPressed: _newMytoChat)),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: TeamlySearch(
              hint: 'Search chats, agents, rooms...',
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.only(bottom: TeamlySpace.s6),
              children: <Widget>[
                // ── Myto 1-to-1 assistant ──────────────────────────────────
                _row(
                  context,
                  avatar: const AgentAvatar(emblem: 10, pastelIndex: 0, size: 44),
                  title: 'Myto',
                  subtitle: 'The assistant — coding, research, writing',
                  onTap: _newMytoChat,
                ),
                // ── Agents 1-to-1 roster ───────────────────────────────────
                if (agents.isNotEmpty) ...<Widget>[
                  const TeamlyGroupHeader(label: 'Agents'),
                  for (final a in agents)
                    _row(
                      context,
                      avatar: AgentAvatar(
                        emblem: emblemForGlyph(a.glyph),
                        pastelIndex: a.pastelIndex,
                        size: 44,
                      ),
                      title: a.name,
                      subtitle: a.description,
                      onTap: () => _openAgent(a),
                    ),
                ],
                // ── Rooms ──────────────────────────────────────────────────
                if (rooms.isNotEmpty) ...<Widget>[
                  TeamlyGroupHeader(
                    label: 'Rooms',
                    count: rooms.length,
                    onToggle: () {},
                  ),
                  for (final r in rooms) _roomRow(context, r, studio),
                ],
                // ── Saved conversations ────────────────────────────────────
                if (saved.isNotEmpty) ...<Widget>[
                  TeamlyGroupHeader(
                    label: 'Chats',
                    count: saved.length,
                    onToggle: () {},
                  ),
                  for (final c in saved) _conversationRow(context, c),
                ],
                if (agents.isEmpty && rooms.isEmpty && saved.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(TeamlySpace.s8),
                    child: Text(
                      _query.trim().isEmpty
                          ? 'No chats yet. Pick an agent or a room, or tap + for the assistant.'
                          : 'Nothing matches “$_query”.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: TeamlyColors.ink300, fontSize: 14, height: 1.5),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(
    BuildContext context, {
    required Widget avatar,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
      child: TeamlyCard(
        onTap: onTap,
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            avatar,
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    title,
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
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, size: 20, color: TeamlyColors.ink300),
          ],
        ),
      ),
    );
  }

  Widget _roomRow(BuildContext context, AgentTeam room, StudioStore studio) {
    final members = <Agent>[
      for (final id in room.agentIds)
        if (agentById(id) != null) agentById(id)!,
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
      child: TeamlyCard(
        onTap: () => _openRoom(room),
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            SizedBox(
              width: 64,
              height: 44,
              child: Stack(
                children: <Widget>[
                  for (var i = 0; i < members.take(3).length; i++)
                    Positioned(
                      left: i * 16.0,
                      child: AgentAvatar(
                        emblem: emblemForGlyph(members[i].glyph),
                        pastelIndex: members[i].pastelIndex,
                        size: 40,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    room.name,
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
                    room.subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, size: 20, color: TeamlyColors.ink300),
          ],
        ),
      ),
    );
  }

  Widget _conversationRow(BuildContext context, Conversation c) {
    final channelAvatar = c.channel == null
        ? const AgentAvatar(emblem: 10, pastelIndex: 1, size: 40)
        : c.channel!.startsWith('room:')
            ? const AgentAvatar(emblem: 7, pastelIndex: 2, size: 40)
            : AgentAvatar(
                emblem: emblemForGlyph(
                  agentById(TeamChatStore.idFromKey(c.channel!))?.glyph ?? 'spark',
                ),
                pastelIndex:
                    agentById(TeamChatStore.idFromKey(c.channel!))?.pastelIndex ?? 0,
                size: 40,
              );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
      child: TeamlyCard(
        onTap: () => _openSaved(c),
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            channelAvatar,
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
}