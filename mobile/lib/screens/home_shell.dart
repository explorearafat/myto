import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/call/call_service.dart';
import '../services/dm_service.dart';
import '../services/notification_service.dart';
import '../services/push_service.dart';
import '../theme.dart';
import '../widgets/teamly/kit.dart';
import 'agents_screen.dart';
import 'artifacts_screen.dart';
import 'call_screen.dart';
import 'call_tab.dart';
import 'chat_home_screen.dart';
import 'discover_screen.dart';
import 'incoming_call_screen.dart';
import 'settings_screen.dart';

/// HomeShell — the app's single bottom navigation, Teamly-style six tabs:
///
///   Chat (landing) · Call · Agents · Discover · Artifacts · Settings
///
/// The Chat tab is the home screen (agent list + groups + DMs + search).
/// Call is Myto Remote — calling the desktop agent with your voice.
/// Discover is the community feed — its header's back arrow returns here.
/// [IndexedStack] keeps every tab alive, and Android's system back walks home
/// first before it can leave the app. An incoming callback renders as a
/// full-screen overlay above any tab.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;
  bool _autoCallHandled = false;

  @override
  void initState() {
    super.initState();
    // Broadcast presence (online / last seen) for as long as the user is in-app.
    bindPresenceToUser(FirebaseAuth.instance.currentUser);
    // Engagement + follow notifications while the app is open (no badge —
    // the Discover header's bell shows them).
    NotificationService.instance.start();
    // FCM push: asks for the Android notification permission on first run and
    // keeps this device's token filed so system pushes arrive when closed.
    PushService.init();
    // Myto Remote: watch the desktop's presence + incoming callbacks while
    // signed in.
    final user = FirebaseAuth.instance.currentUser;
    if (user != null) CallService.instance.start(user);
    // Scan-to-pair: a myto://call deep link (QR scan on the desktop) arms the
    // auto-call; consume it here and dial immediately. The flag may already be
    // armed if the scan landed while signed-out (listener binds only now).
    CallService.instance.addListener(_consumeAutoCall);
    WidgetsBinding.instance.addPostFrameCallback((_) => _consumeAutoCall());
  }

  /// Pushes the call screen once for a pending QR-scan auto-call, then disarms.
  /// CallScreen's own mount logic dials — this only opens the screen.
  void _consumeAutoCall() {
    final service = CallService.instance;
    if (!service.autoCallPending || _autoCallHandled) return;
    if (service.phase != CallPhase.idle) {
      // A call is already live or winding down — the scan came too late.
      service.consumeAutoCall();
      return;
    }
    _autoCallHandled = true;
    service.consumeAutoCall();
    Navigator.of(context, rootNavigator: true)
        .push(MaterialPageRoute<void>(builder: (_) => const CallScreen()))
        .then((_) => _autoCallHandled = false);
  }

  @override
  void dispose() {
    CallService.instance.removeListener(_consumeAutoCall);
    super.dispose();
  }

  void _go(int i) {
    if (_tab == i) return;
    setState(() => _tab = i);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    // The incoming-call overlay listens to the call service directly.
    final incoming = context.select<CallService, bool>(
      (c) => c.phase == CallPhase.incoming,
    );

    return Stack(
      children: <Widget>[
        PopScope(
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
                const CallTab(),
                const AgentsScreen(),
                const DiscoverScreen(),
                const ArtifactsScreen(),
                const SettingsScreen(),
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
                      _item(1, Icons.call_outlined, Icons.call_rounded, 'Call'),
                      _item(2, Icons.smart_toy_outlined, Icons.smart_toy_rounded, 'Agents'),
                      _item(3, Icons.explore_outlined, Icons.explore_rounded, 'Discover'),
                      _item(4, Icons.layers_outlined, Icons.layers_rounded, 'Artifacts'),
                      _item(5, Icons.settings_outlined, Icons.settings_rounded, 'Settings'),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        // Full-screen incoming callback over whatever tab is open.
        if (incoming) const IncomingCallScreen(),
      ],
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
