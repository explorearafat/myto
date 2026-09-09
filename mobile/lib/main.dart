import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'app.dart';
import 'firebase_options.dart';
import 'services/auth_service.dart';
import 'services/conversation_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Try to bring up Firebase. If it isn't configured yet (a fresh clone with no real
  // firebase_options.dart / google-services.json), fall back to guest-only mode instead of
  // crashing — the chat itself doesn't require Firebase; sign-in is UX parity with the website.
  final firebaseReady = await _initFirebase();

  final auth = AuthService(firebaseReady: firebaseReady)..start();
  final store = ConversationStore();
  await store.load();

  runApp(SylorApp(auth: auth, store: store));
}

Future<bool> _initFirebase() async {
  try {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    return true;
  } catch (_) {
    return false;
  }
}
