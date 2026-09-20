import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'app.dart';
import 'firebase_options.dart';
import 'services/auth_service.dart';
import 'services/byok_service.dart';
import 'services/conversation_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final firebaseReady = await _initFirebase();

  final auth = AuthService(firebaseReady: firebaseReady)..start();
  final byok = ByokService(firebaseReady: firebaseReady);
  final store = ConversationStore();
  await store.load();

  runApp(SylorApp(auth: auth, byok: byok, store: store));
}

Future<bool> _initFirebase() async {
  try {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    return true;
  } catch (_) {
    return false;
  }
}
