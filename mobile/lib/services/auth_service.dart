import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';

/// Sign-in state, backed by the same Firebase project as the website (Google + GitHub).
///
/// Designed to degrade gracefully: if Firebase isn't configured yet (no real
/// firebase_options.dart / google-services.json), [firebaseReady] is false — the app still
/// runs in guest mode so a fresh clone works before you finish the Firebase console setup.
class AuthService extends ChangeNotifier {
  AuthService({required this.firebaseReady});

  /// True when Firebase.initializeApp succeeded at startup.
  final bool firebaseReady;

  User? _user;
  User? get user => _user;

  bool _guest = false;
  bool get isGuest => _guest;

  bool _busy = false;
  bool get busy => _busy;

  String? _error;
  String? get error => _error;

  /// Past the sign-in gate once there's a Firebase user or the person chose to skip.
  bool get isAuthed => _user != null || _guest;

  String get displayName {
    final name = _user?.displayName?.trim();
    if (name != null && name.isNotEmpty) return name;
    return _user?.email ?? 'Guest';
  }

  String? get email => _user?.email;
  String? get photoURL => _user?.photoURL;

  StreamSubscription<User?>? _sub;

  /// Begin listening to auth changes. No-op (guest-capable) when Firebase is off.
  void start() {
    if (!firebaseReady) return;
    _sub = FirebaseAuth.instance.authStateChanges().listen((u) {
      _user = u;
      if (u != null) _guest = false;
      notifyListeners();
    });
  }

  Future<void> signInWithGoogle() => _run(() async {
        final account = await GoogleSignIn().signIn();
        if (account == null) return; // user cancelled the picker
        final auth = await account.authentication;
        final credential = GoogleAuthProvider.credential(
          accessToken: auth.accessToken,
          idToken: auth.idToken,
        );
        await FirebaseAuth.instance.signInWithCredential(credential);
      });

  Future<void> signInWithGithub() => _run(() async {
        final provider = GithubAuthProvider()..addScope('read:user');
        await FirebaseAuth.instance.signInWithProvider(provider);
      });

  void continueAsGuest() {
    _guest = true;
    _error = null;
    notifyListeners();
  }

  Future<void> signOut() async {
    _error = null;
    if (firebaseReady) {
      try {
        await GoogleSignIn().signOut();
      } catch (_) {
        /* wasn't signed in via Google */
      }
      await FirebaseAuth.instance.signOut();
    }
    _user = null;
    _guest = false;
    notifyListeners();
  }

  Future<void> _run(Future<void> Function() action) async {
    if (!firebaseReady) {
      _error = 'Sign-in isn\'t set up yet. Finish the Firebase steps in the README, '
          'or continue without signing in.';
      notifyListeners();
      return;
    }
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      await action();
    } on FirebaseAuthException catch (e) {
      _error = _describe(e.code);
    } catch (_) {
      _error = 'Sign-in failed. Please try again.';
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  String? _describe(String code) {
    switch (code) {
      case 'web-context-canceled':
      case 'canceled':
      case 'cancelled':
        return null; // person backed out — no error banner
      case 'operation-not-allowed':
        return 'That sign-in method isn\'t enabled yet — turn it on in the Firebase console.';
      case 'account-exists-with-different-credential':
        return 'This email is already linked to a different sign-in method. Use that one.';
      case 'network-request-failed':
        return 'Network error during sign-in. Check your connection and try again.';
      default:
        return 'Sign-in failed. Please try again.';
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
