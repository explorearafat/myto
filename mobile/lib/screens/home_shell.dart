import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/dm_service.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'agents_screen.dart';
import 'artifacts_screen.dart';
import 'assistant_screen.dart';
import 'chat_screen.dart';
import 'dm_list_screen.dart';
import 'discover_screen.dart';
import 'memory_screen.dart';
import 'post_composer_page.dart';
import 'profile_screen.dart';
import 'search_screen.dart';

/// HomeShell — the app's single bottom navigation, Myto-community style:
///
///   Home(Discover) · Search · DM ·  Post  · Profile
///
/// Home IS the Discover feed (like a social app's home timeline). The AI
/// tools (AI Chat / Helper / Agents / Memory / Artifacts) live behind the
/// Discover header's back button (a tools menu) and in the Profile tab's
/// tool list — nothing from the old six-tab shell is lost. [IndexedStack]
/// keeps every tab alive.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    // Broadcast presence (online / last seen) for as long as the user is in-app.
    bindPresenceToUser(FirebaseAuth.instance.currentUser);
  }

  void _go(int i) {
    if (_tab == i) return;
    setState(() => _tab = i);
  }

  Future<void> _openComposer() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PostComposerPage(
          onPosted: () {
            if (!mounted) return;
            ScaffoldMessenger.of(context)
              ..hideCurrentSnackBar()
              ..showSnackBar(
                const SnackBar(content: Text('Posted to Discover.')),
              );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final studio = context.watch<StudioStore>();

    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: <Widget>[
          DiscoverScreen(onOpenTools: _openTools),
          const SearchScreen(),
          const DmListScreen(),
          const ProfileScreen(),
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
            height: 64,
            child: Row(
              children: <Widget>[
                _item(0, Icons.home_outlined, Icons.home_rounded, 'Home'),
                _item(1, Icons.search_rounded, Icons.search_rounded, 'Search'),
                _item(2, Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, 'DM'),
                _postButton(),
                _item(3, Icons.person_outline_rounded, Icons.person_rounded, 'Profile',
                    badge: studio.newCount),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The back arrow on Discover's header opens the tools menu (AI Chat and the
  /// four inner tools from the old shell).
  void _openTools() {
    final palette = context.palette;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Padding(
              padding: EdgeInsets.all(TeamlySpace.s4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'Myto tools',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
                ),
              ),
            ),
            _tool(sheetContext, context, Icons.chat_bubble_outline_rounded, 'AI Chat',
                'Talk with your models', const ChatScreen()),
            _tool(sheetContext, context, Icons.assistant_outlined, 'Helper', 'Your AI assistant',
                const AssistantScreen()),
            _tool(sheetContext, context, Icons.smart_toy_outlined, 'Agents', 'Create and run agents',
                const AgentsScreen()),
            _tool(sheetContext, context, Icons.psychology_outlined, 'Memory', 'What Myto remembers',
                const MemoryScreen()),
            _tool(sheetContext, context, Icons.layers_outlined, 'Artifacts', 'Generated media & files',
                const ArtifactsScreen()),
            const SizedBox(height: TeamlySpace.s2),
          ],
        ),
      ),
    );
  }

  Widget _tool(
    BuildContext sheetContext,
    BuildContext appContext,
    IconData icon,
    String title,
    String subtitle,
    Widget screen,
  ) {
    final palette = appContext.palette;
    return ListTile(
      leading: Container(
        width: 40,
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: palette.tagBg,
          borderRadius: BorderRadius.circular(TeamlyRadius.sm),
        ),
        child: Icon(icon, size: 20, color: palette.tagFg),
      ),
      title: Text(
        title,
        style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: TeamlyColors.ink900),
      ),
      subtitle: Text(subtitle, style: const TextStyle(fontSize: 12.5, color: TeamlyColors.ink500)),
      onTap: () {
        Navigator.of(sheetContext).pop();
        Navigator.of(appContext).push(MaterialPageRoute<void>(builder: (_) => screen));
      },
    );
  }

  /// The center Post action — a raised green disc, visually distinct from tabs.
  Widget _postButton() {
    final palette = context.palette;
    return Expanded(
      child: Center(
        child: GestureDetector(
          onTap: _openComposer,
          child: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: palette.accent,
              shape: BoxShape.circle,
              boxShadow: TeamlyElevation.green,
            ),
            child: const Icon(Icons.add_rounded, size: 26, color: Colors.white),
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
