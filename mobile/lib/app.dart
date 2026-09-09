import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/chat_screen.dart';
import 'screens/sign_in_screen.dart';
import 'services/auth_service.dart';
import 'services/conversation_store.dart';
import 'theme.dart';

/// The app root: wires the two long-lived services into the widget tree, applies Sylor's
/// light/dark themes (following the system setting), and gates on sign-in.
class SylorApp extends StatelessWidget {
  const SylorApp({super.key, required this.auth, required this.store});

  final AuthService auth;
  final ConversationStore store;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthService>.value(value: auth),
        ChangeNotifierProvider<ConversationStore>.value(value: store),
      ],
      child: MaterialApp(
        title: 'Sylor',
        debugShowCheckedModeBanner: false,
        theme: sylorLightTheme(),
        darkTheme: sylorDarkTheme(),
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
    final authed = context.select<AuthService, bool>((a) => a.isAuthed);
    return authed ? const ChatScreen() : const SignInScreen();
  }
}
