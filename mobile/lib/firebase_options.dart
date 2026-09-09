// Firebase configuration for Sylor mobile — a hand-written stand-in for the file that
// `flutterfire configure` generates.
//
// Every block carries Sylor's *public* Firebase config (project sylor-29cab) — the very same
// values the website ships (see ../../src/lib/firebase.ts). These are safe to commit and to ship
// in a client: access is enforced by which providers are enabled, by the Authorized Domains list,
// and by the Firestore security rules — never by keeping these strings secret.
//
// Sign-in on mobile uses Firebase's browser (Custom Tab) federated flow (signInWithProvider), which
// authenticates against the hosted handler at sylor-29cab.firebaseapp.com. That flow needs a valid
// FirebaseApp but NOT a google-services.json, an Android OAuth client, or a SHA-1 fingerprint — so
// these Dart options are enough to make Google + GitHub work in the release APK.

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;

/// Default [FirebaseOptions] for the current platform, mirroring FlutterFire's generated API so a
/// later `flutterfire configure` is a drop-in replacement.
class DefaultFirebaseOptions {
  const DefaultFirebaseOptions._();

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) return web;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        // Desktop targets aren't shipped; fall back to the web config so a dev run doesn't crash.
        return web;
    }
  }

  /// Sylor's public Firebase Web config (project sylor-29cab). Safe to commit — not a secret.
  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
    authDomain: 'sylor-29cab.firebaseapp.com',
    projectId: 'sylor-29cab',
    storageBucket: 'sylor-29cab.firebasestorage.app',
    messagingSenderId: '148077878463',
    appId: '1:148077878463:web:e197d280d4a5967085fa0a',
    measurementId: 'G-9PT834YQYL',
  );

  /// Android options. Enough for the Custom Tab federated sign-in flow (see file header).
  ///
  /// NOTE on [appId]: this reuses the Web appId. The browser sign-in flow is REST + the hosted
  /// OAuth handler and does not depend on the appId's platform, so it works with this value. If you
  /// register a dedicated Android app in the Firebase console (package `com.sylor.sylor`) —
  /// recommended before a Play Store release, and required if you ever switch to the *native*
  /// Google SDK — replace this with the real `1:148077878463:android:…` id, or just run
  /// `flutterfire configure`, which overwrites this whole file.
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
    authDomain: 'sylor-29cab.firebaseapp.com',
    projectId: 'sylor-29cab',
    storageBucket: 'sylor-29cab.firebasestorage.app',
    messagingSenderId: '148077878463',
    appId: '1:148077878463:web:e197d280d4a5967085fa0a',
  );

  /// iOS options (parity; the shipped build is Android-only). Same caveat as [android] re: appId.
  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
    authDomain: 'sylor-29cab.firebaseapp.com',
    projectId: 'sylor-29cab',
    storageBucket: 'sylor-29cab.firebasestorage.app',
    messagingSenderId: '148077878463',
    appId: '1:148077878463:web:e197d280d4a5967085fa0a',
    iosBundleId: 'com.sylor.sylor',
  );
}
