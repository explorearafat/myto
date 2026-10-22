import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'app.dart';
import 'firebase_options.dart';
import 'services/auth_service.dart';
import 'services/byok_service.dart';
import 'services/conversation_store.dart';
import 'services/studio_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final firebaseReady = await _initFirebase();

  final auth = AuthService(firebaseReady: firebaseReady)..start();
  final byok = ByokService(firebaseReady: firebaseReady);
  final store = ConversationStore();
  await store.load();

  // The four-teamly tabs' data — seeded from the reference screenshots on first
  // run, then the user's own deltas persisted on-device.
  final studio = StudioStore();
  await studio.load();

  runApp(MytoApp(auth: auth, byok: byok, store: store, studio: studio));
}

Future<bool> _initFirebase() async {
  try {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    return true;
  } catch (_) {
    return false;
  }
}