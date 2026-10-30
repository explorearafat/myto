import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// ---------------------------------------------------------------------------
/// PushService — real system-tray push notifications (FCM), WhatsApp-style:
/// a message or reaction reaches the phone as a notification even when the
/// app is closed.
///
/// How it works with NO paid server:
///   1. This device asks for the Android 13+ notification permission (the
///      "app install korle notification permission ney" prompt), reads its FCM
///      token and files it under users/{uid}/config/fcmTokens.
///   2. When the user sends a DM / likes / comments / shares / follows, the
///      ACTOR's device calls the website's api/notify endpoint with their own
///      sign-in token. That endpoint (running on the user's own Vercel) looks
///      up the recipient's tokens (admin access) and sends the FCM push.
///   3. Android shows `notification` payloads in the system tray automatically
///      while the app is backgrounded or closed; in the foreground the app
///      still renders everything in-app (bell + badges), so no double bubbles.
/// ---------------------------------------------------------------------------
/// Background entry point — required for FCM data messages while the app is
/// terminated. `notification` payloads show in the system tray automatically;
/// this handles anything extra later.
@pragma('vm:entry-point')
Future<void> fcmBackgroundHandler(RemoteMessage message) async {
  // Intentionally empty: notification payloads render without it. Present so
  // data-only pushes and future deep-linking have a registered entry point.
}

class PushService {
  PushService._();

  static const String _notifyUrl = 'https://mytocode.vercel.app/api/notify';

  static bool _started = false;

  /// Ask for the notification permission (first launch shows the Android
  /// dialog), read the FCM token and keep it filed under the signed-in user.
  /// Safe to call on every app start; the dialog shows once.
  static Future<void> init() async {
    if (_started) return;
    _started = true;
    try {
      final messaging = FirebaseMessaging.instance;
      await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      await _fileToken(await messaging.getToken());
      // Token rotation (app restore, instance churn) re-files automatically.
      FirebaseMessaging.instance.onTokenRefresh.listen((token) {
        _fileToken(token);
      });
      FirebaseMessaging.onBackgroundMessage(fcmBackgroundHandler);
    } catch (_) {
      // Push is an enhancement — a permission denial or a failed token fetch
      // must never break app startup.
    }
  }

  /// File the device token under the signed-in user (owner-writable config
  /// doc; the notify endpoint reads it with admin access).
  static Future<void> _fileToken(String? token) async {
    final user = FirebaseAuth.instance.currentUser;
    if (token == null || token.isEmpty || user == null) return;
    try {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(user.uid)
          .collection('config')
          .doc('fcmTokens')
          .set(<String, dynamic>{
        'tokens': <String, dynamic>{
          token: <String, dynamic>{
            'platform': defaultTargetPlatform.name,
            'at': FieldValue.serverTimestamp(),
          },
        }
      }, SetOptions(merge: true));
    } on FirebaseException {
      // Best-effort.
    }
  }

  /// Ask the site's notify endpoint to deliver a system push to [toUid].
  /// Fire-and-forget: a failed push never affects the action that caused it.
  static Future<void> pushTo({
    required String toUid,
    required String kind,
    required String title,
    required String body,
    Map<String, String> data = const <String, String>{},
  }) async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null || toUid.isEmpty) return;
    try {
      final idToken = await user.getIdToken();
      if (idToken == null) return;
      await http.post(
        Uri.parse(_notifyUrl),
        headers: const {'content-type': 'application/json'},
        body: jsonEncode(<String, dynamic>{
          'idToken': idToken,
          'toUid': toUid,
          'kind': kind,
          'title': title,
          'body': body.length > 240 ? '${body.substring(0, 240)}…' : body,
          'data': data,
        }),
      ).timeout(const Duration(seconds: 10));
    } catch (_) {
      // Fire-and-forget.
    }
  }
}
