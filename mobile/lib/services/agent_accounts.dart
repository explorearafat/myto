import '../services/social_service.dart';

/// ---------------------------------------------------------------------------
/// AgentAccounts — the verified publisher accounts of the Discover feed.
///
/// These are Myto's own editorial agents: a crypto analyst and three daily
/// news desks. They post on a fixed daily schedule (seeded by
/// `agent_feed_service.dart` the first time the app is opened after each
/// slot), always carry the blue verified tick, and never accept comments.
/// Their reaction counts are a display transform (see [displayLikeCount]):
/// each post climbs fast to a stable base between 90K and 180K, and real
/// users' likes then stack on top of that.
///
/// Identity works without any schema or rules change: an agent post is a
/// normal Firestore post whose `link` field carries the marker URL built by
/// [markerFor] (`https://mytocode.vercel.app/agent/<handle>/<day>/<slot>`),
/// and whose `name`/`photo` are the account's. Anything that renders an
/// author asks [agentForPost] / [agentByName] before showing a Follow
/// button, a delete button, or a comment composer.
/// ---------------------------------------------------------------------------

/// One verified publisher account.
class AgentAccount {
  const AgentAccount({
    required this.handle,
    required this.name,
    required this.photo,
    required this.bio,
    required this.linkLabel,
    required this.topics,
    required this.followers,
    required this.following,
    required this.slots,
  });

  /// Lowercase handle (also the marker-link segment and DiceBear seed).
  final String handle;

  /// Display name — exactly what agent posts are authored as.
  final String name;

  /// Avatar URL (PNG — the feed avatars render with Image.network).
  final String photo;

  /// Profile bio shown on the agent's profile page.
  final String bio;

  /// The link chip label on the profile page.
  final String linkLabel;

  /// Topic tags every post from this account carries.
  final List<String> topics;

  /// Fixed display stats (never computed — these are the account's identity).
  final int followers;
  final int following;

  /// Daily post times as 'HH:mm' (24h, local). One post per slot per day.
  final List<String> slots;

  /// "@handle".
  String get atHandle => '@$handle';

  /// Compact follower label for profile headers — 674K, 12.3K, 902.
  String get followersLabel => _compact(followers);

  String get followingLabel => _compact(following);
}

String _compact(int n) {
  if (n >= 1000000) {
    final m = n / 1000000;
    return '${m.toStringAsFixed(m < 10 ? 1 : 0)}M';
  }
  if (n >= 1000) {
    final k = n / 1000;
    return '${k.toStringAsFixed(k < 10 ? 1 : 0)}K';
  }
  return '$n';
}

/// The domain marker posts must carry to be recognised as agent posts.
const String kAgentMarkerPrefix = 'https://mytocode.vercel.app/agent/';

/// The verified publisher roster. Slots are local wall-clock times; the
/// crypto desk posts twice a day (pre-US + post-EU session reads), the news
/// desks six times, spread across the waking day.
const List<AgentAccount> kAgentAccounts = <AgentAccount>[
  AgentAccount(
    handle: 'cryptoexpert',
    name: 'CryptoExpert',
    photo: 'https://api.dicebear.com/9.x/bots/png?seed=cryptoexpert&backgroundColor=1a6b52',
    bio: 'Daily crypto calls backed by live market data — trend, momentum and '
        'volume read off Binance every morning and evening. Not financial advice.',
    linkLabel: 'binance.com',
    topics: <String>['crypto'],
    followers: 674000,
    following: 326,
    slots: <String>['10:00', '18:00'],
  ),
  AgentAccount(
    handle: 'ai_daily',
    name: 'AI Daily',
    photo: 'https://api.dicebear.com/9.x/bots/png?seed=aidaily&backgroundColor=3b82f6',
    bio: 'Everything shipping in AI — model releases, research that matters, '
        'and the product news actually worth your time. Six briefs a day.',
    linkLabel: 'venturebeat.com',
    topics: <String>['ai', 'tech'],
    followers: 412800,
    following: 184,
    slots: <String>['08:30', '11:00', '13:30', '16:00', '18:30', '21:00'],
  ),
  AgentAccount(
    handle: 'market_pulse',
    name: 'MarketPulse',
    photo: 'https://api.dicebear.com/9.x/bots/png?seed=marketpulse&backgroundColor=f0b90b',
    bio: 'Crypto and market headlines as they break — exchange news, '
        'regulation, majors on the move. Summarised in three lines or less.',
    linkLabel: 'coindesk.com',
    topics: <String>['crypto', 'news'],
    followers: 289300,
    following: 97,
    slots: <String>['09:00', '12:00', '14:30', '17:00', '19:30', '22:00'],
  ),
  AgentAccount(
    handle: 'startup_buzz',
    name: 'StartupBuzz',
    photo: 'https://api.dicebear.com/9.x/bots/png?seed=startupbuzz&backgroundColor=eb4899',
    bio: 'Funding rounds, launches and founder stories from TechCrunch — '
        'who raised, what shipped, why it matters. Six drops a day.',
    linkLabel: 'techcrunch.com',
    topics: <String>['tech', 'news'],
    followers: 198400,
    following: 512,
    slots: <String>['08:00', '10:30', '13:00', '15:30', '18:00', '20:30'],
  ),
];

/// Look up an account by handle.
AgentAccount? agentByHandle(String? handle) {
  if (handle == null) return null;
  final h = handle.toLowerCase().trim();
  for (final a in kAgentAccounts) {
    if (a.handle == h) return a;
  }
  return null;
}

/// Look up an account by display name (what posts/comments are authored as).
AgentAccount? agentByName(String? name) {
  if (name == null) return null;
  final n = name.trim().toLowerCase();
  for (final a in kAgentAccounts) {
    if (a.name.toLowerCase() == n) return a;
  }
  return null;
}

/// Parse an agent marker link into (handle, day, slotIndex), or null.
({String handle, String day, int slot})? parseMarker(String link) {
  if (!link.startsWith(kAgentMarkerPrefix)) return null;
  final rest = link.substring(kAgentMarkerPrefix.length);
  final parts = rest.split('/');
  if (parts.length < 3) return null;
  final slot = int.tryParse(parts[2]);
  if (slot == null || slot < 0) return null;
  return (handle: parts[0], day: parts[1], slot: slot);
}

/// The marker link for one (handle, day, slot) — stable across all clients,
/// which is what makes daily seeding idempotent.
String markerFor(String handle, String day, int slot) =>
    '$kAgentMarkerPrefix$handle/$day/$slot';

/// Is this post authored by a verified agent account?
bool isAgentPost(FeedPost post) => agentForPost(post) != null;

/// The account behind a post, if any — by marker link first, then by name.
AgentAccount? agentForPost(FeedPost post) {
  final m = parseMarker(post.link);
  if (m != null) return agentByHandle(m.handle);
  return agentByName(post.name);
}

/// Is an author name a verified agent (for comment rows and bare names)?
bool isAgentAuthor(String? name) => agentByName(name) != null;

/// Stable 0..1 hash of a string (same primitive the feed jitter uses).
double stableHash01(String s) {
  var h = 7;
  for (final c in s.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return (h % 1000) / 1000.0;
}

/// The like count a post DISPLAYS. Real posts show their real count; agent
/// posts show a fast-rising pseudo count: a deterministic base of 90K–180K
/// (seeded by the post id, so it never changes for a given post) reached
/// within roughly the first hour, plus whatever real likes have accumulated.
///
///   displayed = base * easeOut(min(1, age/55min)) + realLikeCount
///
/// Pure and deterministic given (post, nowMs) — unit-tested.
int displayLikeCount(FeedPost post, {int? nowMs}) {
  if (!isAgentPost(post)) return post.likeCount;
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final base = 90000 + (stableHash01('likes:${post.id}') * 90001).floor();
  final ageMin = ((now - post.createdAtMs) / 60000).clamp(0.0, double.infinity);
  final t = (ageMin / 55.0).clamp(0.0, 1.0);
  final eased = 1 - (1 - t) * (1 - t); // ease-out quad — fast first, then levels
  final shown = base * eased + post.likeCount;
  return shown.floor();
}

/// Comments are turned off on agent posts.
bool commentsOpenFor(FeedPost post) => !isAgentPost(post);
