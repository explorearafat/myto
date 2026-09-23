import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sylor/app.dart';
import 'package:sylor/services/auth_service.dart';
import 'package:sylor/services/conversation_store.dart';

/// Smoke tests that don't touch the network or Firebase — they exercise the guest path, which is
/// exactly the fallback the app uses before Firebase is configured. Run with `flutter test`.
void main() {
  Future<(AuthService, ConversationStore)> buildServices({bool guest = false}) async {
    SharedPreferences.setMockInitialValues({});
    final store = ConversationStore();
    await store.load();
    final auth = AuthService(firebaseReady: false);
    if (guest) auth.continueAsGuest();
    return (auth, store);
  }

  testWidgets('signed-out users see the sign-in gate', (tester) async {
    final (auth, store) = await buildServices();
    await tester.pumpWidget(MytoApp(auth: auth, store: store));
    await tester.pump();

    expect(find.text('Myto'), findsWidgets);
    expect(find.text('Continue without signing in'), findsOneWidget);
  });

  testWidgets('a guest lands on the empty chat screen', (tester) async {
    final (auth, store) = await buildServices(guest: true);
    await tester.pumpWidget(MytoApp(auth: auth, store: store));
    await tester.pump();

    expect(find.text('How can I help today?'), findsOneWidget);
  });
}
