import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'agents_screen.dart';
import 'artifacts_screen.dart';
import 'assistant_screen.dart';
import 'chat_screen.dart';
import 'memory_screen.dart';

/// ---------------------------------------------------------------------------
/// ToolsHubScreen — the full-screen destination behind Discover's back button:
/// every original Myto screen (AI Chat, Helper, Agents, Memory, Artifacts) as
/// a big tile. Tapping one opens it full-screen; the app bar's back arrow
/// returns to wherever you came from.
/// ---------------------------------------------------------------------------
class ToolsHubScreen extends StatelessWidget {
  const ToolsHubScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: const Text(
          'Myto',
          style: TextStyle(
            fontFamily: 'Dancing Script',
            fontSize: 30,
            fontWeight: FontWeight.w700,
            color: TeamlyColors.ink900,
          ),
        ),
        actions: const <Widget>[
          Padding(
            padding: EdgeInsets.only(right: TeamlySpace.s4),
            child: Center(
              child: Text(
                'tools',
                style: TextStyle(fontSize: 13, color: TeamlyColors.ink500),
              ),
            ),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(TeamlySpace.gutter),
        children: <Widget>[
          _ToolTile(
            icon: Icons.chat_bubble_outline_rounded,
            title: 'AI Chat',
            subtitle: 'Talk with your models — the original Myto chat',
            onTap: () => _push(context, const ChatScreen()),
          ),
          _ToolTile(
            icon: Icons.smart_toy_outlined,
            title: 'Agents',
            subtitle: 'Create, run and manage your agents',
            onTap: () => _push(context, const AgentsScreen()),
          ),
          _ToolTile(
            icon: Icons.assistant_outlined,
            title: 'Helper',
            subtitle: 'Your AI assistant',
            onTap: () => _push(context, const AssistantScreen()),
          ),
          _ToolTile(
            icon: Icons.psychology_outlined,
            title: 'Memory',
            subtitle: 'What Myto remembers about your work',
            onTap: () => _push(context, const MemoryScreen()),
          ),
          _ToolTile(
            icon: Icons.layers_outlined,
            title: 'Artifacts',
            subtitle: 'Generated images, video, documents & files',
            onTap: () => _push(context, const ArtifactsScreen()),
          ),
        ],
      ),
    );
  }

  void _push(BuildContext context, Widget screen) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
  }
}

class _ToolTile extends StatelessWidget {
  const _ToolTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(
      padding: const EdgeInsets.only(bottom: TeamlySpace.s3),
      child: TeamlyCard(
        onTap: onTap,
        padding: const EdgeInsets.all(TeamlySpace.s4),
        child: Row(
          children: <Widget>[
            Container(
              width: 48,
              height: 48,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: palette.tagBg,
                borderRadius: BorderRadius.circular(TeamlyRadius.md),
              ),
              child: Icon(icon, size: 24, color: palette.tagFg),
            ),
            const SizedBox(width: TeamlySpace.s4),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      color: TeamlyColors.ink900,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: const TextStyle(fontSize: 13, color: TeamlyColors.ink500),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 22, color: palette.muted),
          ],
        ),
      ),
    );
  }
}
