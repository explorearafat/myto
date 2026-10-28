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
import 'post_composer_page.dart';
import 'profile_screen.dart';
import 'team_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// ChatHomeScreen — the app's LANDING tab, styled on the Teamly reference:
/// avatar · Myto AI · green + header, the search pill, the Myto assistant row,
/// then grouped card lists — AGENTS (the 1-to-1 roster), ROOMS (research
/// groups), CHATS (saved conversations) and MESSAGES (community DMs — merged
/// here from the old Messages tab so everything conversation-shaped lives in
/// one list). Every row opens as a pushed route, so the bottom nav disappears
/// inside a conversation.
/// ---------------------------------------------------------------------------
class ChatHomeScreen extends StatefulWidget {
  const ChatHomeScreen({super.key, this.onCompose});

  /// The header's green + — opens the Discover post composer.
  final VoidCallback? onCompose;

  @override
  State<ChatHomeScreen> createState() => _ChatHomeScreenState();
}

class _ChatHomeScreenState extends State<ChatHomeScreen> {
  String _query = '';
  final Map<String, DiscoverProfile?> _dmProfiles = <String, DiscoverProfile?>{};
  // The old Search tab's job, merged in: community people + post hits under
  // the chat matches, debounced one-shots.
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

  void _openMytoChat() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const MytoChatScreen()),
    );
  }

  void _openProfile() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const ProfileScreen()),
    );
  }

  AgentTeam? _roomById(String id) {
    for (final t in kSeedTeams) {
      if (t.id == id) return t;
    }
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
            // ── Header: avatar · Myto AI · green + ────────────────────────
            Padding(
              padding: const EdgeInsets.fromLTRB(
                TeamlySpace.gutter, TeamlySpace.s3, TeamlySpace.gutter, 0,
              ),
              child: Row(
                children: <Widget>[
                  GestureDetector(
                    onTap: _openProfile,
                    child: _UserAvatar(photo: user?.photoURL ?? '', name: user?.displayName ?? 'You'),
                  ),
                  const Spacer(),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const AgentAvatar(artId: 'myto', size: 30),
                      const SizedBox(width: TeamlySpace.s2),
                      const Text(
                        'Myto AI',
                        style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: TeamlyColors.ink900),
                      ),
                    ],
                  ),
                  const Spacer(),
                  TeamlyFab(icon: Icons.add_rounded, onPressed: widget.onCompose ?? _compose),
                ],
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
            const SizedBox(height: TeamlySpace.s3),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(bottom: TeamlySpace.s6),
                children: <Widget>[
                  // ── The assistant — the always-on companion row ──────────
                  _row(
                    avatar: const AgentAvatar(artId: 'myto', size: 46, dot: true),
                    title: 'Myto',
                    subtitle: 'The assistant — coding, research, writing',
                    badge: Icons.auto_awesome,
                    onTap: _openMytoChat,
                  ),
                  // ── Agents ────────────────────────────────────────────────
                  if (agents.isNotEmpty) ...<Widget>[
                    TeamlyGroupHeader(label: 'AGENTS', count: agents.length),
                    for (final a in agents)
                      _row(
                        avatar: AgentAvatar(artId: a.artId, size: 46),
                        title: a.name,
                        subtitle: a.description,
                        onTap: () => _openAgent(a),
                      ),
                  ],
                  // ── Rooms ─────────────────────────────────────────────────
                  if (rooms.isNotEmpty) ...<Widget>[
                    TeamlyGroupHeader(label: 'ROOMS', count: rooms.length),
                    for (final r in rooms) _roomRow(r, studio),
                  ],
                  // ── Saved conversations ───────────────────────────────────
                  if (saved.isNotEmpty) ...<Widget>[
                    TeamlyGroupHeader(label: 'CHATS', count: saved.length),
                    for (final c in saved) _conversationRow(c),
                  ],
                  // ── Community DMs ─────────────────────────────────────────
                  if (_me.isNotEmpty)
                    StreamBuilder<List<DmThread>>(
                      stream: DmService.streamThreads(_me),
                      builder: (context, snap) {
                        final threads = (snap.data ?? const <DmThread>[])
                            .where((t) => q.isEmpty)
                            .toList(growable: false);
                        if (threads.isEmpty) return const SizedBox.shrink();
                        return Column(
                          children: <Widget>[
                            TeamlyGroupHeader(label: 'MESSAGES', count: threads.length),
                            for (final t in threads) _dmRow(t),
                          ],
                        );
                      },
                    ),
                  // ── Community people (from the old Search tab) ────────────
                  if (_people != null && _people!.isNotEmpty) ...<Widget>[
                    TeamlyGroupHeader(label: 'PEOPLE', count: _people!.length),
                    for (final p in _people!)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
                        child: TeamlyCard(
                          onTap: () => _startChatWith(p.uid, p.name, p.photo),
                          padding: const EdgeInsets.all(TeamlySpace.s4),
                          child: Row(
                            children: <Widget>[
                              _UserAvatar(photo: p.photo, name: p.name, size: 42),
                              const SizedBox(width: TeamlySpace.s3),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    Text(
                                      p.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        color: TeamlyColors.ink900,
                                        fontSize: 15.5,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    Text(
                                      p.username.isEmpty ? 'On Myto' : '@${p.username}',
                                      style: const TextStyle(color: TeamlyColors.greenText, fontSize: 12.5),
                                    ),
                                  ],
                                ),
                              ),
                              const Icon(Icons.chat_bubble_outline_rounded, size: 18, color: TeamlyColors.ink300),
                            ],
                          ),
                        ),
                      ),
                  ],
                  // ── Community post hits ───────────────────────────────────
                  if (_postHits != null && _postHits!.isNotEmpty) ...<Widget>[
                    TeamlyGroupHeader(label: 'DISCOVER', count: _postHits!.length),
                    for (final post in _postHits!)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
                        child: TeamlyCard(
                          padding: const EdgeInsets.all(TeamlySpace.s4),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                post.name,
                                style: const TextStyle(
                                  color: TeamlyColors.ink900,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                post.text,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13, height: 1.4),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                  if (agents.isEmpty && rooms.isEmpty && saved.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(TeamlySpace.s8),
                      child: Text(
                        _query.trim().isEmpty
                            ? 'Pick an agent to start — or tap Myto for the assistant.'
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

  Future<void> _compose() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PostComposerPage(
          onPosted: () {
            if (!mounted) return;
            ScaffoldMessenger.of(context)
              ..hideCurrentSnackBar()
              ..showSnackBar(const SnackBar(content: Text('Posted to Discover.')));
          },
        ),
      ),
    );
  }

  // ── Rows ────────────────────────────────────────────────────────────────────

  Widget _row({
    required Widget avatar,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
    IconData? badge,
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
                      fontSize: 15.5,
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
            if (badge != null) ...<Widget>[
              const SizedBox(width: TeamlySpace.s2),
              Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(
                  color: context.palette.chip,
                  shape: BoxShape.circle,
                ),
                child: Icon(badge, size: 14, color: TeamlyColors.ink700),
              ),
            ],
            const Icon(Icons.chevron_right_rounded, size: 20, color: TeamlyColors.ink300),
          ],
        ),
      ),
    );
  }

  Widget _roomRow(AgentTeam room, StudioStore studio) {
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
              width: 62,
              height: 46,
              child: Stack(
                children: <Widget>[
                  for (var i = 0; i < members.take(3).length; i++)
                    Positioned(
                      left: i * 16.0,
                      child: Container(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: context.palette.surface, width: 2),
                        ),
                        child: AgentAvatar(artId: members[i].artId, size: 42),
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
                      fontSize: 15.5,
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

  Widget _conversationRow(Conversation c) {
    final channelAvatar = c.channel == null
        ? const AgentAvatar(artId: 'myto', size: 42)
        : c.channel!.startsWith('room:')
            ? const AgentAvatar(artId: 'project-manager', size: 42)
            : AgentAvatar(
                artId: agentById(TeamChatStore.idFromKey(c.channel!))?.artId ?? 'prompt-engineer',
                size: 42,
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
                      fontSize: 15.5,
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

  Widget _dmRow(DmThread thread) {
    final other = thread.otherUid(_me);
    if (other.isNotEmpty) _loadDmProfile(other);
    final p = _dmProfiles[other];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 4),
      child: TeamlyCard(
        onTap: () => _openDm(thread),
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            _UserAvatar(photo: p?.photo ?? '', name: p?.name ?? '?', size: 42),
            const SizedBox(width: TeamlySpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    p?.name ?? 'Myto user',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: TeamlyColors.ink900,
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Open conversation',
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
