import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/home_shell.dart';
import 'screens/sign_in_screen.dart';
import 'services/auth_service.dart';
import 'services/byok_service.dart';
import 'services/conversation_store.dart';
import 'services/studio_store.dart';
import 'theme.dart';

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

class _Gate extends StatelessWidget {
  const _Gate();

  @override
  Widget build(BuildContext context) {
    final resolved = context.select<AuthService, bool>((a) => a.resolved);
    // Hold a splash until the first auth state resolves, so a persisted session doesn't flash the
    // sign-in screen on a cold start (which invites a redundant, repeated sign-in).
    if (!resolved) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final authed = context.select<AuthService, bool>((a) => a.isAuthed);
    // Signed-in users land on the five-tab Teamly shell — Chat is the first tab,
    // exactly as the reference app opens on Chat.
    return authed ? const HomeShell() : const SignInScreen();
  }
}