import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../services/studio_store.dart';
import '../services/team_chat_store.dart';
import '../theme.dart';
import '../widgets/agent_avatar.dart';
import '../widgets/teamly/kit.dart';
import 'team_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// AgentsScreen — the Rooms hub.
///
/// This is the group-chat section: every room is a chat where the roster
/// specialists research the user's problem together and hand back a Research
/// Report. The user builds a room by picking agents from the roster, names it,
/// and taps it to open the group chat. No demo data — only the seeded room
/// catalogue plus rooms the user creates.
/// ---------------------------------------------------------------------------
class AgentsScreen extends StatefulWidget {
  const AgentsScreen({super.key});

  @override
  State<AgentsScreen> createState() => _AgentsScreenState();
}

class _AgentsScreenState extends State<AgentsScreen> {
  String _query = '';

  Future<void> _createRoom() async {
    final store = context.read<StudioStore>();
    final selected = <String>{};

    final nameCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: context.palette.surface,
          title: const Text('New room'),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(TeamlyRadius.lg),
          ),
          content: SizedBox(
            width: 360,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                TextField(
                  controller: nameCtrl,
                  autofocus: true,
                  decoration: const InputDecoration(hintText: 'Room name (optional)'),
                ),
                const SizedBox(height: 14),
                const Text(
                  'Pick specialists',
                  style: TextStyle(
                    color: TeamlyColors.ink500,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.1,
                  ),
                ),
                const SizedBox(height: 8),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: <Widget>[
                      for (final agent in kSeedAgents)
                        CheckboxListTile(
                          value: selected.contains(agent.id),
                          onChanged: (v) => setDialogState(() {
                            if (v == true) {
                              selected.add(agent.id);
                            } else {
                              selected.remove(agent.id);
                            }
                          }),
                          controlAffinity: ListTileControlAffinity.leading,
                          title: Row(
                            children: <Widget>[
                              AgentAvatar(
                                artId: agent.artId,
                                size: 30,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    Text(
                                      agent.name,
                                      style: const TextStyle(
                                        color: TeamlyColors.ink900,
                                        fontSize: 14,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                    Text(
                                      agent.description,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        color: TeamlyColors.ink500,
                                        fontSize: 12,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
            ),
            TextButton(
              onPressed: selected.isEmpty
                  ? null
                  : () => Navigator.pop(context, true),
              child: const Text(
                'Create room',
                style: TextStyle(color: TeamlyColors.greenText),
              ),
            ),
          ],
        ),
      ),
    );

    if (ok == true && mounted) {
      final team = context.read<StudioStore>().createTeam(
            name: nameCtrl.text.trim(),
            roles: <String>[
              for (final id in selected)
                kAgentIndex[id]?.name ?? 'Specialist',
            ],
            agentIds: selected.toList(),
          );
      _openRoom(team);
    }
  }

  void _openRoom(AgentTeam room) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.room(room: room),
      ),
    );
  }

  Future<void> _deleteRoom(AgentTeam room) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: context.palette.surface,
        title: const Text('Delete room?'),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(TeamlyRadius.lg),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete', style: TextStyle(color: TeamlyColors.danger)),
          ),
        ],
      ),
    );
    if (ok == true && mounted) {
      context.read<StudioStore>().removeTeam(room.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<StudioStore>();
    final q = _query.trim().toLowerCase();
    final rooms = store.teams
        .where((t) => q.isEmpty || t.name.toLowerCase().contains(q))
        .toList(growable: false);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Rooms'),
        actions: <Widget>[
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(
              child: TeamlyFab(
                icon: Icons.add_rounded,
                onPressed: _createRoom,
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: TeamlySearch(
              hint: 'Search rooms...',
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          const SizedBox(height: TeamlySpace.s3),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: Row(
              children: <Widget>[
                const Text(
                  'Group chats — pick a room to research a problem together',
                  style: TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: _createRoom,
                  child: const Text(
                    '+ New room',
                    style: TextStyle(
                      color: TeamlyColors.greenText,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: TeamlySpace.s2),
          Expanded(
            child: rooms.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Icon(
                            Icons.groups_rounded,
                            size: 44,
                            color: context.palette.muted,
                          ),
                          const SizedBox(height: 14),
                          const Text(
                            'No rooms yet',
                            style: TextStyle(
                              color: TeamlyColors.ink900,
                              fontSize: 18,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            'Tap "+ New room" to gather specialists — they will research your question together and hand you a report.',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: TeamlyColors.ink500,
                              fontSize: 14,
                              height: 1.5,
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.all(TeamlySpace.gutter),
                    itemCount: rooms.length,
                    separatorBuilder: (_, __) => const SizedBox(height: TeamlySpace.s3),
                    itemBuilder: (context, i) {
                      final room = rooms[i];
                      return _RoomCard(
                        room: room,
                        onTap: () => _openRoom(room),
                        onDelete: () => _deleteRoom(room),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _RoomCard extends StatelessWidget {
  const _RoomCard({
    required this.room,
    required this.onTap,
    required this.onDelete,
  });

  final AgentTeam room;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final members = <Agent>[
      for (final id in room.agentIds)
        if (agentById(id) != null) agentById(id)!,
    ];
    final shown = members.take(3).toList();

    return TeamlyCard(
      onTap: onTap,
      child: Row(
        children: <Widget>[
          // Stacked generated avatars of the first three members.
          SizedBox(
            width: 72,
            height: 44,
            child: Stack(
              children: <Widget>[
                for (var i = 0; i < shown.length; i++)
                  Positioned(
                    left: i * 18.0,
                    top: 0,
                    child: Container(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: context.palette.surface,
                          width: 2,
                        ),
                      ),
                      child: AgentAvatar(
                        artId: shown[i].artId,
                        size: 40,
                      ),
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
                    fontSize: 16,
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
          IconButton(
            onPressed: onDelete,
            icon: const Icon(Icons.delete_outline_rounded, size: 19),
            color: TeamlyColors.ink300,
            tooltip: 'Delete room',
          ),
          const SizedBox(width: 4),
          const Icon(Icons.chevron_right_rounded, color: TeamlyColors.ink300),
        ],
      ),
    );
  }
}
