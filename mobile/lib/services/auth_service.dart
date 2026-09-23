import 'dart:async';
import 'dart:math';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

/// Sign-in state, backed by the same Firebase project as the website.
///
/// Google blocks its OAuth screen inside app webviews (`disallowed_useragent`), so we never
/// sign in on-device. Instead [signInWithGoogle] opens a real browser (a Custom Tab) at the
/// website's broker page, which runs Google sign-in and relays Google's OIDC ID token back to
/// the `sylor://auth-callback` deep link; we finish locally with [signInWithCredential]. That
/// needs no native google_sign_in plugin, google-services.json, SHA-1, or release keystore.
///
/// Sign-in is required to use the app — there is no guest mode.
class AuthService extends ChangeNotifier {
  AuthService({required this.firebaseReady});

  /// The website page that runs Google sign-in and relays the token back to us.
  static const _brokerUrl = 'https://mytocode.vercel.app/authentication';

  /// The custom scheme the broker redirects to; must match the Android manifest's
  /// CallbackActivity `<data android:scheme>` and the `sylor://` the broker builds.
  static const _callbackScheme = 'sylor';

  /// True when Firebase.initializeApp succeeded at startup.
  final bool firebaseReady;

  User? _user;
  User? get user => _user;

  bool _busy = false;
  bool get busy => _busy;

  String? _error;
  String? get error => _error;

  /// Past the sign-in gate once there's a Firebase user.
  bool get isAuthed => _user != null;

  /// False until the first auth state has resolved after launch. The gate shows a splash while this
  /// is false so a persisted session never flashes the sign-in screen on a cold start.
  bool _resolved = false;
  bool get resolved => _resolved;

  String get displayName {
    final name = _user?.displayName?.trim();
    if (name != null && name.isNotEmpty) return name;
    return _user?.email ?? 'You';
  }

  String? get email => _user?.email;
  String? get photoURL => _user?.photoURL;

  StreamSubscription<User?>? _sub;

  /// Begin listening to auth changes. When Firebase failed to initialise there's nothing to restore,
  /// so we resolve immediately (the gate falls through to the sign-in screen).
  void start() {
    if (!firebaseReady) {
      _resolved = true;
      notifyListeners();
      return;
    }
    _sub = FirebaseAuth.instance.authStateChanges().listen((u) {
      _user = u;
      _resolved = true;
      notifyListeners();
    });
  }

  Future<void> signInWithGoogle() => _run(() async {
        final idToken = await _relayGoogleIdToken();
        final credential = GoogleAuthProvider.credential(idToken: idToken);
        await FirebaseAuth.instance.signInWithCredential(credential);
      });

  /// Opens the Myto website in a Custom Tab to run Google sign-in in a real browser, then
  /// reads back the relayed OIDC ID token from the `sylor://auth-callback` deep link. A random
  /// `state` is round-tripped and re-checked so we reject any callback we didn't initiate. See
  /// the website's AuthBroker page for the other half of this handshake.
  Future<String> _relayGoogleIdToken() async {
    final state = _nonce();
    final url = Uri.parse(_brokerUrl).replace(
      queryParameters: {'platform': 'mobile', 'state': state},
    );
    final callback = await FlutterWebAuth2.authenticate(
      url: url.toString(),
      callbackUrlScheme: _callbackScheme,
    );
    final params = Uri.parse(callback).queryParameters;
    if (params['state'] != state) {
      throw const _SignInError('Sign-in couldn\'t be verified. Please try again.');
    }
    final idToken = params['id_token'];
    if (idToken == null || idToken.isEmpty) {
      throw const _SignInError('Sign-in didn\'t return a token. Please try again.');
    }
    return idToken;
  }

  /// A 128-bit hex nonce, used as the OAuth `state` to tie a callback to this request.
  static String _nonce() {
    final rand = Random.secure();
    final bytes = List<int>.generate(16, (_) => rand.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  Future<void> signOut() async {
    _error = null;
    if (firebaseReady) {
      await FirebaseAuth.instance.signOut();
    }
    _user = null;
    notifyListeners();
  }

  Future<void> _run(Future<void> Function() action) async {
    if (!firebaseReady) {
      _error = 'Sign-in isn\'t available right now. Please update Myto and try again.';
      notifyListeners();
      return;
    }
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      await action();
    } on _SignInError catch (e) {
      _error = e.message;
    } on FirebaseAuthException catch (e) {
      _error = _describe(e.code);
    } on PlatformException catch (e) {
      // flutter_web_auth_2 throws CANCELED when the person closes the browser tab.
      _error = e.code == 'CANCELED' ? null : 'Sign-in failed. Please try again.';
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
        return 'Google sign-in isn\'t enabled yet — turn it on in the Firebase console.';
      case 'account-exists-with-different-credential':
        return 'This email is already linked to a different sign-in method. Use that one.';
      case 'invalid-credential':
        return 'That sign-in didn\'t go through. Please try again.';
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

/// A sign-in failure carrying a ready-to-show message. Thrown for our own checks (a mismatched
/// `state` or a missing token in the callback) so [AuthService._run] can surface it verbatim.
class _SignInError implements Exception {
  const _SignInError(this.message);
  final String message;
}
