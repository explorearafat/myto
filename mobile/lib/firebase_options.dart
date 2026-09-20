import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;


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
        return web;
    }
  }

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
    authDomain: 'sylor-29cab.firebaseapp.com',
    projectId: 'sylor-29cab',
    storageBucket: 'sylor-29cab.firebasestorage.app',
    messagingSenderId: '148077878463',
    appId: '1:148077878463:web:e197d280d4a5967085fa0a',
    measurementId: 'G-9PT834YQYL',
  );

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyCLUPgeIy_gp9M5hkjHxbj1ohMoGQ4HpRQ',
    authDomain: 'sylor-29cab.firebaseapp.com',
    projectId: 'sylor-29cab',
    storageBucket: 'sylor-29cab.firebasestorage.app',
    messagingSenderId: '148077878463',
    appId: '1:148077878463:web:e197d280d4a5967085fa0a',
  );

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
