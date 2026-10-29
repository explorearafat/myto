import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// ---------------------------------------------------------------------------
/// NotificationService — in-app notifications for the social feed.
///
/// Two watchers run while the user is signed in (started from HomeShell):
///
///   1. My-posts watcher — streams MY posts; when likeCount/commentCount/
///      shareCount climbs, it diffs the post's likes/comments/shares
///      subcollections (public-read) for the new actors and files a
///      notification per actor (never for myself).
///   2. Followed-users watcher — when someone I follow publishes a new post,
///      files a "posted" notification.
///
/// Notifications are stored as docs under users/{myUid}/config/notif:<id> —
/// a location the security rules already let only me write, so no rules
/// change is needed and no one else can forge my notifications. The Settings
/// screen (Artifacts tab) toggles each category on/off; the toggles live in
/// shared_preferences under `sylor.notify.<kind>`.
/// ---------------------------------------------------------------------------
class AppNotification {
  const AppNotification({
    required this.id,
    required this.kind, // like | comment | share | post
    required this.fromUid,
    required this.fromName,
    required this.fromPhoto,
    required this.postId,
    required this.postPreview,
    required this.snippet,
    required this.atMs,
    required this.read,
  });

  final String id;
  final String kind;
  final String fromUid;
  final String fromName;
  final String fromPhoto;
  final String postId;
  final String postPreview;
  final String snippet;
  final int atMs;
  final bool read;

  static AppNotification fromDoc(String id, Map<String, dynamic> d) => AppNotification(
        id: id,
        kind: (d['kind'] ?? '') as String,
        fromUid: (d['fromUid'] ?? '') as String,
        fromName: (d['fromName'] ?? 'Someone') as String,
        fromPhoto: (d['fromPhoto'] ?? '') as String,
        postId: (d['postId'] ?? '') as String,
        postPreview: (d['postPreview'] ?? '') as String,
        snippet: (d['snippet'] ?? '') as String,
        atMs: ((d['at'] as Timestamp?)?.millisecondsSinceEpoch) ?? 0,
        read: d['read'] == true,
      );

  Map<String, dynamic> toMap() => <String, dynamic>{
        'kind': kind,
        'fromUid': fromUid,
        'fromName': fromName,
        'fromPhoto': fromPhoto,
        'postId': postId,
        'postPreview': postPreview,
        'snippet': snippet,
        'at': FieldValue.serverTimestamp(),
        'read': false,
      };

  /// "Asha liked your post" / "Asha commented: …" / "Asha posted: …"
  String headline() {
    final who = fromName.isEmpty ? 'Someone' : fromName;
    switch (kind) {
      case 'like':
        return '$who liked your post';
      case 'comment':
        return '$who commented: $snippet';
      case 'share':
        return '$who shared your post';
      case 'post':
        return '$who posted: $snippet';
      default:
        return who;
    }
  }
}

class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  StreamSubscription? _postsSub;
  StreamSubscription? _followSub;
  String? _uid;
  Timer? _debounce;

  /// Baselines per post id: the counters the watchers last saw. The FIRST
  /// snapshot only sets the baseline (no retroactive notifications for
  /// history).
  final Map<String, List<int>> _counters = <String, List<int>>{}; // [likes, comments, shares]
  final Set<String> _seenCommentIds = <String>{};
  final Set<String> _seenActorIds = <String>{};
  final Set<String> _seenPostIds = <String>{};
  DateTime? _startedAt;

  /// Settings toggles (Settings → Artifacts tab → Social). Default: all on.
  Future<bool> _enabled(String kind) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool('sylor.notify.$kind') ?? true;
  }

  void start() {
    final user = FirebaseAuth.instance.currentUser;
    final uid = user?.uid ?? '';
    if (uid.isEmpty || uid == _uid) return;
    stop();
    _uid = uid;
    _startedAt = DateTime.now();
    _counters.clear();
    _seenPostIds.clear();

    // ── Watcher 1: engagement on MY posts ────────────────────────────────────
    _postsSub = FirebaseFirestore.instance
        .collection('posts')
        .where('uid', isEqualTo: uid)
        .limit(50)
        .snapshots()
        .listen((snap) {
      // A short debounce folds bursts of counter writes into one sweep.
      _debounce?.cancel();
      _debounce = Timer(const Duration(seconds: 3), () => _sweepMyPosts(snap.docs));
    });

    // ── Watcher 2: new posts from people I follow ────────────────────────────
    _watchFollowedPosts();
  }

  void stop() {
    _postsSub?.cancel();
    _followSub?.cancel();
    _debounce?.cancel();
    _postsSub = null;
    _followSub = null;
    _uid = null;
  }

  Future<void> _sweepMyPosts(List<QueryDocumentSnapshot<Map<String, dynamic>>> docs) async {
    final uid = _uid;
    if (uid == null) return;
    for (final doc in docs) {
      final d = doc.data();
      final likes = ((d['likeCount'] ?? 0) as num).toInt();
      final comments = ((d['commentCount'] ?? 0) as num).toInt();
      final shares = ((d['shareCount'] ?? 0) as num).toInt();
      final baseline = _counters[doc.id];
      if (baseline == null) {
        // First sight — baseline only. Likes/shares docs carry no timestamps,
        // so pre-seed the "already seen" actor sets with the CURRENT actors:
        // nobody gets retroactive notifications for old engagement.
        _counters[doc.id] = <int>[likes, comments, shares];
        if (likes > 0) await _seedSeen(uid, doc.id, 'likes');
        if (shares > 0) await _seedSeen(uid, doc.id, 'shares');
        continue;
      }
      _counters[doc.id] = <int>[likes, comments, shares];
      final postPreview = ((d['text'] ?? '') as String)
          .replaceAll('\n', ' ')
          .replaceAll(RegExp(r'\[\[crypto:[^\]]+\]\]'), '')
          .trim();
      if (comments > baseline[1]) {
        await _diffComments(uid, doc.id, postPreview);
      }
      if (likes > baseline[0]) {
        await _diffLikes(uid, doc.id, postPreview);
      }
      if (shares > baseline[2]) {
        await _diffShares(uid, doc.id, postPreview);
      }
    }
  }

  /// Mark every current actor on a post's likes/shares subcollection as
  /// already-notified, so the diff only ever fires for NEW actors.
  Future<void> _seedSeen(String uid, String postId, String sub) async {
    try {
      final snap = await FirebaseFirestore.instance
          .collection('posts')
          .doc(postId)
          .collection(sub)
          .limit(50)
          .get();
      for (final doc in snap.docs) {
        _seenActorIds.add('notified:${sub == 'likes' ? 'like' : 'share'}:$postId:${doc.id}');
      }
    } on FirebaseException {
      // A failed seed only risks one stale notification — acceptable.
    }
  }

  Future<void> _diffComments(String uid, String postId, String postPreview) async {
    if (!await _enabled('comment')) return;
    final snap = await FirebaseFirestore.instance
        .collection('posts')
        .doc(postId)
        .collection('comments')
        .orderBy('createdAt', descending: true)
        .limit(20)
        .get();
    for (final doc in snap.docs) {
      if (_seenCommentIds.contains(doc.id)) continue;
      _seenCommentIds.add(doc.id);
      final d = doc.data();
      final actor = (d['uid'] ?? '') as String;
      if (actor.isEmpty || actor == uid) continue;
      final at = (d['createdAt'] as Timestamp?)?.millisecondsSinceEpoch ?? 0;
      // Only react to comments that arrived while we were watching — never
      // backfill the whole history.
      if (_startedAt != null && at < _startedAt!.millisecondsSinceEpoch) continue;
      await _file(AppNotification(
        id: 'c-${doc.id}',
        kind: 'comment',
        fromUid: actor,
        fromName: (d['name'] ?? 'Someone') as String,
        fromPhoto: (d['photo'] ?? '') as String,
        postId: postId,
        postPreview: postPreview,
        snippet: ((d['text'] ?? '') as String).trim(),
        atMs: at,
        read: false,
      ));
    }
  }

  Future<void> _diffLikes(String uid, String postId, String postPreview) async {
    if (!await _enabled('like')) return;
    final snap = await FirebaseFirestore.instance
        .collection('posts')
        .doc(postId)
        .collection('likes')
        .limit(50)
        .get();
    for (final doc in snap.docs) {
      final actor = doc.id; // the like doc's id IS the liker's uid
      if (actor == uid) continue;
      final seenKey = 'notified:like:$postId:$actor';
      if (_seenActorIds.contains(seenKey)) continue;
      _seenActorIds.add(seenKey);
      // Likers docs carry no timestamps, so only actors we have never seen on
      // this post since app start get a notification — history never backfills.
      await _file(AppNotification(
        id: 'l-$postId-$actor',
        kind: 'like',
        fromUid: actor,
        fromName: '',
        fromPhoto: '',
        postId: postId,
        postPreview: postPreview,
        snippet: '',
        atMs: DateTime.now().millisecondsSinceEpoch,
        read: false,
      ));
    }
  }

  Future<void> _diffShares(String uid, String postId, String postPreview) async {
    if (!await _enabled('share')) return;
    final snap = await FirebaseFirestore.instance
        .collection('posts')
        .doc(postId)
        .collection('shares')
        .limit(50)
        .get();
    for (final doc in snap.docs) {
      final key = 'notified:share:$postId:${doc.id}';
      if (_seenActorIds.contains(key)) continue;
      _seenActorIds.add(key);
      final actor = doc.id;
      if (actor == uid) continue;
      final d = doc.data();
      await _file(AppNotification(
        id: 's-$postId-$actor',
        kind: 'share',
        fromUid: actor,
        fromName: (d['name'] ?? 'Someone') as String,
        fromPhoto: '',
        postId: postId,
        postPreview: postPreview,
        snippet: '',
        atMs: DateTime.now().millisecondsSinceEpoch,
        read: false,
      ));
    }
  }

  Future<void> _watchFollowedPosts() async {
    final uid = _uid;
    if (uid == null) return;
    try {
      final following = await FirebaseFirestore.instance
          .collection('follows')
          .doc(uid)
          .collection('following')
          .get();
      final ids = following.docs.map((d) => d.id).toList();
      if (ids.isEmpty) return;
      _followSub = FirebaseFirestore.instance
          .collection('posts')
          .where('uid', whereIn: ids.take(10))
          .limit(30)
          .snapshots()
          .listen((snap) async {
        if (!await _enabled('post')) return;
        for (final doc in snap.docs) {
          if (_seenPostIds.contains(doc.id)) continue;
          _seenPostIds.add(doc.id);
          final d = doc.data();
          final at = (d['createdAt'] as Timestamp?)?.millisecondsSinceEpoch ?? 0;
          // Only brand-new posts (published while we watch) — never history.
          if (_startedAt == null || at < _startedAt!.millisecondsSinceEpoch) continue;
          final author = (d['uid'] ?? '') as String;
          if (author == uid) continue;
          await _file(AppNotification(
            id: 'p-${doc.id}',
            kind: 'post',
            fromUid: author,
            fromName: (d['name'] ?? 'Someone') as String,
            fromPhoto: (d['photo'] ?? '') as String,
            postId: doc.id,
            postPreview: '',
            snippet: ((d['text'] ?? '') as String).trim(),
            atMs: at,
            read: false,
          ));
        }
      });
    } on FirebaseException {
      // Follow-graph read failed — the post watcher stays silent, fine.
    }
  }

  /// Persist one notification into my own config collection.
  Future<void> _file(AppNotification n) async {
    final uid = _uid;
    if (uid == null) return;
    try {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('config')
          .doc('notif:${n.id}')
          .set(n.toMap(), SetOptions(merge: true));
    } on FirebaseException {
      // Best-effort — losing one in-app notification is not a failure.
    }
  }

  /// The user's notifications, newest first.
  static Stream<List<AppNotification>> stream(String uid) {
    return FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('config')
        .snapshots()
        .map((snap) {
      final items = <AppNotification>[
        for (final doc in snap.docs)
          if (doc.id.startsWith('notif:')) AppNotification.fromDoc(doc.id, doc.data()),
      ]..sort((a, b) => b.atMs.compareTo(a.atMs));
      return items;
    });
  }

  /// Mark everything read (called when the sheet opens).
  static Future<void> markAllRead(String uid) async {
    try {
      final snap = await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('config')
          .where('read', isEqualTo: false)
          .get();
      for (final doc in snap.docs) {
        if (!doc.id.startsWith('notif:')) continue;
        await doc.reference.set(<String, dynamic>{'read': true}, SetOptions(merge: true));
      }
    } on FirebaseException {
      // Best-effort.
    }
  }
}
