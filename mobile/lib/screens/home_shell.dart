import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/dm_service.dart';
import '../services/notification_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'agents_screen.dart';
import 'artifacts_screen.dart';
import 'chat_home_screen.dart';
import 'discover_screen.dart';

/// HomeShell — the app's single bottom navigation, Teamly-style four tabs:
///
///   Chat (landing) · Agents · Discover · Artifacts
///
/// The Chat tab is the home screen (agent list + groups + DMs + search).
/// Discover is the community feed — its header's back arrow returns here.
/// [IndexedStack] keeps every tab alive, and Android's system back walks home
/// first before it can leave the app.
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
    // Engagement + follow notifications while the app is open (no badge —
    // the Discover header's bell shows them).
    NotificationService.instance.start();
  }

  void _go(int i) {
    if (_tab == i) return;
    setState(() => _tab = i);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;

    return PopScope(
      // System back from any non-home tab walks home first; from the Chat tab
      // it may leave the app as usual.
      canPop: _tab == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _go(0);
      },
      child: Scaffold(
        body: IndexedStack(
          index: _tab,
          children: <Widget>[
            const ChatHomeScreen(),
            const AgentsScreen(),
            DiscoverScreen(onBack: () => _go(0)),
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
              height: 64,
              child: Row(
                children: <Widget>[
                  _item(0, Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, 'Chat'),
                  _item(1, Icons.smart_toy_outlined, Icons.smart_toy_rounded, 'Agents'),
                  _item(2, Icons.explore_outlined, Icons.explore_rounded, 'Discover'),
                  _item(3, Icons.layers_outlined, Icons.layers_rounded, 'Artifacts'),
                ],
              ),
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
