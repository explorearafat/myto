import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/chat_screen.dart';
import 'screens/sign_in_screen.dart';
import 'services/auth_service.dart';
import 'services/byok_service.dart';
import 'services/conversation_store.dart';
import 'theme.dart';

class MytoApp extends StatelessWidget {
  const MytoApp({super.key, required this.auth, required this.byok, required this.store});

  final AuthService auth;
  final ByokService byok;
  final ConversationStore store;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthService>.value(value: auth),
        ChangeNotifierProvider<ByokService>.value(value: byok),
        ChangeNotifierProvider<ConversationStore>.value(value: store),
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
    return authed ? const ChatScreen() : const SignInScreen();
  }
}
