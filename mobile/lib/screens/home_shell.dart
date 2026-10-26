import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/studio_store.dart';
import '../theme.dart';
import 'assistant_screen.dart';
import '../widgets/teamly/kit.dart';
import 'agents_screen.dart';
import 'artifacts_screen.dart';
import 'chat_screen.dart';
import 'discover_screen.dart';
import 'memory_screen.dart';

/// The 5-tab Teamly shell — the single navigation all five reference
/// screenshots share on every tab:
///
///   Chat · Agents · Discover · Memory · Artifacts
///
/// [IndexedStack] keeps every tab alive, so a stream running in Chat keeps
/// streaming while the user browses Agents. The Memory badge reads the same
/// [StudioStore.newCount] as the `Updates n` chip and the per-row NEW dots —
/// one signal, three places.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  void _go(int i) {
    if (_tab == i) return;
    setState(() => _tab = i);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final studio = context.watch<StudioStore>();

    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: <Widget>[
          const ChatScreen(),
          const AssistantScreen(),
          const AgentsScreen(),
          const DiscoverScreen(),
          const MemoryScreen(),
          const ArtifactsScreen(),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: palette.surface,
          border: Border(top: BorderSide(color: palette.border)),
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 62,
            child: Row(
              children: <Widget>[
                _item(0, Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, 'Chat'),
                _item(1, Icons.assistant_outlined, Icons.assistant, 'Helper'),
                _item(2, Icons.smart_toy_outlined, Icons.smart_toy, 'Agents'),
                _item(3, Icons.explore_outlined, Icons.explore, 'Discover'),
                _item(
                  4,
                  Icons.psychology_outlined,
                  Icons.psychology,
                  'Memory',
                  badge: studio.newCount,
                ),
                _item(5, Icons.layers_outlined, Icons.layers, 'Artifacts'),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _item(
    int index,
    IconData outline,
    IconData filled,
    String label, {
    int badge = 0,
  }) {
    final palette = context.palette;
    final active = _tab == index;
    final color = active ? palette.accentText : TeamlyColors.ink300;

    return Expanded(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => _go(index),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                Icon(active ? filled : outline, size: 22, color: color),
                if (badge > 0)
                  Positioned(right: -10, top: -7, child: TeamlyBadge(count: badge)),
              ],
            ),
            const SizedBox(height: 3),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}