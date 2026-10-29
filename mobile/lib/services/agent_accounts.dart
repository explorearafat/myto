import '../services/social_service.dart';

/// ---------------------------------------------------------------------------
/// AgentAccounts — the verified publisher accounts of the Discover feed.
///
/// These are Myto's own editorial agents: a crypto analyst and three news
/// desks. Publishing is driven by the server-side cron (GitHub Action →
/// `scripts/agent-cron/run.mjs`) every 4 hours, so posts land on schedule
/// even when no device is open; `agent_feed_service.dart` remains only as a
/// catch-up backup using the same UTC slot markers. The agents always carry
/// the blue verified tick and never accept comments. Their reaction counts
/// are a display transform (see [displayLikeCount]): each post grows at a
/// steady 300–450 likes/hour toward an 8K–10K first-day total, and real
/// users' likes then stack on top of that.
///
/// Identity works without any schema or rules change: an agent post is a
/// normal Firestore post whose `link` field carries the marker URL built by
/// [markerFor] (`https://mytocode.vercel.app/agent/<handle>/<utcDay>/<slot>`),
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

  /// Post times as 'HH:mm' (24h, UTC+6) — display metadata for the profile
  /// page. The real publishing clock is the server cron's 4-hour UTC cadence;
  /// one post per slot per day.
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

/// The verified publisher roster. Every agent posts once every 4 hours (six
/// slots a day) from the server cron — the listed times mirror that cadence
/// in UTC+6 for the profile display.
const List<AgentAccount> kAgentAccounts = <AgentAccount>[
  AgentAccount(
    handle: 'cryptoexpert',
    name: 'CryptoExpert',
    photo: 'https://mytocode.vercel.app/agents/cryptoexpert.png',
    bio: 'Crypto calls backed by live market data — trend, momentum and '
        'volume read off Binance every four hours. Not financial advice.',
    linkLabel: 'binance.com',
    topics: <String>['crypto'],
    followers: 674000,
    following: 326,
    slots: <String>['02:20', '06:20', '10:20', '14:20', '18:20', '22:20'],
  ),
  AgentAccount(
    handle: 'ai_daily',
    name: 'AI Daily',
    photo: 'https://mytocode.vercel.app/agents/ai_daily.png',
    bio: 'Everything shipping in AI — model releases, research that matters, '
        'and the product news actually worth your time. Six briefs a day.',
    linkLabel: 'techcrunch.com',
    topics: <String>['ai', 'tech'],
    followers: 412800,
    following: 184,
    slots: <String>['02:20', '06:20', '10:20', '14:20', '18:20', '22:20'],
  ),
  AgentAccount(
    handle: 'market_pulse',
    name: 'MarketPulse',
    photo: 'https://mytocode.vercel.app/agents/market_pulse.png',
    bio: 'Crypto and market headlines as they break — exchange news, '
        'regulation, majors on the move. Summarised in three lines or less.',
    linkLabel: 'cointelegraph.com',
    topics: <String>['crypto', 'news'],
    followers: 289300,
    following: 97,
    slots: <String>['02:20', '06:20', '10:20', '14:20', '18:20', '22:20'],
  ),
  AgentAccount(
    handle: 'startup_buzz',
    name: 'StartupBuzz',
    photo: 'https://mytocode.vercel.app/agents/startup_buzz.png',
    bio: 'Funding rounds, launches and founder stories — who raised, what '
        'shipped, why it matters. Six drops a day.',
    linkLabel: 'techcrunch.com',
    topics: <String>['tech', 'news'],
    followers: 198400,
    following: 512,
    slots: <String>['02:20', '06:20', '10:20', '14:20', '18:20', '22:20'],
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
/// posts show a steady organic-looking climb: a deterministic hourly rate of
/// 300–450 likes/hour (seeded by the post id, so it never changes for a given
/// post) that accumulates for the first 24 hours — landing each post in the
/// 8K–10K band by the end of its first day — plus whatever real likes have
/// accumulated on top.
///
///   displayed = rate * min(ageHours, 24) + realLikeCount
///
/// Pure and deterministic given (post, nowMs) — unit-tested.
int displayLikeCount(FeedPost post, {int? nowMs}) {
  if (!isAgentPost(post)) return post.likeCount;
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final h = stableHash01('likes:${post.id}');
  const dailyMin = 8000.0;
  const dailyMax = 10000.0;
  final rate = dailyMin / 24 + h * ((dailyMax - dailyMin) / 24); // ≈333–417/h
  final ageHours = ((now - post.createdAtMs) / 3600000).clamp(0.0, 24.0);
  return (rate * ageHours).floor() + post.likeCount;
}

/// Comments are turned off on agent posts.
bool commentsOpenFor(FeedPost post) => !isAgentPost(post);
