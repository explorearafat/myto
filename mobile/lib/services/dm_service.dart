import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/widgets.dart';

/// ---------------------------------------------------------------------------
/// DmService — Firestore engine for 1:1 text chats (WhatsApp-style).
///
/// Data model (enforced by firestore.rules):
///
///   threads/{threadId}                     — threadId is "<uidA>:<uidB>" with the
///                                            two uids SORTED, so a pair always
///                                            maps to one thread and membership
///                                            is derivable from the id alone
///                                            (':' never appears in a uid).
///   threads/{threadId}/messages/{msgId}    — {from, text, seen, reply*?, createdAt}
///   threads/{threadId}/typing/{uid}        — {typing, at} — owner-only writes,
///                                            readers ignore stale docs
///   presence/{uid}                         — {online, lastSeen} — owner-only
/// ---------------------------------------------------------------------------
class DmThread {
  const DmThread({
    required this.id,
    required this.members,
    required this.lastText,
    required this.lastFrom,
    required this.lastAtMs,
  });

  final String id;
  final List<String> members;
  final String lastText;
  final String lastFrom;
  final int lastAtMs;

  /// The other participant (falls back to self for a malformed doc).
  String otherUid(String me) =>
      members.firstWhere((m) => m != me, orElse: () => me);

  static DmThread fromDoc(String id, Map<String, dynamic> d) {
    return DmThread(
      id: id,
      members: ((d['members'] ?? const <String>[]) as List)
          .whereType<String>()
          .toList(),
      lastText: (d['lastText'] ?? '') as String,
      lastFrom: (d['lastFrom'] ?? '') as String,
      lastAtMs: _ms(d['lastAt']),
    );
  }
}

class DmMessage {
  const DmMessage({
    required this.id,
    required this.from,
    required this.text,
    required this.seen,
    required this.replyToId,
    required this.replyText,
    required this.replyFrom,
    required this.createdAtMs,
    this.reactions = const <String, String>{},
  });

  final String id;
  final String from;
  final String text;
  final bool seen;
  final String replyToId;
  final String replyText;
  final String replyFrom;
  final int createdAtMs;

  /// Per-user emoji reaction: {uid: emoji}. One reaction per user — reacting
  /// again replaces it.
  final Map<String, String> reactions;

  bool get isReply => replyToId.isNotEmpty;

  static DmMessage fromDoc(String id, Map<String, dynamic> d) {
    final raw = (d['reactions'] ?? const <String, dynamic>{}) as Map<String, dynamic>;
    return DmMessage(
      id: id,
      from: (d['from'] ?? '') as String,
      text: (d['text'] ?? '') as String,
      seen: (d['seen'] ?? false) as bool,
      replyToId: (d['replyToId'] ?? '') as String,
      replyText: (d['replyText'] ?? '') as String,
      replyFrom: (d['replyFrom'] ?? '') as String,
      createdAtMs: _ms(d['createdAt']),
      reactions: raw.map((k, v) => MapEntry(k, '$v')),
    );
  }
}

/// The message retention window: every message self-destructs 24 hours after
/// it was sent (client sweeps + an optional Firestore TTL policy on
/// `expireAt` make it true even in the database).
const Duration kDmRetention = Duration(hours: 24);

/// One contact's presence: online right now, or when they were last seen.
class Presence {
  const Presence({required this.online, required this.lastSeenMs});

  final bool online;
  final int lastSeenMs;

  static Presence fromDoc(Map<String, dynamic> d) {
    return Presence(
      online: (d['online'] ?? false) as bool,
      lastSeenMs: _ms(d['lastSeen']),
    );
  }
}

int _ms(Object? value) {
  if (value is Timestamp) return value.millisecondsSinceEpoch;
  return 0;
}

/// Human "last seen" / "active" line for a chat header.
String presenceLine(Presence? p) {
  if (p == null) return 'offline';
  if (p.online) return 'online';
  if (p.lastSeenMs == 0) return 'offline';
  final diff = DateTime.now().millisecondsSinceEpoch - p.lastSeenMs;
  final s = diff ~/ 1000;
  if (s < 60) return 'last seen just now';
  if (s < 3600) return 'last seen ${s ~/ 60}m ago';
  if (s < 86400) return 'last seen ${s ~/ 3600}h ago';
  if (s < 604800) return 'last seen ${s ~/ 86400}d ago';
  final d = DateTime.fromMillisecondsSinceEpoch(p.lastSeenMs);
  return 'last seen ${d.day}/${d.month}/${d.year}';
}

class DmService {
  static FirebaseFirestore get _db => FirebaseFirestore.instance;

  /// Deterministic thread id for a pair of users (sorted, ':' separator).
  static String threadIdFor(String a, String b) {
    final ids = <String>[a, b]..sort();
    return ids.join(':');
  }

  /// Create the thread doc when it doesn't exist yet (owner-pinned by the rules).
  /// Sending later messages only touches the preview fields, so this must run
  /// once before the first message of a brand-new conversation.
  static Future<void> ensureThread(String me, String other) async {
    final ref = _db.collection('threads').doc(threadIdFor(me, other));
    final snap = await ref.get();
    if (snap.exists) return;
    await ref.set(<String, dynamic>{
      'members': <String>[me, other]..sort(),
    });
  }

  /// All of the user's conversations, newest activity first (sorted client-side —
  /// avoids the members+lastAt composite index).
  static Stream<List<DmThread>> streamThreads(String me) {
    return _db
        .collection('threads')
        .where('members', arrayContains: me)
        .limit(100)
        .snapshots()
        .map(
          (s) =>
              s.docs.map((d) => DmThread.fromDoc(d.id, d.data())).toList()
                ..sort((a, b) => b.lastAtMs.compareTo(a.lastAtMs)),
        );
  }

  /// Live messages of one thread, oldest first (the UI flips the list).
  static Stream<List<DmMessage>> streamMessages(String threadId) {
    return _db
        .collection('threads')
        .doc(threadId)
        .collection('messages')
        .orderBy('createdAt')
        .limit(300)
        .snapshots()
        .map((s) {
      final cutoff = DateTime.now().subtract(kDmRetention).millisecondsSinceEpoch;
      return s.docs
          .map((d) => DmMessage.fromDoc(d.id, d.data()))
          .where((m) => m.createdAtMs == 0 || m.createdAtMs >= cutoff)
          .toList();
    });
  }

  /// Send a text message (optionally replying to one) + advance the thread's
  /// preview, atomically. The thread must already exist ([ensureThread]).
  static Future<void> sendMessage({
    required String threadId,
    required String from,
    required String text,
    DmMessage? replyTo,
  }) async {
    final body = text.trim();
    if (body.isEmpty) return;
    final batch = _db.batch();
    batch.set(
      _db.collection('threads').doc(threadId).collection('messages').doc(),
      <String, dynamic>{
        'from': from,
        'text': body.substring(0, body.length.clamp(0, 4000)),
        'seen': false,
        if (replyTo != null) ...<String, dynamic>{
          'replyToId': replyTo.id,
          'replyText': replyTo.text,
          'replyFrom': replyTo.from,
        },
        'createdAt': FieldValue.serverTimestamp(),
        // The TTL field — a Firestore TTL policy on `expireAt` (collection
        // group `messages`) deletes aged-out messages in the database even
        // when neither participant opens the app again.
        'expireAt': Timestamp.fromDate(DateTime.now().add(kDmRetention)),
      },
    );
    batch.update(_db.collection('threads').doc(threadId), <String, dynamic>{
      'lastText': body.length > 120 ? body.substring(0, 120) : body,
      'lastFrom': from,
      'lastAt': FieldValue.serverTimestamp(),
    });
    await batch.commit();
  }

  /// Flip `seen` on the other participant's unread messages (the caller is the
  /// recipient — the rules only allow the non-author to raise `seen`). The
  /// author filter runs client-side to avoid a composite index.
  static Future<void> markSeen(String threadId, String myUid) async {
    final snap = await _db
        .collection('threads')
        .doc(threadId)
        .collection('messages')
        .where('seen', isEqualTo: false)
        .limit(50)
        .get();
    final others = snap.docs.where((d) => (d.data()['from'] ?? '') != myUid).toList();
    if (others.isEmpty) return;
    final batch = _db.batch();
    for (final d in others) {
      batch.update(d.reference, <String, dynamic>{'seen': true});
    }
    await batch.commit();
  }

  /// Toggle my emoji reaction on a message (stored in the message doc as
  /// reactions.<uid>; reacting again replaces the emoji, tapping the same one
  /// clears it). Needs the reactions rule — see firestore.rules.
  static Future<void> react(
    String threadId,
    String messageId,
    String uid,
    String emoji,
  ) async {
    await _db
        .collection('threads')
        .doc(threadId)
        .collection('messages')
        .doc(messageId)
        .set(<String, dynamic>{
      'reactions': <String, dynamic>{uid: emoji},
    }, SetOptions(merge: true));
  }

  /// Unsend: the author deletes their own message (the rules pin deletes to
  /// the author).
  static Future<void> unsendMessage(String threadId, String messageId) async {
    await _db
        .collection('threads')
        .doc(threadId)
        .collection('messages')
        .doc(messageId)
        .delete();
  }

  /// Delete MY messages in this thread that aged out (the rules pin message
  /// deletes to the author, so each participant sweeps their own half; paired
  /// with the TTL policy the database stays clean regardless).
  /// Returns how many were removed.
  static Future<int> sweepExpired(String threadId, String myUid) async {
    try {
      final snap = await _db
          .collection('threads')
          .doc(threadId)
          .collection('messages')
          .limit(300)
          .get();
      final cutoff = DateTime.now().subtract(kDmRetention).millisecondsSinceEpoch;
      final batch = _db.batch();
      var removed = 0;
      for (final doc in snap.docs) {
        final d = doc.data();
        if ((d['from'] ?? '') != myUid) continue;
        final at = _ms(d['createdAt']);
        if (at != 0 && at >= cutoff) continue;
        batch.delete(doc.reference);
        removed++;
      }
      if (removed > 0) await batch.commit();
      return removed;
    } on FirebaseException {
      return 0;
    }
  }

  /// Sweep every one of my threads for my aged-out messages (called when the
  /// messages list opens — keeps the database clean without opening a chat).
  static Future<void> sweepAllMine(String myUid) async {
    try {
      final threads = await _db
          .collection('threads')
          .where('members', arrayContains: myUid)
          .limit(100)
          .get();
      for (final t in threads.docs) {
        await sweepExpired(t.id, myUid);
      }
    } on FirebaseException {
      // Best-effort.
    }
  }

  /// The other participant's typing state, live. Emit null when idle.
  static Stream<bool> streamTyping(String threadId, String otherUid) {
    return _db
        .collection('threads')
        .doc(threadId)
        .collection('typing')
        .doc(otherUid)
        .snapshots()
        .map((d) {
          if (!d.exists) return false;
          final data = d.data() ?? <String, dynamic>{};
          if (data['typing'] != true) return false;
          // Stale heartbeat (app killed mid-typing) reads as idle.
          final at = _ms(data['at']);
          return DateTime.now().millisecondsSinceEpoch - at < 6000;
        });
  }

  /// Publish my typing state (throttled by the caller).
  static Future<void> setTyping(
    String threadId,
    String uid,
    bool typing,
  ) async {
    await _db
        .collection('threads')
        .doc(threadId)
        .collection('typing')
        .doc(uid)
        .set(<String, dynamic>{
          'typing': typing,
          'at': FieldValue.serverTimestamp(),
        });
  }

  /// Someone's presence, live.
  static Stream<Presence?> streamPresence(String uid) {
    return _db.collection('presence').doc(uid).snapshots().map(
          (d) => d.exists ? Presence.fromDoc(d.data() ?? <String, dynamic>{}) : null,
        );
  }

  /// Publish my own presence. Called by the app-lifecycle observer.
  static Future<void> setPresence(String uid, bool online) async {
    try {
      await _db.collection('presence').doc(uid).set(
            <String, dynamic>{
              'online': online,
              'lastSeen': FieldValue.serverTimestamp(),
            },
          );
    } on FirebaseException catch (_) {
      // Presence is best-effort (e.g. offline at pause time).
    }
  }
}

/// App-lifecycle → presence bridge. While any screen is showing, the signed-in
/// user broadcasts "online"; backgrounding flips them to offline + lastSeen.
class PresenceObserver with WidgetsBindingObserver {
  PresenceObserver(this._uid) {
    WidgetsBinding.instance.addObserver(this);
    _flush(true);
  }

  final String _uid;
  Timer? _heartbeat;

  void _flush(bool online) {
    DmService.setPresence(_uid, online);
  }

  /// Keep `lastSeen` fresh while the app sits in the foreground.
  void startHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(minutes: 2), (_) => _flush(true));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _flush(true);
      startHeartbeat();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _heartbeat?.cancel();
      _flush(false);
    }
  }

  void dispose() {
    _heartbeat?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _flush(false);
  }
}

/// Starts (or restarts) the presence bridge for the signed-in user. Called from
/// the app shell whenever the auth user changes.
PresenceObserver? _presenceObserver;

void bindPresenceToUser(User? user) {
  _presenceObserver?.dispose();
  _presenceObserver = null;
  if (user != null) {
    _presenceObserver = PresenceObserver(user.uid)..startHeartbeat();
  }
}
