import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/agent.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import '../widgets/teamly/parts.dart';

/// The Agents tab — the marketplace. Mirrors the reference screenshot exactly:
///
///   [Agents | Automations]   segmented pill
///   [Agents | Agent Teams]   text tabs
///   [Search agents...]  [+ Create My Own Agent]  green CTA
///   [By Teamly AI | My Custom Agents]  source filter
///   [All · Content Creation · Customer Support · Data Analysis · ...]  rail
///   agent cards ...            pastel disc · title · one-liner · [Chat]
class AgentsScreen extends StatefulWidget {
  const AgentsScreen({super.key, this.onOpenChat});

  /// Jump to the Chat tab when the user picks an agent/team to talk to.
  final VoidCallback? onOpenChat;

  @override
  State<AgentsScreen> createState() => _AgentsScreenState();
}

class _AgentsScreenState extends State<AgentsScreen> {
  AgentMode _mode = AgentMode.agents;
  int _tab = 0; // 0 = Agents, 1 = Agent Teams
  AgentSource _source = AgentSource.teamly;
  String _category = 'All';
  String _query = '';

  List<Agent> _results(StudioStore store) {
    final all = _query.trim().isEmpty
        ? store.agentsIn(_category, source: _source)
        : store.searchAgents(_query, source: _source);
    return all
        .where((a) => _category == 'All' || a.category == _category)
        .toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final store = context.watch<StudioStore>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Agents'),
        actions: <Widget>[
          Padding(
            padding: const EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(child: TeamlyFab(icon: Icons.add_rounded, onPressed: _createAgent)),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          // Segmented pill: Agents | Automations
          Center(
            child: TeamlySegmented(
              labels: const <String>['Agents', 'Automations'],
              index: _mode.index,
              onChanged: (i) => setState(() => _mode = AgentMode.values[i]),
            ),
          ),
          const SizedBox(height: TeamlySpace.s3),
          if (_mode == AgentMode.agents)
            // Text tabs: Agents | Agent Teams
            TeamlyTabs(
              labels: const <String>['Agents', 'Agent Teams'],
              index: _tab,
              onChanged: (i) => setState(() => _tab = i),
            ),
          const SizedBox(height: TeamlySpace.s3),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
            child: TeamlySearch(
              hint: _tab == 1 ? 'Search teams...' : 'Search agents...',
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          if (_mode == AgentMode.agents && _tab == 0) ...<Widget>[
            const SizedBox(height: TeamlySpace.s3),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: TeamlySpace.gutter),
              child: Row(
                children: <Widget>[
                  _SourceChip(
                    label: 'By Teamly AI',
                    selected: _source == AgentSource.teamly,
                    onTap: () => setState(() => _source = AgentSource.teamly),
                  ),
                  const SizedBox(width: TeamlySpace.s2),
                  _SourceChip(
                    label: 'My Custom Agents',
                    selected: _source == AgentSource.custom,
                    onTap: () => setState(() => _source = AgentSource.custom),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: _createAgent,
                    child: const Text(
                      '+ Create My Own Agent',
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
            const SizedBox(height: TeamlySpace.s3),
            TeamlyChipRail(
              labels: kAgentCategories,
              selected: _category,
              onSelected: (v) => setState(() => _category = v),
            ),
          ],
          const SizedBox(height: TeamlySpace.s2),
          Expanded(child: _body(store)),
        ],
      ),
    );
  }

  Widget _body(StudioStore store) {
    if (_mode == AgentMode.automations) {
      return const _AutomationsPlaceholder();
    }
    if (_tab == 1) return _teamsList(store);
    final results = _results(store);
    if (results.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(
            _source == AgentSource.custom
                ? 'You haven\'t built an agent yet — tap "+ Create My Own Agent".'
                : 'No agents in this category yet.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
          ),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      itemCount: results.length,
      separatorBuilder: (_, __) => const SizedBox(height: TeamlySpace.s3),
      itemBuilder: (context, i) {
        final agent = results[i];
        return TeamlyAgentCard(
          agent: agent,
          onChat: () => _chatWith(agent),
        );
      },
    );
  }

  Widget _teamsList(StudioStore store) {
    final teams = store.teams;
    return ListView.separated(
      padding: const EdgeInsets.all(TeamlySpace.gutter),
      itemCount: teams.length,
      separatorBuilder: (_, __) => const SizedBox(height: TeamlySpace.s3),
      itemBuilder: (context, i) {
        final team = teams[i];
        return TeamlyCard(
          child: Row(
            children: <Widget>[
              TeamlyStackedAvatars(pastelIndices: const <int>[0, 1, 2], size: 44),
              const SizedBox(width: TeamlySpace.s4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      team.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: TeamlyColors.ink900,
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                      ),
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
              TeamlyPillButton(
                label: 'Chat',
                compact: true,
                onPressed: () {
                  _snack('Opening ${team.name}...');
                  widget.onOpenChat?.call();
                },
              ),
            ],
          ),
        );
      },
    );
  }

  /// Chat button on an agent row: makes you "friends" (the social model the
  /// reference uses) then jumps to the Chat tab.
  void _chatWith(Agent agent) {
    final store = context.read<StudioStore>();
    if (!agent.friends) {
      store.toggleFriend(agent.id);
      _snack('You are now friends with ${agent.name}.');
    }
    widget.onOpenChat?.call();
  }

  Future<void> _createAgent() async {
    final nameCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    var category = kAgentCategories.length > 1 ? kAgentCategories[1] : 'General';
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: context.palette.surface,
        title: const Text('Create My Own Agent'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(TeamlyRadius.lg)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            TextField(
              controller: nameCtrl,
              autofocus: true,
              decoration: const InputDecoration(hintText: 'Agent name'),
            ),
            const SizedBox(height: TeamlySpace.s2),
            TextField(
              controller: descCtrl,
              decoration: const InputDecoration(hintText: 'What does it specialise in?'),
              maxLines: 2,
            ),
            const SizedBox(height: TeamlySpace.s3),
            DropdownButtonFormField<String>(
              value: category,
              decoration: const InputDecoration(hintText: 'Category'),
              items: kAgentCategories
                  .where((c) => c != 'All')
                  .map((c) => DropdownMenuItem<String>(value: c, child: Text(c)))
                  .toList(),
              onChanged: (v) {
                if (v != null) category = v;
              },
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: TeamlyColors.ink500)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Create', style: TextStyle(color: TeamlyColors.greenText)),
          ),
        ],
      ),
    );
    if (ok == true && mounted) {
      context
          .read<StudioStore>()
          .addCustomAgent(name: nameCtrl.text, description: descCtrl.text, category: category);
      setState(() {
        _source = AgentSource.custom;
        _category = 'All';
      });
      final name = nameCtrl.text.trim();
      _snack('${name.isEmpty ? 'Your agent' : name} is ready.');
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }
}

class _SourceChip extends StatelessWidget {
  const _SourceChip({required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? palette.accent : palette.chip,
          borderRadius: BorderRadius.circular(TeamlyRadius.pill),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? palette.onAccent : TeamlyColors.ink700,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _AutomationsPlaceholder extends StatelessWidget {
  const _AutomationsPlaceholder();

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.timelapse_rounded, size: 44, color: palette.muted),
            const SizedBox(height: 16),
            Text(
              'Automations',
              style: TextStyle(color: palette.text, fontSize: 19, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            const Text(
              'Unattended jobs are on the way — agents that run when you\'re offline and file the results into your Artifacts.',
              textAlign: TextAlign.center,
              style: TextStyle(color: TeamlyColors.ink500, fontSize: 14, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}