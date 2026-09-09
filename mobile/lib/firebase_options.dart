// Firebase configuration for Sylor mobile — a hand-written stand-in for the file that
// `flutterfire configure` generates.
//
// The [web] block carries Sylor's *public* Firebase Web config (project sylor-29cab) — the very
// same values the website ships (see ../../src/lib/firebase.ts). These are safe to commit and to
// ship in a client: access is enforced by which providers are enabled, by the Authorized Domains
// list, and by the Firestore security rules — never by keeping these strings secret.
//
// Android and iOS have NO real options here yet. Until you run `flutterfire configure` from the
// mobile/ directory (which overwrites this file and drops google-services.json /
// GoogleService-Info.plist into place), those platforms throw below — main.dart catches it and the
// app simply runs in guest mode. See mobile/README.md → "Enable sign-in (optional)".

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show kIsWeb;

/// Default [FirebaseOptions] for the current platform, mirroring FlutterFire's generated API so a
/// later `flutterfire configure` is a drop-in replacement.
class DefaultFirebaseOptions {
  const DefaultFirebaseOptions._();

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) return web;
    // No native (Android/iOS/…) options are baked in yet. `flutterfire configure` overwrites this
    // file with real ones; until then this throws and main.dart falls back to guest mode.
    throw UnsupportedError(
      'Firebase is not configured for this platform yet. Run `flutterfire configure` from the '
      'mobile/ directory to generate real options (see README.md). Until then, Sylor runs in '
      'guest mode.',
    );
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
}
