import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../services/studio_store.dart';
import '../widgets/agent_avatar.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import '../widgets/teamly/parts.dart';
import 'team_chat_screen.dart';

/// ---------------------------------------------------------------------------
/// AgentsScreen — the Agents tab, styled on the Teamly reference:
///
///   [Agents | Automations] segmented header
///   Agents · Agent Teams  (text tabs)
///   search + green "Create My Own Agent"
///   [By Myto AI | My Custom Agents]  →  category chips (All, Quality, ...)
///   agent cards (illustration avatar · title · description · green Chat)
///
/// "Agents" lists the roster (kSeedAgents — the catalogue Myto ships) and the
/// user's custom agents; "Agent Teams" lists the research rooms. Automations
/// is the scheduled-runs surface, which the mobile app doesn't have yet — an
/// honest empty state.
/// ---------------------------------------------------------------------------
class AgentsScreen extends StatefulWidget {
  const AgentsScreen({super.key});

  @override
  State<AgentsScreen> createState() => _AgentsScreenState();
}

class _AgentsScreenState extends State<AgentsScreen> {
  /// Agents | Automations.
  int _segment = 0;

  /// Agents | Agent Teams.
  int _tab = 0;

  /// By Myto AI | My Custom Agents.
  String _source = 'By Myto AI';

  String _category = 'All';
  String _query = '';

  bool get _showRoster => _source == 'By Myto AI';

  Future<void> _create() async {
    if (_tab == 1) {
      await _createRoom();
      return;
    }
    // On the Agents tab the green CTA routes to the team builder too —
    // custom agents are rooms you assemble from the roster.
    await _createRoom();
  }

  Future<void> _createRoom() async {
    final selected = <String>{};

    final nameCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: context.palette.surface,
          title: const Text('My own agent team'),
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
                  decoration: const InputDecoration(hintText: 'Team name (optional)'),
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
                              AgentAvatar(artId: agent.artId),
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
              onPressed: selected.isEmpty ? null : () => Navigator.pop(context, true),
              child: const Text(
                'Create team',
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
      _openTeam(team);
    }
  }

  void _openAgent(Agent agent) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.direct(agent: agent, resumeTitle: agent.name),
      ),
    );
  }

  void _openTeam(AgentTeam team) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TeamChatScreen.room(room: team),
      ),
    );
  }

  Future<void> _deleteRoom(AgentTeam room) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: context.palette.surface,
        title: const Text('Delete team?'),
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
    final palette = context.palette;
    final store = context.watch<StudioStore>();
    final q = _query.trim().toLowerCase();

    // Categories straight from the roster, alphabetical with All first.
    final categories = <String>{'All', for (final a in kSeedAgents) a.category}.toList()..sort();

    final agents = <Agent>[
      if (_showRoster)
        for (final a in kSeedAgents
            .where((a) =>
                (_category == 'All' || a.category == _category) &&
                (q.isEmpty || a.name.toLowerCase().contains(q))))
          a
      else
        ...store.agentsBy(AgentSource.custom)
            .where((a) => (_category == 'All' || a.category == _category) && (q.isEmpty || a.name.toLowerCase().contains(q))),
    ];
    final teams = store.teams
        .where((t) => q.isEmpty || t.name.toLowerCase().contains(q))
        .toList(growable: false);

    return Scaffold(
      backgroundColor: palette.bg,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: <Widget>[
            const SizedBox(height: TeamlySpace.s3),
            // Agents | Automations segmented pill.
            Center(
              child: TeamlySegmented(
                labels: const <String>['Agents', 'Automations'],
                index: _segment,
                onChanged: (i) => setState(() => _segment = i),
              ),
            ),
            const SizedBox(height: TeamlySpace.s2),
            if (_segment == 0) ...<Widget>[
              // Agents · Agent Teams text tabs.
              TeamlyTabs(
                labels: const <String>['Agents', 'Agent Teams'],
                index: _tab,
                onChanged: (i) => setState(() => _tab = i),
              ),
              const SizedBox(height: TeamlySpace.s2),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: TeamlySearch(
                        hint: _tab == 0 ? 'Search agents...' : 'Search teams...',
                        onChanged: (v) => setState(() => _query = v),
                      ),
                    ),
                    const SizedBox(width: TeamlySpace.s2),
                    TeamlyPillButton(
                      label: _tab == 0 ? 'Create My Own Agent' : 'New Team',
                      icon: Icons.add_rounded,
                      onPressed: _create,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: TeamlySpace.s3),
              SizedBox(
                height: 48,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
                  children: <Widget>[
                    if (_tab == 0) ...<Widget>[
                      Padding(
                        padding: const EdgeInsets.only(right: TeamlySpace.s2),
                        child: TeamlyChip(
                          label: 'By Myto AI',
                          selected: _showRoster,
                          onTap: () => setState(() => _source = 'By Myto AI'),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.only(right: TeamlySpace.s2),
                        child: TeamlyChip(
                          label: 'My Custom Agents',
                          selected: !_showRoster,
                          onTap: () => setState(() => _source = 'My Custom Agents'),
                        ),
                      ),
                      const VerticalDivider(width: TeamlySpace.s4),
                    ],
                    for (final c in categories)
                      Padding(
                        padding: const EdgeInsets.only(right: TeamlySpace.s2),
                        child: TeamlyChip(
                          label: c,
                          selected: _category == c,
                          onTap: () => setState(() => _category = c),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: TeamlySpace.s1),
              Expanded(child: _body(context, agents, teams, store)),
            ] else
              ...<Widget>[
                // Automations: scheduled agent runs — a desktop-side feature
                // the mobile app hasn't grown yet.
                const SizedBox(height: TeamlySpace.s4),
                Expanded(
                  child: Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Icon(Icons.bolt_rounded, size: 44, color: palette.muted),
                          const SizedBox(height: 14),
                          const Text(
                            'No automations yet',
                            style: TextStyle(
                              color: TeamlyColors.ink900,
                              fontSize: 18,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            'Set an agent to run on a schedule — daily digests, '
                            'watchers, recurring reports. Coming to mobile soon.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, List<Agent> agents, List<AgentTeam> teams, StudioStore store) {
    if (_tab == 1) {
      if (teams.isEmpty) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.groups_rounded, size: 44, color: context.palette.muted),
                const SizedBox(height: 14),
                Text(
                  _query.trim().isEmpty ? 'No teams yet' : 'Nothing matches “$_query”',
                  style: const TextStyle(
                    color: TeamlyColors.ink900,
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Gather specialists — they will research your question together and hand you a report.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
                ),
              ],
            ),
          ),
        );
      }
      return ListView.separated(
        padding: const EdgeInsets.all(TeamlySpace.gutter),
        itemCount: teams.length,
        separatorBuilder: (_, __) => const SizedBox(height: TeamlySpace.s3),
        itemBuilder: (context, i) => _TeamCard(
          team: teams[i],
          onOpen: () => _openTeam(teams[i]),
          onDelete: () => _deleteRoom(teams[i]),
        ),
      );
    }

    if (agents.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.smart_toy_outlined, size: 44, color: context.palette.muted),
              const SizedBox(height: 14),
              Text(
                _query.trim().isEmpty ? 'No custom agents yet' : 'Nothing matches “$_query”',
                style: const TextStyle(
                  color: TeamlyColors.ink900,
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Assemble your own team of specialists — they chat together and research as one.',
                textAlign: TextAlign.center,
                style: TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
              ),
              const SizedBox(height: 22),
              TeamlyPillButton(label: 'Create My Own Agent', icon: Icons.add_rounded, onPressed: _create),
            ],
          ),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      itemCount: agents.length,
      separatorBuilder: (_, __) => const SizedBox(height: TeamlySpace.s3),
      itemBuilder: (context, i) => TeamlyAgentCard(
        agent: agents[i],
        onChat: () => _openAgent(agents[i]),
      ),
    );
  }
}

/// Room card for the Agent Teams tab (delete affordance included).
class _TeamCard extends StatelessWidget {
  const _TeamCard({required this.team, required this.onOpen, required this.onDelete});

  final AgentTeam team;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final members = <Agent>[
      for (final id in team.agentIds)
        if (agentById(id) != null) agentById(id)!,
    ];
    final shown = members.take(3).toList();
    return TeamlyCard(
      onTap: onOpen,
      child: Row(
        children: <Widget>[
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
                        border: Border.all(color: context.palette.surface, width: 2),
                      ),
                      child: AgentAvatar(artId: shown[i].artId, size: 40),
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
                  team.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: TeamlyColors.ink900, fontSize: 16, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Text(
                  team.subtitle,
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
            tooltip: 'Delete team',
          ),
          const SizedBox(width: 4),
          const Icon(Icons.chevron_right_rounded, color: TeamlyColors.ink300),
        ],
      ),
    );
  }
}
