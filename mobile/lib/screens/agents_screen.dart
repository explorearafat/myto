import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../services/studio_store.dart';
import '../widgets/agent_avatar.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'team_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// AgentsScreen — the Agents tab, rebuilt:
///
///   search pill (with a small + to its right once a group exists)
///   the user's created agent groups as flat messenger rows
///
/// With no groups the body shows a two-line call to action — "No Agent
/// created" / "+ Click to create agent team" — and the + starts the builder:
/// pick 2+ of the ten chat agents, name the group, optionally set a group
/// photo (a member's portrait or a picture the user uploads). No borders, no
/// cards — everything prints 1 by 1, messenger style.
/// ---------------------------------------------------------------------------
class AgentsScreen extends StatefulWidget {
  const AgentsScreen({super.key});

  @override
  State<AgentsScreen> createState() => _AgentsScreenState();
}

class _AgentsScreenState extends State<AgentsScreen> {
  String _query = '';

  Future<void> _create() async {
    final selected = <String>{};
    String? avatar; // 'asset:agent-XX' or 'file:<path>'
    final nameCtrl = TextEditingController();

    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) => Padding(
          padding: EdgeInsets.only(
            left: TeamlySpace.gutter,
            right: TeamlySpace.gutter,
            top: TeamlySpace.s4,
            bottom: MediaQuery.of(context).viewInsets.bottom + TeamlySpace.s4,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // ── Group photo + name ──────────────────────────────────────
              Row(
                children: <Widget>[
                  GestureDetector(
                    onTap: () async {
                      // Pick a group photo: a selected member's portrait, or
                      // the user's own upload (copied into app storage so it
                      // survives restarts).
                      final choice = await showModalBottomSheet<String>(
                        context: context,
                        backgroundColor: context.palette.surface,
                        builder: (context) => SafeArea(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              for (final id in selected)
                                ListTile(
                                  leading: AgentAvatar(artId: kAgentIndex[id]?.artId ?? '', size: 36),
                                  title: Text(kAgentIndex[id]?.name ?? id, style: const TextStyle(fontSize: 14.5)),
                                  onTap: () => Navigator.pop(context, kAgentIndex[id]?.artId ?? ''),
                                ),
                              ListTile(
                                leading: const Icon(Icons.photo_outlined, size: 22),
                                title: const Text('Upload photo', style: TextStyle(fontSize: 14.5)),
                                onTap: () => Navigator.pop(context, '_upload'),
                              ),
                            ],
                          ),
                        ),
                      );
                      if (choice == null || choice.isEmpty) return;
                      if (choice == '_upload') {
                        final path = await _pickAndStorePhoto();
                        if (path != null) {
                          setSheetState(() => avatar = 'file:$path');
                        } else if (mounted) {
                          ScaffoldMessenger.of(this.context)
                            ..hideCurrentSnackBar()
                            ..showSnackBar(const SnackBar(content: Text('Could not pick a photo.')));
                        }
                        return;
                      }
                      setSheetState(() => avatar = choice);
                    },
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: <Widget>[
                        AgentAvatar(artId: avatar ?? 'asset:agent-01', size: 52),
                        const Positioned(
                          right: -2,
                          bottom: -2,
                          child: CircleAvatar(
                            radius: 10,
                            backgroundColor: TeamlyColors.green500,
                            child: Icon(Icons.edit_rounded, size: 11, color: Colors.white),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      controller: nameCtrl,
                      autofocus: true,
                      decoration: const InputDecoration(
                        hintText: 'Group name',
                        border: InputBorder.none,
                      ),
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                      onChanged: (_) => setSheetState(() {}),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: TeamlySpace.s2),
              Text(
                'Select at least 2 agents (${selected.length} selected)',
                style: const TextStyle(color: TeamlyColors.ink500, fontSize: 12.5),
              ),
              const SizedBox(height: TeamlySpace.s1),
              // ── The ten agents, messenger rows with a trailing check ────
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  children: <Widget>[
                    for (final agent in kSeedAgents)
                      InkWell(
                        onTap: () => setSheetState(() {
                          if (selected.contains(agent.id)) {
                            selected.remove(agent.id);
                            if (avatar == agent.artId) avatar = null;
                          } else {
                            selected.add(agent.id);
                          }
                        }),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 7),
                          child: Row(
                            children: <Widget>[
                              AgentAvatar(artId: agent.artId, size: 42),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  agent.name,
                                  style: const TextStyle(
                                    color: TeamlyColors.ink900,
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                              Icon(
                                selected.contains(agent.id)
                                    ? Icons.check_circle_rounded
                                    : Icons.radio_button_unchecked_rounded,
                                size: 20,
                                color: selected.contains(agent.id)
                                    ? TeamlyColors.green500
                                    : TeamlyColors.ink300,
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: TeamlySpace.s3),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: Material(
                  color: selected.length >= 2 && nameCtrl.text.trim().isNotEmpty
                      ? context.palette.accent
                      : context.palette.chip,
                  borderRadius: BorderRadius.circular(14),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: selected.length >= 2 && nameCtrl.text.trim().isNotEmpty
                        ? () => Navigator.pop(context, true)
                        : null,
                    child: Center(
                      child: Text(
                        'Create group chat',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: selected.length >= 2 && nameCtrl.text.trim().isNotEmpty
                              ? context.palette.onAccent
                              : TeamlyColors.ink300,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
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
            avatar: avatar ?? '',
          );
      _openTeam(team);
    }
  }

  /// Pick a picture from the gallery and copy it into the app's documents
  /// directory (the on-device storage that survives restarts). Returns the
  /// copied file's path, or null when the user cancelled / picking failed.
  Future<String?> _pickAndStorePhoto() async {
    try {
      final picked = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 512);
      if (picked == null) return null;
      final docs = await getApplicationDocumentsDirectory();
      final name = 'group-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}.jpg';
      final copy = File('${docs.path}/$name');
      await File(picked.path).copy(copy.path);
      return copy.path;
    } catch (_) {
      return null;
    }
  }

  void _openTeam(AgentTeam team) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.room(room: team),
      ),
    );
  }

  Future<void> _deleteTeam(AgentTeam team) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: context.palette.surface,
        title: const Text('Delete group?'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(TeamlyRadius.lg)),
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
      context.read<StudioStore>().removeTeam(team.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final store = context.watch<StudioStore>();
    final q = _query.trim().toLowerCase();
    final teams = store.teams
        .where((t) => q.isEmpty || t.name.toLowerCase().contains(q))
        .toList(growable: false);
    final hasGroups = store.teams.isNotEmpty;

    return Scaffold(
      backgroundColor: palette.bg,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: <Widget>[
            const SizedBox(height: TeamlySpace.s3),
            // ── Search bar, with the + at its right once a group exists ────
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: TeamlySearch(
                      hint: 'Search groups...',
                      onChanged: (v) => setState(() => _query = v),
                    ),
                  ),
                  if (hasGroups) ...<Widget>[
                    const SizedBox(width: TeamlySpace.s2),
                    GestureDetector(
                      onTap: _create,
                      child: Icon(Icons.add_circle_rounded, size: 30, color: palette.accent),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: TeamlySpace.s2),
            Expanded(child: _body(context, teams)),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, List<AgentTeam> teams) {
    if (teams.isEmpty) {
      // The two-line empty state; the + line starts the group builder.
      return Center(
        child: GestureDetector(
          onTap: _create,
          behavior: HitTestBehavior.opaque,
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Text(
                  'No Agent created',
                  style: TextStyle(
                    color: TeamlyColors.ink900,
                    fontSize: 19,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(Icons.add_circle_rounded, size: 18, color: context.palette.accent),
                    const SizedBox(width: 6),
                    const Text(
                      'Click to create agent team',
                      style: TextStyle(
                        color: TeamlyColors.greenText,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    }
    // Flat messenger rows — avatar · gap · group name.
    return ListView(
      padding: const EdgeInsets.only(top: 4, bottom: TeamlySpace.s6),
      children: <Widget>[
        for (final t in teams)
          InkWell(
            onTap: () => _openTeam(t),
            onLongPress: () => _deleteTeam(t),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter, vertical: 8),
              child: Row(
                children: <Widget>[
                  AgentAvatar(artId: t.avatarArt((id) => agentById(id)?.artId ?? ''), size: 46),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          t.name,
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
                          t.subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: TeamlyColors.ink500, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
