import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sylor/app.dart';
import 'package:sylor/services/auth_service.dart';
import 'package:sylor/services/byok_service.dart';
import 'package:sylor/services/conversation_store.dart';
import 'package:sylor/services/studio_store.dart';
import 'package:sylor/theme.dart';
import 'package:sylor/widgets/chat_empty_state.dart';

/// Smoke tests that don't touch the network or Firebase. Sign-in is required (there's no guest
/// mode), so with `firebaseReady: false` the gate resolves straight to the sign-in screen — the
/// one screen reachable without a real Firebase user. The blank-chat hero is exercised directly.
void main() {
  Future<({AuthService auth, ByokService byok, ConversationStore store, StudioStore studio})>
      buildServices() async {
    SharedPreferences.setMockInitialValues({});
    final store = ConversationStore();
    await store.load();
    final auth = AuthService(firebaseReady: false);
    auth.start(); // no Firebase → resolves immediately, so the gate shows the sign-in screen
    final byok = ByokService(firebaseReady: false);
    final studio = StudioStore();
    await studio.load();
    return (auth: auth, byok: byok, store: store, studio: studio);
  }

  testWidgets('signed-out users see the Google sign-in gate', (tester) async {
    final s = await buildServices();
    await tester.pumpWidget(MytoApp(auth: s.auth, byok: s.byok, store: s.store, studio: s.studio));
    await tester.pump();

    // The redesigned gate: heading + email form + the Google one-tap.
    expect(find.text('Create an account'), findsOneWidget);
    expect(find.text('Discover Myto'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Email address'), findsOneWidget);
  });

  testWidgets('the blank-chat hero greets by first name', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: mytoLightTheme(),
        home: const Scaffold(body: ChatEmptyState(firstName: 'Ada')),
      ),
    );
    await tester.pump();

    // Greeting is a random time-of-day phrase, but always "<phrase>, <name>" when a name is given.
    expect(find.textContaining('Ada'), findsOneWidget);
  });
}
