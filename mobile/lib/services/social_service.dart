import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
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
  ///
  /// A where-filter + orderBy on different fields needs a Firestore composite
  /// index; without one the query is rejected and the profile/feed silently
  /// never loads. Filtered queries therefore run equality-only (auto-indexed)
  /// and sort client-side; the unfiltered feed keeps the server-side orderBy.
  static Stream<List<FeedPost>> streamFeed({String? topic, String? authorUid, int limitCount = 50}) {
    final filtered = (topic != null && topic.isNotEmpty) || (authorUid != null && authorUid.isNotEmpty);
    Query<Map<String, dynamic>> q = _db.collection('posts');
    q = filtered
        ? q.limit(200) // no server orderBy — arbitrary slice of a small feed
        : q.orderBy('createdAt', descending: true).limit(limitCount);
    if (topic != null && topic.isNotEmpty) {
      q = q.where('topics', arrayContains: topic);
    }
    if (authorUid != null && authorUid.isNotEmpty) {
      q = q.where('uid', isEqualTo: authorUid);
    }
    return q.snapshots().map((s) {
      final posts = s.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList();
      if (!filtered) return posts;
      posts.sort((a, b) => b.createdAtMs.compareTo(a.createdAtMs));
      return posts.take(limitCount).toList();
    });
  }

  /// One-shot posts by an author NAME (agent accounts have no uid of their
  /// own — their posts are queried by display name). Equality-only query —
  /// sorting happens client-side, so no composite index is required (a
  /// where+orderBy pair would silently fail without one and the agent
  /// profiles would show no posts at all).
  static Future<List<FeedPost>> fetchPostsByName(String name, {int limitCount = 50}) async {
    final snap = await _db
        .collection('posts')
        .where('name', isEqualTo: name)
        .limit(limitCount)
        .get();
    final posts = snap.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList()
      ..sort((a, b) => b.createdAtMs.compareTo(a.createdAtMs));
    return posts;
  }

  /// True when a post with this exact marker link already exists — the
  /// idempotency check behind the verified agents' daily seeding.
  static Future<bool> postWithMarkerExists(String link) async {
    final snap = await _db.collection('posts').where('link', isEqualTo: link).limit(1).get();
    return snap.docs.isNotEmpty;
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

  /// Server-side follower count for a profile header (0 on any failure).
  static Future<int> followerCount(String uid) async {
    try {
      final snap = await _db.collection('follows').doc(uid).collection('followers').count().get();
      return snap.count ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// Server-side following count for a profile header (0 on any failure).
  static Future<int> followingCount(String uid) async {
    try {
      final snap = await _db.collection('follows').doc(uid).collection('following').count().get();
      return snap.count ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// Feed posts by a fixed set of authors, merged newest-first. Equality-only
  /// (whereIn) query — sorted client-side, no composite index needed.
  static Future<List<FeedPost>> fetchPostsByAuthors(List<String> authorUids) async {
    final ids = authorUids.take(10).toList(); // Firestore `whereIn` cap.
    if (ids.isEmpty) return <FeedPost>[];
    final snap = await _db
        .collection('posts')
        .where('uid', whereIn: ids)
        .limit(200)
        .get();
    final posts = snap.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList()
      ..sort((a, b) => b.createdAtMs.compareTo(a.createdAtMs));
    return posts.take(50).toList();
  }

  /// One-shot recent posts (the Search screen filters this client-side).
  static Future<List<FeedPost>> fetchRecentPosts({int limitCount = 100}) async {
    final snap = await _db
        .collection('posts')
        .orderBy('createdAt', descending: true)
        .limit(limitCount)
        .get();
    return snap.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList();
  }

  /// One-shot profile sample (Search filters names/handles client-side).
  static Future<List<DiscoverProfile>> fetchProfileSample({int limitCount = 200}) async {
    final snap = await _db.collection('profiles').limit(limitCount).get();
    return snap.docs.map((d) => DiscoverProfile.fromDoc(d.id, d.data())).toList();
  }

  /// "For you" ordering: engagement + recency + who-you-follow, with a jitter
  /// that is stable per (post, refresh) — so the feed flows differently on each
  /// pull-to-refresh but never re-shuffles while you scroll.
  ///
  ///   score = engagement + recency + follow-boost + jitter
  ///     engagement — likes ×2, comments ×3, shares ×2.5 (conversation wins)
  ///     recency    — linear decay over 72h, worth up to 40 points
  ///     follow     — +25 for authors from your follow graph
  ///     jitter     — 0..12 points, seeded by the refresh so ties separate
  ///
  /// Pure + deterministic given (posts, following, seed) — unit-testable.
  static List<FeedPost> prioritizePosts(
    List<FeedPost> posts, {
    Set<String> following = const <String>{},
    int seed = 0,
    int? nowMs,
  }) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    double score(FeedPost p) {
      final ageH = ((now - p.createdAtMs) / 3600000).clamp(0.0, 72.0);
      final engagement = p.likeCount * 2.0 + p.commentCount * 3.0 + p.shareCount * 2.5;
      final recency = 40.0 * (1 - ageH / 72);
      final followBoost = following.contains(p.uid) ? 25.0 : 0.0;
      final jitter = _jitter('$seed:${p.id}') * 12.0;
      return engagement + recency + followBoost + jitter;
    }

    final ranked = <FeedPost>[...posts]..sort((a, b) => score(b).compareTo(score(a)));
    return ranked;
  }

  /// Stable 0..1 hash of a string (no Dart core hash — it varies per run).
  static double _jitter(String s) {
    var h = 7;
    for (final c in s.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return (h % 1000) / 1000.0;
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
    this.verified = false,
  });

  final String uid;
  final String name;
  final String username;
  final String bio;
  final String photo;
  final int createdAtMs;

  /// Myto's own blue tick (the founder account), stamped into the profile doc.
  final bool verified;

  static DiscoverProfile fromDoc(String id, Map<String, dynamic> d) {
    return DiscoverProfile(
      uid: id,
      name: (d['name'] ?? 'Anonymous') as String,
      username: (d['username'] ?? '') as String,
      bio: (d['bio'] ?? '') as String,
      photo: (d['photo'] ?? '') as String,
      createdAtMs: _ms(d['createdAt']),
      verified: d['verified'] == true,
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
  ///
  /// THE UPDATE BUG (fixed here): the handle doc must never be RE-written —
  /// `usernames/{x}` allows create but forbids update, so `set()` on our own
  /// existing doc failed the whole batch with permission-denied (the profile
  /// page "went blank" after every edit). Claim it only when it doesn't exist
  /// yet; when it's already ours, skip straight to the profile write. For the
  /// same reason `createdAt` is only sent on first create, never on update.
  Future<bool> saveProfile(
    String uid, {
    required String name,
    required String username,
    required String bio,
    required String photo,
  }) async {
    final handle = username.trim().toLowerCase();
    if (!kHandleRe.hasMatch(handle)) return false;
    final db = SocialService._db;
    final handleRef = db.collection('usernames').doc(handle);
    final existing = await handleRef.get();
    if (existing.exists && (existing.data()?['uid'] ?? '') != uid) return false;
    try {
      final batch = db.batch();
      if (!existing.exists) {
        batch.set(handleRef, <String, dynamic>{'uid': uid});
      }
      final profileRef = db.collection('profiles').doc(uid);
      final existingProfile = await profileRef.get();
      final data = <String, dynamic>{
        'uid': uid,
        'name': name.substring(0, name.length.clamp(0, 80)),
        'username': handle,
        'bio': bio.substring(0, bio.length.clamp(0, 280)),
        'photo': photo,
      };
      // First create stamps createdAt; updates keep the original so the
      // profile's age never resets on an edit.
      if (!existingProfile.exists) data['createdAt'] = FieldValue.serverTimestamp();
      batch.set(profileRef, data, SetOptions(merge: true));
      await batch.commit();
      // Keep the signed-in identity in step: the chat headers and the message
      // list read the AUTH display name, so a profile rename must land there
      // too or the old name lingers everywhere outside Discover.
      try {
        final user = FirebaseAuth.instance.currentUser;
        if (user != null && name.trim().isNotEmpty && user.displayName != name.trim()) {
          await user.updateProfile(displayName: name.trim());
        }
      } catch (_) {
        // Cosmetic sync — a failure must not fail the save.
      }
      return true;
    } on FirebaseException {
      // Rules/permission/network failure — the caller shows a message instead
      // of the page silently dying.
      rethrow;
    }
  }

  /// Viral feed: the most-liked posts, newest first among ties.
  Stream<List<FeedPost>> streamViralFeed({String? topic, int limitCount = 50}) {
    // Two orderBys (or a topic filter + orderBy) need composite indexes; a
    // single orderBy rides the auto index. So: order server-side by likeCount
    // only — or not at all when a topic filter is active — and tie-break
    // client-side.
    final filtered = topic != null && topic.isNotEmpty;
    Query<Map<String, dynamic>> q = SocialService._db.collection('posts');
    q = filtered ? q.limit(200) : q.orderBy('likeCount', descending: true).limit(limitCount);
    if (filtered) q = q.where('topics', arrayContains: topic);
    return q.snapshots().map((s) {
      final posts = s.docs.map((d) => FeedPost.fromDoc(d.id, d.data())).toList()
        ..sort((a, b) {
          final byLikes = b.likeCount.compareTo(a.likeCount);
          return byLikes != 0 ? byLikes : b.createdAtMs.compareTo(a.createdAtMs);
        });
      return posts.take(limitCount).toList();
    });
  }
}


// ── Artifacts vault (generated media, synced across clients) ───────────────────

/// One artifact the models produced for the user: an image, video clip,
/// SVG/PNG, or document. Small media rides inline as base64; larger or
/// provider-linked media rides as a URL.
class CloudArtifact {
  const CloudArtifact({
    required this.id,
    required this.kind,
    required this.title,
    required this.mime,
    required this.dataBase64,
    required this.url,
    required this.createdAtMs,
  });

  final String id;
  final String kind; // image | video | svg | document | file
  final String title;
  final String mime;
  final String dataBase64;
  final String url;
  final int createdAtMs;

  bool get isImage => kind == 'image' || mime.startsWith('image/');
  bool get isVideo => kind == 'video' || mime.startsWith('video/');
  bool get hasInline => dataBase64.isNotEmpty;

  String get inlineSrc => hasInline ? 'data:$mime;base64,$dataBase64' : url;

  static CloudArtifact fromDoc(String id, Map<String, dynamic> d) {
    return CloudArtifact(
      id: id,
      kind: (d['kind'] ?? 'file') as String,
      title: (d['title'] ?? 'Artifact') as String,
      mime: (d['mime'] ?? 'application/octet-stream') as String,
      dataBase64: (d['dataBase64'] ?? '') as String,
      url: (d['url'] ?? '') as String,
      createdAtMs: _ms(d['createdAt']),
    );
  }
}

extension ArtifactVault on SocialService {
  /// Live subscription to the user's artifact vault, newest first.
  Stream<List<CloudArtifact>> streamArtifacts(String uid) {
    return SocialService._db
        .collection('artifacts')
        .where('uid', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .limit(100)
        .snapshots()
        .map((s) => s.docs.map((d) => CloudArtifact.fromDoc(d.id, d.data())).toList());
  }

  /// Remove one artifact from the vault.
  Future<void> deleteArtifact(String id) async {
    await SocialService._db.collection('artifacts').doc(id).delete();
  }
}
