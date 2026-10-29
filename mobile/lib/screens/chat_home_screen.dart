import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../models/chat.dart';
import '../services/conversation_store.dart';
import '../services/dm_service.dart';
import '../services/social_service.dart';
import '../services/studio_store.dart';
import '../services/team_chat_store.dart';
import '../theme.dart';
import '../widgets/agent_avatar.dart';
import '../widgets/teamly/kit.dart';
import 'dm_chat_screen.dart';
import 'myto_chat_screen.dart';
import 'profile_screen.dart';
import 'team_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// ChatHomeScreen — the app's LANDING tab, rebuilt messenger-style:
///
///   user avatar + name (→ profile) · search pill
///   flat 1-by-1 rows, no cards or borders — AGENTS (the ten-chat roster),
///   GROUPS (the user's created agent groups), CHATS (saved conversations)
///   and MESSAGES (community DMs).
///
/// Every row opens as a pushed route, so the bottom nav disappears inside a
/// conversation.
/// ---------------------------------------------------------------------------
class ChatHomeScreen extends StatefulWidget {
  const ChatHomeScreen({super.key});

  @override
  State<ChatHomeScreen> createState() => _ChatHomeScreenState();
}

class _ChatHomeScreenState extends State<ChatHomeScreen> {
  String _query = '';
  final Map<String, DiscoverProfile?> _dmProfiles = <String, DiscoverProfile?>{};
  // Community people + post hits under the chat matches, debounced one-shots.
  Timer? _searchDebounce;
  List<DiscoverProfile>? _people;
  List<FeedPost>? _postHits;

  String get _me => FirebaseAuth.instance.currentUser?.uid ?? '';

  void _onSearch(String v) {
    setState(() => _query = v);
    _searchDebounce?.cancel();
    final q = v.trim().toLowerCase();
    if (q.length < 2) {
      _people = null;
      _postHits = null;
      return;
    }
    _searchDebounce = Timer(const Duration(milliseconds: 450), () async {
      try {
        final profiles = await SocialService.fetchProfileSample();
        final posts = await SocialService.fetchRecentPosts();
        if (!mounted) return;
        setState(() {
          _people = profiles
              .where((p) => p.name.toLowerCase().contains(q) || p.username.contains(q))
              .take(8)
              .toList();
          _postHits = posts.where((p) => p.text.toLowerCase().contains(q)).take(8).toList();
        });
      } catch (_) {
        // Search stays chat-local when Firestore is unreachable.
      }
    });
  }

  Future<void> _startChatWith(String uid, String name, String photo) async {
    if (uid.isEmpty || uid == _me) return;
    await DmService.ensureThread(_me, uid);
    if (!mounted) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DmChatScreen(otherUid: uid, otherName: name, otherPhoto: photo),
      ),
    );
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

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
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => MytoChatScreen(conversationId: c.id)),
      );
      return;
    }
    final id = TeamChatStore.idFromKey(channel);
    final room = channel.startsWith('room:') ? _roomById(id) : null;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.resume(
          channel,
          resumeTitle: c.title,
          room: room,
          agent: room == null ? agentById(id) : null,
        ),
      ),
    );
  }

  void _openProfile() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const ProfileScreen()),
    );
  }

  AgentTeam? _roomById(String id) {
    return context.read<StudioStore>().teamById(id);
  }

  void _openDm(DmThread thread) {
    final other = thread.otherUid(_me);
    final p = _dmProfiles[other];
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DmChatScreen(
          otherUid: other,
          otherName: p?.name ?? 'Myto user',
          otherPhoto: p?.photo ?? '',
        ),
      ),
    );
  }

  Future<void> _loadDmProfile(String uid) async {
    if (_dmProfiles.containsKey(uid) || uid.isEmpty) return;
    _dmProfiles[uid] = null;
    final p = await SocialService().getProfile(uid);
    if (!mounted) return;
    setState(() => _dmProfiles[uid] = p);
  }

  // ── Build ───────────────────────────────────────────────────────────────────

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
    final studio = context.watch<StudioStore>();
    final conversations = context.watch<ConversationStore>().conversations;
    final user = FirebaseAuth.instance.currentUser;
    final userName = (user?.displayName ?? '').trim();

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
      backgroundColor: context.palette.bg,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: <Widget>[
            // ── Header: the user's picture + name — that's all ─────────────
            Padding(
              padding: const EdgeInsets.fromLTRB(
                TeamlySpace.gutter, TeamlySpace.s3, TeamlySpace.gutter, 0,
              ),
              child: GestureDetector(
                onTap: _openProfile,
                behavior: HitTestBehavior.opaque,
                child: Row(
                  children: <Widget>[
                    _UserAvatar(photo: user?.photoURL ?? '', name: user?.displayName ?? 'You'),
                    const SizedBox(width: TeamlySpace.s3),
                    Expanded(
                      child: Text(
                        userName.isEmpty ? 'You' : userName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: TeamlyColors.ink900,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: TeamlySpace.s4),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
              child: TeamlySearch(
                hint: 'Search',
                onChanged: _onSearch,
              ),
            ),
            const SizedBox(height: TeamlySpace.s2),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(top: 4, bottom: TeamlySpace.s6),
                children: <Widget>[
                  // ── Agents — the ten-chat roster, messenger rows ─────────
                  if (agents.isNotEmpty)
                    for (final a in agents)
                      _chatRow(
                        avatar: AgentAvatar(artId: a.artId, size: 46),
                        title: a.name,
                        subtitle: a.description,
                        onTap: () => _openAgent(a),
                      ),
                  // ── Groups — the user's created agent groups ─────────────
                  if (rooms.isNotEmpty) ...<Widget>[
                    for (final r in rooms) _groupRow(r, studio),
                  ],
                  // ── Saved conversations ──────────────────────────────────
                  for (final c in saved) _conversationRow(c),
                  // ── Community DMs ────────────────────────────────────────
                  if (_me.isNotEmpty)
                    StreamBuilder<List<DmThread>>(
                      stream: DmService.streamThreads(_me),
                      builder: (context, snap) {
                        final threads = (snap.data ?? const <DmThread>[])
                            .where((t) => q.isEmpty)
                            .toList(growable: false);
                        return Column(
                          children: <Widget>[
                            for (final t in threads) _dmRow(t),
                          ],
                        );
                      },
                    ),
                  // ── Community people (search hits) ────────────────────────
                  if (_people != null)
                    for (final p in _people!)
                      _chatRow(
                        avatar: _UserAvatar(photo: p.photo, name: p.name, size: 46),
                        title: p.name,
                        subtitle: p.username.isEmpty ? 'On Myto' : '@${p.username}',
                        onTap: () => _startChatWith(p.uid, p.name, p.photo),
                      ),
                  // ── Community post hits ──────────────────────────────────
                  if (_postHits != null && _postHits!.isNotEmpty)
                    for (final post in _postHits!)
                      _chatRow(
                        avatar: _UserAvatar(photo: '', name: post.name, size: 46),
                        title: post.name,
                        subtitle: post.text,
                        onTap: () {},
                      ),
                  if (agents.isEmpty &&
                      rooms.isEmpty &&
                      saved.isEmpty &&
                      (_people == null || _people!.isEmpty))
                    Padding(
                      padding: const EdgeInsets.all(TeamlySpace.s8),
                      child: Text(
                        _query.trim().isEmpty
                            ? 'Pick an agent to start chatting.'
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
      ),
    );
  }

  // ── Rows — flat, messenger-style: avatar · gap · text. No boxes. ────────────

  Widget _chatRow({
    required Widget avatar,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
    String? trailing,
  }) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 8),
        child: Row(
          children: <Widget>[
            avatar,
            const SizedBox(width: 12),
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
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (subtitle.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                    ),
                  ],
                ],
              ),
            ),
            if (trailing != null)
              Text(
                trailing,
                style: const TextStyle(color: TeamlyColors.ink300, fontSize: 11),
              ),
          ],
        ),
      ),
    );
  }

  Widget _groupRow(AgentTeam room, StudioStore studio) {
    final members = <Agent>[
      for (final id in room.agentIds)
        if (agentById(id) != null) agentById(id)!,
    ];
    final art = room.avatarArt((id) => agentById(id)?.artId ?? '');
    return _chatRow(
      avatar: AgentAvatar(artId: art, size: 46),
      title: room.name,
      subtitle: room.subtitle,
      onTap: () => _openRoom(room),
      trailing: members.isEmpty ? null : '${members.length}',
    );
  }

  Widget _conversationRow(Conversation c) {
    final channelAvatar = c.channel == null
        ? const AgentAvatar(artId: 'asset:agent-08', size: 46)
        : c.channel!.startsWith('room:')
            ? const AgentAvatar(artId: 'asset:agent-09', size: 46)
            : AgentAvatar(
                artId: agentById(TeamChatStore.idFromKey(c.channel!))?.artId ?? 'asset:agent-01',
                size: 46,
              );
    return _chatRow(
      avatar: channelAvatar,
      title: c.title,
      subtitle: c.messages.isEmpty
          ? 'New chat'
          : c.messages.last.content.replaceAll(RegExp(r'\s+'), ' '),
      onTap: () => _openSaved(c),
      trailing: _timeLabel(c.updatedAt),
    );
  }

  Widget _dmRow(DmThread thread) {
    final other = thread.otherUid(_me);
    if (other.isNotEmpty) _loadDmProfile(other);
    final p = _dmProfiles[other];
    return _chatRow(
      avatar: _UserAvatar(photo: p?.photo ?? '', name: p?.name ?? '?', size: 46),
      title: p?.name ?? 'Myto user',
      subtitle: 'Open conversation',
      onTap: () => _openDm(thread),
    );
  }
}

/// A circular avatar for a real user: photo when present, initial otherwise.
class _UserAvatar extends StatelessWidget {
  const _UserAvatar({required this.photo, required this.name, this.size = 40});

  final String photo;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (photo.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(size),
        child: Image.network(
          photo,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initial(context),
        ),
      );
    }
    return _initial(context);
  }

  Widget _initial(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: context.palette.pastel(1),
        shape: BoxShape.circle,
      ),
      child: Text(
        name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase(),
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: TeamlyColors.ink800),
      ),
    );
  }
}
