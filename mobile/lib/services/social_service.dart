import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:http/http.dart' as http;

/// ---------------------------------------------------------------------------
/// SocialService — the Firestore engine behind the mobile Discover community.
///
/// Mirrors the website's src/lib/social.ts exactly (same collections, same
/// counter semantics), so both surfaces see one feed. The security model lives
/// in firestore.rules: posts are public-read, every write is pinned to the
/// signed-in caller, counters move only ±1 per write inside the same
/// transaction/batch as their like/share/comment doc, and likes/shares are
/// one-per-user (the edge doc's id IS the user's uid).
///
///   posts/{postId}                      — text-only post (≤500 chars) + optional
///                                         https link with its preview metadata
///   posts/{postId}/likes/{uid}          — one like per user
///   posts/{postId}/comments/{commentId} — ≤300-char comments
///   posts/{postId}/shares/{uid}         — one repost-per-user (add to profile)
///   users/{uid}/saved/{postId}          — the profile's saved list ({savedAt, post})
///   follows/{uid}/following/{target}    — the follow graph (both edges per follow)
/// ---------------------------------------------------------------------------
class FeedPost {
  const FeedPost({
    required this.id,
    required this.uid,
    required this.name,
    required this.photo,
    required this.text,
    required this.link,
    required this.linkTitle,
    required this.linkImage,
    required this.linkSite,
    required this.topics,
    required this.likeCount,
    required this.commentCount,
    required this.shareCount,
    required this.createdAtMs,
  });

  final String id;
  final String uid;
  final String name;
  final String photo;
  final String text;
  final String link;
  final String linkTitle;
  final String linkImage;
  final String linkSite;
  final List<String> topics;
  final int likeCount;
  final int commentCount;
  final int shareCount;
  final int createdAtMs;

  static FeedPost fromDoc(String id, Map<String, dynamic> d) {
    return FeedPost(
      id: id,
      uid: (d['uid'] ?? '') as String,
      name: (d['name'] ?? 'Anonymous') as String,
      photo: (d['photo'] ?? '') as String,
      text: (d['text'] ?? '') as String,
      link: (d['link'] ?? '') as String,
      linkTitle: (d['linkTitle'] ?? '') as String,
      linkImage: (d['linkImage'] ?? '') as String,
      linkSite: (d['linkSite'] ?? '') as String,
      topics: ((d['topics'] ?? const <String>[]) as List).whereType<String>().toList(),
      likeCount: ((d['likeCount'] ?? 0) as num).toInt(),
      commentCount: ((d['commentCount'] ?? 0) as num).toInt(),
      shareCount: ((d['shareCount'] ?? 0) as num).toInt(),
      createdAtMs: _ms(d['createdAt']),
    );
  }
}

class FeedComment {
  const FeedComment({
    required this.id,
    required this.uid,
    required this.name,
    required this.photo,
    required this.text,
    required this.createdAtMs,
  });

  final String id;
  final String uid;
  final String name;
  final String photo;
  final String text;
  final int createdAtMs;

  static FeedComment fromDoc(String id, Map<String, dynamic> d) {
    return FeedComment(
      id: id,
      uid: (d['uid'] ?? '') as String,
      name: (d['name'] ?? 'Anonymous') as String,
      photo: (d['photo'] ?? '') as String,
      text: (d['text'] ?? '') as String,
      createdAtMs: _ms(d['createdAt']),
    );
  }
}

int _ms(Object? value) {
  if (value is Timestamp) return value.millisecondsSinceEpoch;
  return 0;
}

/// The topic chips the composer offers; posts also inherit #hashtags from text.
const List<String> kDiscoverTopics = <String>['ai', 'myto', 'crypto', 'tech', 'news', 'dev'];

class SocialService {
  static FirebaseFirestore get _db => FirebaseFirestore.instance;
  static const int maxPostChars = 500;
  static const int maxCommentChars = 300;

  /// Lowercase #hashtags in the text (deduped, max 4).
  static List<String> extractHashtags(String text) {
    final tags = <String>{};
    final re = RegExp(r'#([a-z0-9]{1,20})', caseSensitive: false);
    for (final m in re.allMatches(text)) {
      tags.add(m.group(1)!.toLowerCase());
      if (tags.length >= 4) break;
    }
    return tags.toList();
  }

  /// First https URL in the text, or null.
  static String? firstUrl(String text) {
    final m = RegExp(r'https://[^\s<"]+', caseSensitive: false).firstMatch(text);
    return m?.group(0);
  }

  /// Merge chosen chips + hashtags into ≤4 clean slugs.
  static List<String> normalizeTopics(List<String> chosen, List<String> hashtags) {
    final out = <String>[];
    for (final t in [...chosen, ...hashtags]) {
      final slug = t.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
      if (slug.isEmpty || out.contains(slug)) continue;
      out.add(slug);
      if (out.length >= 4) break;
    }
    return out;
  }

  /// Fetch the preview metadata for an attached link from the site's edge function.
  /// No preview is not a failure — the post goes out with the bare link.
  static Future<Map<String, String>> fetchLinkMeta(String url) async {
    try {
      final res = await http
          .post(
            Uri.parse('https://mytocode.vercel.app/api/link-preview'),
            headers: const {'content-type': 'application/json'},
            body: jsonEncode({'url': url}),
          )
          .timeout(const Duration(seconds: 12));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final title = (data['title'] ?? '') as String;
      return <String, String>{
        'title': title.length <= 200 ? title : title.substring(0, 200),
        'image': (data['image'] ?? '') as String,
        'site': (data['site'] ?? '') as String,
      };
    } catch (_) {
      return const <String, String>{'title': '', 'image': '', 'site': ''};
    }
  }

  /// Create a post. Throws on validation failure (the UI validates first too).
  static Future<String> createPost({
    required String uid,
    required String name,
    required String photo,
    required String text,
    List<String> topics = const <String>[],
    String link = '',
    Map<String, String> linkMeta = const <String, String>{},
  }) async {
    final body = text.trim();
    if (body.isEmpty) throw StateError('Post cannot be empty.');
    final ref = await _db.collection('posts').add(<String, dynamic>{
      'uid': uid,
      'name': name.substring(0, name.length.clamp(0, 80)),
      'photo': photo,
      'text': body.substring(0, body.length.clamp(0, maxPostChars)),
      'link': link,
      'linkTitle': linkMeta['title'] ?? '',
      'linkImage': linkMeta['image'] ?? '',
      'linkSite': linkMeta['site'] ?? '',
      'topics': normalizeTopics(topics, extractHashtags(body)),
      'likeCount': 0,
      'commentCount': 0,
      'shareCount': 0,
      'createdAt': FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  /// Delete a post (author only, enforced by the rules) + best-effort cascade.
  static Future<void> deletePost(String postId) async {
    for (final sub in ['likes', 'comments', 'shares']) {
      try {
        final docs = await _db.collection('posts').doc(postId).collection(sub).limit(200).get();
        for (final d in docs.docs) {
          await d.reference.delete();
        }
      } catch (_) {
        // A partial sweep is fine — the parent delete orphans whatever is left.
      }
    }
    await _db.collection('posts').doc(postId).delete();
  }

  /// Live feed subscription, newest first, optionally filtered by topic or author.
  static Stream<List<FeedPost>> streamFeed({String? topic, String? authorUid, int limitCount = 50}) {
    Query<Map<String, dynamic>> q = _db.collection('posts').orderBy('createdAt', descending: true).limit(limitCount);
    if (topic != null && topic.isNotEmpty) {
      q = q.where('topics', arrayContains: topic);
    }
    if (authorUid != null && authorUid.isNotEmpty) {
      q = q.where('uid', isEqualTo: authorUid);
    }
    return q.snapshots().map(
          (s) => s.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList(),
        );
  }

  /// Live comments subscription for one post (oldest first).
  static Stream<List<FeedComment>> streamComments(String postId) {
    return _db
        .collection('posts')
        .doc(postId)
        .collection('comments')
        .orderBy('createdAt')
        .limit(100)
        .snapshots()
        .map((s) => s.docs.map((d) => FeedComment.fromDoc(d.id, d.data())).toList());
  }

  /// Toggle the caller's like atomically with its ±1 counter bump.
  static Future<bool> toggleLike(String postId, String uid) async {
    final likeRef = _db.collection('posts').doc(postId).collection('likes').doc(uid);
    final postRef = _db.collection('posts').doc(postId);
    return _db.runTransaction<bool>((tx) async {
      final existing = await tx.get(likeRef);
      if (existing.exists) {
        tx.delete(likeRef);
        tx.update(postRef, <String, dynamic>{'likeCount': FieldValue.increment(-1)});
        return false;
      }
      tx.set(likeRef, <String, dynamic>{'createdAt': FieldValue.serverTimestamp()});
      tx.update(postRef, <String, dynamic>{'likeCount': FieldValue.increment(1)});
      return true;
    });
  }

  static Future<bool> isLikedBy(String postId, String uid) async {
    final snap = await _db.collection('posts').doc(postId).collection('likes').doc(uid).get();
    return snap.exists;
  }

  /// Add a comment + bump the post's commentCount in one atomic batch.
  static Future<void> addComment(
    String postId, {
    required String uid,
    required String name,
    required String photo,
    required String text,
  }) async {
    final body = text.trim();
    if (body.isEmpty) return;
    final batch = _db.batch();
    final commentRef = _db.collection('posts').doc(postId).collection('comments').doc();
    batch.set(commentRef, <String, dynamic>{
      'uid': uid,
      'name': name.substring(0, name.length.clamp(0, 80)),
      'photo': photo,
      'text': body.substring(0, body.length.clamp(0, maxCommentChars)),
      'createdAt': FieldValue.serverTimestamp(),
    });
    batch.update(_db.collection('posts').doc(postId), <String, dynamic>{
      'commentCount': FieldValue.increment(1),
    });
    await batch.commit();
  }

  /// "Share" = repost to the caller's profile. Idempotent (one doc per user).
  static Future<bool> sharePost(String postId, {required String uid, required String name}) async {
    final shareRef = _db.collection('posts').doc(postId).collection('shares').doc(uid);
    final postRef = _db.collection('posts').doc(postId);
    return _db.runTransaction<bool>((tx) async {
      final existing = await tx.get(shareRef);
      if (existing.exists) return false;
      tx.set(shareRef, <String, dynamic>{
        'uid': uid,
        'name': name.substring(0, name.length.clamp(0, 80)),
        'createdAt': FieldValue.serverTimestamp(),
      });
      tx.update(postRef, <String, dynamic>{'shareCount': FieldValue.increment(1)});
      return true;
    });
  }

  static Future<void> saveToProfile(String postId, String uid) async {
    await _db.collection('users').doc(uid).collection('saved').doc(postId).set(
      <String, dynamic>{'savedAt': FieldValue.serverTimestamp(), 'post': postId},
    );
  }

  static Future<void> unsaveFromProfile(String postId, String uid) async {
    await _db.collection('users').doc(uid).collection('saved').doc(postId).delete();
  }

  static Future<bool> isSavedBy(String postId, String uid) async {
    final snap = await _db.collection('users').doc(uid).collection('saved').doc(postId).get();
    return snap.exists;
  }

  /// The caller's saved post ids, most recent first.
  static Future<List<String>> listSavedIds(String uid) async {
    final snap = await _db
        .collection('users')
        .doc(uid)
        .collection('saved')
        .orderBy('savedAt', descending: true)
        .limit(100)
        .get();
    return snap.docs
        .map((d) => (d.data()['post'] ?? d.id) as String)
        .where((s) => s.isNotEmpty)
        .toList();
  }

  /// Hydrate saved ids into full posts (deleted posts are skipped).
  static Future<List<FeedPost>> hydratePosts(List<String> ids) async {
    final out = <FeedPost>[];
    for (final id in ids) {
      final snap = await _db.collection('posts').doc(id).get();
      if (snap.exists) out.add(FeedPost.fromDoc(snap.id, snap.data() ?? <String, dynamic>{}));
    }
    return out;
  }

  /// Follow an author: both graph edges in one batch.
  static Future<void> followAuthor(String me, String target) async {
    if (me == target) return;
    final batch = _db.batch();
    batch.set(
      _db.collection('follows').doc(me).collection('following').doc(target),
      <String, dynamic>{'at': FieldValue.serverTimestamp()},
    );
    batch.set(
      _db.collection('follows').doc(target).collection('followers').doc(me),
      <String, dynamic>{'at': FieldValue.serverTimestamp()},
    );
    await batch.commit();
  }

  /// Unfollow: remove both edges.
  static Future<void> unfollowAuthor(String me, String target) async {
    final batch = _db.batch();
    batch.delete(_db.collection('follows').doc(me).collection('following').doc(target));
    batch.delete(_db.collection('follows').doc(target).collection('followers').doc(me));
    await batch.commit();
  }

  /// The ids of everyone `uid` follows (the Following tab).
  static Future<List<String>> getFollowingIds(String uid) async {
    final snap = await _db.collection('follows').doc(uid).collection('following').get();
    return snap.docs.map((d) => d.id).toList();
  }

  /// Feed posts by a fixed set of authors, merged newest-first.
  static Future<List<FeedPost>> fetchPostsByAuthors(List<String> authorUids) async {
    final ids = authorUids.take(10).toList(); // Firestore `whereIn` cap.
    if (ids.isEmpty) return <FeedPost>[];
    final snap = await _db
        .collection('posts')
        .where('uid', whereIn: ids)
        .orderBy('createdAt', descending: true)
        .limit(50)
        .get();
    return snap.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList();
  }
}


// ── Profiles, handles, viral feed ──────────────────────────────────────────────

/// A Discover profile: how the community sees a builder.
class DiscoverProfile {
  const DiscoverProfile({
    required this.uid,
    required this.name,
    required this.username,
    required this.bio,
    required this.photo,
    required this.createdAtMs,
  });

  final String uid;
  final String name;
  final String username;
  final String bio;
  final String photo;
  final int createdAtMs;

  static DiscoverProfile fromDoc(String id, Map<String, dynamic> d) {
    return DiscoverProfile(
      uid: id,
      name: (d['name'] ?? 'Anonymous') as String,
      username: (d['username'] ?? '') as String,
      bio: (d['bio'] ?? '') as String,
      photo: (d['photo'] ?? '') as String,
      createdAtMs: _ms(d['createdAt']),
    );
  }
}

/// A handle: 3–20 chars, lowercase letters/digits/underscore.
final RegExp kHandleRe = RegExp(r'^[a-z0-9_]{3,20}$');
extension DiscoverProfiles on SocialService {
  /// Read a user's public Discover profile, or null when they haven't set one up.
  Future<DiscoverProfile?> getProfile(String uid) async {
    final snap = await SocialService._db.collection('profiles').doc(uid).get();
    if (!snap.exists) return null;
    return DiscoverProfile.fromDoc(snap.id, snap.data() ?? <String, dynamic>{});
  }

  /// Is a handle still free? (UX check — the rules enforce uniqueness.)
  Future<bool> isHandleFree(String username) async {
    final snap =
        await SocialService._db.collection('usernames').doc(username.toLowerCase()).get();
    return !snap.exists;
  }

  /// Create/update the caller's profile and claim their handle. The handle doc
  /// is create-once in the rules, so a taken handle returns false.
  Future<bool> saveProfile(
    String uid, {
    required String name,
    required String username,
    required String bio,
    required String photo,
  }) async {
    final handle = username.trim().toLowerCase();
    if (!kHandleRe.hasMatch(handle)) return false;
    final handleRef = SocialService._db.collection('usernames').doc(handle);
    final existing = await handleRef.get();
    if (existing.exists && (existing.data()?['uid'] ?? '') != uid) return false;
    final batch = SocialService._db.batch();
    batch.set(handleRef, <String, dynamic>{'uid': uid});
    batch.set(
      SocialService._db.collection('profiles').doc(uid),
      <String, dynamic>{
        'uid': uid,
        'name': name.substring(0, name.length.clamp(0, 80)),
        'username': handle,
        'bio': bio.substring(0, bio.length.clamp(0, 280)),
        'photo': photo,
        'createdAt': FieldValue.serverTimestamp(),
      },
      SetOptions(merge: true),
    );
    await batch.commit();
    return true;
  }

  /// Viral feed: the most-liked posts, newest first among ties.
  Stream<List<FeedPost>> streamViralFeed({String? topic, int limitCount = 50}) {
    Query<Map<String, dynamic>> q = SocialService._db
        .collection('posts')
        .orderBy('likeCount', descending: true)
        .orderBy('createdAt', descending: true)
        .limit(limitCount);
    if (topic != null && topic.isNotEmpty) {
      q = q.where('topics', arrayContains: topic);
    }
    return q.snapshots().map(
          (s) => s.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList(),
        );
  }
}
