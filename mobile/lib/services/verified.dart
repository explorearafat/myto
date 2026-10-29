// Verified user badges — a tiny registry for accounts Myto itself verifies.
//
import 'package:cloud_firestore/cloud_firestore.dart';

const Set<String> kVerifiedEmails = <String>{'explorearafat@gmail.com'};

bool isVerifiedEmail(String? email) =>
    email != null && kVerifiedEmails.contains(email.trim().toLowerCase());

const String kVerifiedFollowersLabel = '238.7K';

/// Per-author profile cache for the feed: verified flag + @username, read once
/// per author and remembered for the whole session. The feed cards use it to
/// show the blue tick and the handle instead of the raw display name.
final Map<String, ({bool verified, String username})> _authorCache = <String, ({bool verified, String username})>{};

/// Cached profile facts for a post author (uid), or null while loading.
({bool verified, String username})? authorFactsCached(String uid) => _authorCache[uid];

/// Fetch (and cache) an author's profile facts. Safe to call every build —
/// repeat calls are free once cached; failures cache a negative result.
Future<({bool verified, String username})?> loadAuthorFacts(String uid) async {
  if (uid.isEmpty || _authorCache.containsKey(uid)) return _authorCache[uid];
  _authorCache[uid] = (verified: false, username: ''); // negative cache first
  try {
    final snap = await FirebaseFirestore.instance.collection('profiles').doc(uid).get();
    final d = snap.data() ?? const <String, dynamic>{};
    final facts = (verified: d['verified'] == true, username: (d['username'] ?? '') as String);
    _authorCache[uid] = facts;
    return facts;
  } on FirebaseException {
    return _authorCache[uid];
  }
}
