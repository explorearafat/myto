import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';

import '../models/byok_config.dart';

/// Watches the signed-in user's bring-your-own-key config in Firestore (users/{uid}/config/byok)
/// and exposes it to the app. It re-subscribes whenever the signed-in user changes, so the model
/// list and endpoint always follow the account. When Firebase isn't ready or nobody is signed in,
/// [config] is null and [loading] is false.
class ByokService extends ChangeNotifier {
  ByokService({required this.firebaseReady}) {
    if (firebaseReady) {
      _authSub = FirebaseAuth.instance.authStateChanges().listen(_onUser);
    }
  }

  final bool firebaseReady;

  ByokConfig? _config;
  ByokConfig? get config => _config;

  bool _loading = false;
  bool get loading => _loading;

  bool get isConfigured => _config?.isConfigured ?? false;

  StreamSubscription<User?>? _authSub;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _docSub;

  void _onUser(User? user) {
    _docSub?.cancel();
    _docSub = null;
    if (user == null) {
      _config = null;
      _loading = false;
      notifyListeners();
      return;
    }
    _loading = true;
    notifyListeners();
    _docSub = FirebaseFirestore.instance
        .collection('users')
        .doc(user.uid)
        .collection('config')
        .doc('byok')
        .snapshots()
        .listen(
      (snap) {
        final data = snap.data();
        _config = data != null ? ByokConfig.fromJson(data) : null;
        _loading = false;
        notifyListeners();
      },
      onError: (_) {
        // Offline, or rules not published yet — treat as "no config" so the UI can prompt setup.
        _config = null;
        _loading = false;
        notifyListeners();
      },
    );
  }

  @override
  void dispose() {
    _authSub?.cancel();
    _docSub?.cancel();
    super.dispose();
  }
}
