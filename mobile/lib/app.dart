import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/home_shell.dart';
import 'screens/sign_in_screen.dart';
import 'services/auth_service.dart';
import 'services/byok_service.dart';
import 'services/call/call_service.dart';
import 'services/conversation_store.dart';
import 'services/studio_store.dart';
import 'services/team_chat_store.dart';
import 'theme.dart';

/// Scan-to-pair: the desktop's Settings › Calls shows a QR encoding
/// `myto://call`. Scanning it with the phone's camera opens (or foregrounds)
/// the app — this listener catches the link in EVERY state (cold start,
/// signed-out, signed-in) and arms the auto-call; HomeShell consumes it once
/// the user is actually in the shell, pushing the CallScreen.
StreamSubscription<Uri>? _linkSub;

void _bindCallDeepLinks() {
  final links = AppLinks();
  // Cold start: the app was launched BY the scan.
  links.getInitialLink().then((uri) {
    if (uri?.host == 'call') CallService.instance.requestAutoCall();
  }).catchError((_) => null);
  // Warm start: the app was already running when the scan landed.
  _linkSub ??= links.uriLinkStream.listen((uri) {
    if (uri.host == 'call') CallService.instance.requestAutoCall();
  }, onError: (_) {});
}

class MytoApp extends StatelessWidget {
  const MytoApp({
    super.key,
    required this.auth,
    required this.byok,
    required this.store,
    required this.studio,
  });

  final AuthService auth;
  final ByokService byok;
  final ConversationStore store;
  final StudioStore studio;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthService>.value(value: auth),
        ChangeNotifierProvider<ByokService>.value(value: byok),
        ChangeNotifierProvider<ConversationStore>.value(value: store),
        ChangeNotifierProvider<StudioStore>.value(value: studio),
        ChangeNotifierProvider<TeamChatStore>.value(
          value: TeamChatStore(store, studio),
        ),
        // Myto Remote voice calls (singleton service — presence watch, WebRTC
        // peer, STT, and the call state machine live here).
        ChangeNotifierProvider<CallService>.value(value: CallService.instance),
      ],
      child: MaterialApp(
        title: 'Myto',
        debugShowCheckedModeBanner: false,
        theme: mytoLightTheme(),
        darkTheme: mytoDarkTheme(),
        themeMode: ThemeMode.system,
        home: const _Gate(),
      ),
    );
  }
}

/// The deep-link binding must live above the auth gate so a QR scan that COLD
/// STARTS the app (even signed-out) is captured; the pending flag survives
/// until the shell consumes it. Bound once, first build.
bool _linksBound = false;

class _Gate extends StatefulWidget {
  const _Gate();

  @override
  State<_Gate> createState() => _GateState();
}

class _GateState extends State<_Gate> {
  @override
  void initState() {
    super.initState();
    if (!_linksBound) {
      _linksBound = true;
      _bindCallDeepLinks();
    }
  }

  @override
  Widget build(BuildContext context) {
    final resolved = context.select<AuthService, bool>((a) => a.resolved);
    // Hold a splash until the first auth state resolves, so a persisted session doesn't flash the
    // sign-in screen on a cold start (which invites a redundant, repeated sign-in).
    if (!resolved) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final authed = context.select<AuthService, bool>((a) => a.isAuthed);
    // Signed-in users land on the six-tab Teamly shell — Chat is the first tab,
    // exactly as the reference app opens on Chat.
    return authed ? const HomeShell() : const SignInScreen();
  }
}