import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/dm_service.dart';
import '../services/studio_store.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'dm_list_screen.dart';
import 'discover_screen.dart';
import 'post_composer_page.dart';
import 'profile_screen.dart';
import 'search_screen.dart';
import 'tools_hub_screen.dart';

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

  /// The back arrow on Discover's header opens the full-screen tools hub —
  /// the original Myto screens (AI Chat, Agents, Helper, Memory, Artifacts).
  void _openTools() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const ToolsHubScreen()),
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
