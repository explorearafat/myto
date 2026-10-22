/// ---------------------------------------------------------------------------
/// Discover model — the "Discover / Feeds" tab.
///
/// Reference screenshot: a feed of agent-made *documents*. The signature moment
/// of the whole design lives here — a post whose body is a co-editable Markdown
/// brief rendered on warm paper, with a document toolbar (Edit · Comment ·
/// Export .md · Print / PDF · Reset) and a note that changes save locally.
/// ---------------------------------------------------------------------------

/// The content-type filter rail. "All" carries the reset glyph in the UI.
const List<String> kFeedFilters = <String>[
  'All',
  'Trending',
  'Webpage',
  'Mini Game',
  'Image',
  'Data Analysis',
];

/// "Following" = creators you follow; "Feeds" = the public stream.
enum FeedTab { following, feeds }

/// The engagement counters under each post.
class PostStats {
  const PostStats({this.likes = 0, this.bookmarks = 0, this.comments = 0});

  final int likes;
  final int bookmarks;
  final int comments;

  PostStats copyWith({int? likes, int? bookmarks, int? comments}) => PostStats(
        likes: likes ?? this.likes,
        bookmarks: bookmarks ?? this.bookmarks,
        comments: comments ?? this.comments,
      );

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'likes': likes, 'bookmarks': bookmarks, 'comments': comments};

  factory PostStats.fromJson(Map<String, dynamic> json) => PostStats(
        likes: (json['likes'] as num?)?.toInt() ?? 0,
        bookmarks: (json['bookmarks'] as num?)?.toInt() ?? 0,
        comments: (json['comments'] as num?)?.toInt() ?? 0,
      );
}

/// One generated post. [body] is Markdown — the source of truth — and is
/// editable in place, which is what "co-editable" means here.
class FeedPost {
  FeedPost({
    required this.id,
    required this.authorName,
    required this.eyebrow,
    required this.headline,
    required this.subhead,
    required this.body,
    this.authorAvatarIndex = 0,
    this.verified = false,
    this.following = false,
    this.filter = 'All',
    PostStats? stats,
    DateTime? createdAt,
  })  : stats = stats ?? const PostStats(),
        createdAt = createdAt ?? DateTime.now();

  final String id;

  /// Attribution. The reference shows "Unknown author" while the identity system
  /// is unfinished — we keep a real name and never leak the placeholder.
  final String authorName;
  final int authorAvatarIndex;
  final bool verified;
  bool following;

  /// The teal uppercase kicker: "WEEKLY INDUSTRY BRIEF · TECHNOLOGY & SOFTWARE".
  final String eyebrow;

  /// The serif headline.
  final String headline;

  /// The grey sub-headline under the headline.
  final String subhead;

  /// The Markdown body — editable.
  String body;

  final String filter;
  PostStats stats;
  final DateTime createdAt;

  /// The bold title shown in the footer bar under the document viewport.
  String get footerTitle => headline;

  /// A 2-line clamp of the body used as the truncated description.
  String get description {
    final flat = body
        .replaceAll(RegExp(r'[#*>`\-]'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return flat.length <= 180 ? flat : '${flat.substring(0, 180).trimRight()}...';
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'authorName': authorName,
        'authorAvatarIndex': authorAvatarIndex,
        'verified': verified,
        'following': following,
        'eyebrow': eyebrow,
        'headline': headline,
        'subhead': subhead,
        'body': body,
        'filter': filter,
        'stats': stats.toJson(),
        'createdAt': createdAt.millisecondsSinceEpoch,
      };

  factory FeedPost.fromJson(Map<String, dynamic> json) => FeedPost(
        id: (json['id'] as String?) ?? '',
        authorName: (json['authorName'] as String?) ?? 'Teamly Agent',
        authorAvatarIndex: (json['authorAvatarIndex'] as num?)?.toInt() ?? 0,
        verified: json['verified'] == true,
        following: json['following'] == true,
        eyebrow: (json['eyebrow'] as String?) ?? '',
        headline: (json['headline'] as String?) ?? '',
        subhead: (json['subhead'] as String?) ?? '',
        body: (json['body'] as String?) ?? '',
        filter: (json['filter'] as String?) ?? 'All',
        stats: json['stats'] is Map<String, dynamic>
            ? PostStats.fromJson(json['stats'] as Map<String, dynamic>)
            : const PostStats(),
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          (json['createdAt'] as num?)?.toInt() ?? 0,
        ),
      );
}

/// A comment on a post — the seed for the co-editable conversation.
class PostComment {
  const PostComment({required this.author, required this.text, required this.at});

  final String author;
  final String text;
  final DateTime at;
}

/// The seeded feed. The first post is the one in the reference screenshot,
/// reproduced verbatim so the design can be compared side by side.
final List<FeedPost> kSeedPosts = <FeedPost>[
  FeedPost(
    id: 'weekly-brief-se',
    authorName: 'Teamly Research',
    authorAvatarIndex: 2,
    verified: true,
    eyebrow: 'Weekly industry brief · Technology & Software',
    headline: 'Software engineering: the week agentic coding became the default',
    subhead:
        'Seven days of evidence that code generation is no longer the exception — it is the baseline expectation.',
    filter: 'All',
    stats: const PostStats(likes: 12, bookmarks: 0, comments: 1),
    body: '''## The shift

Seven days of evidence that code generation is no longer the exception. Across release
notes, funding announcements and hiring posts, the assumption underneath every story this
week was the same: **an agent writes the first draft, a human reviews it.**

## What changed

- Editors shipped inline agent suggestions as the default, not an opt-in.
- Two large frameworks moved their documentation to agent-generated changelogs.
- Review capacity — not generation speed — is now the stated bottleneck.

## What to watch

The interesting question is no longer *can* an agent write the code. It is what happens to
team structure when the review step becomes the whole job.
''',
  ),
  FeedPost(
    id: 'agentic-review',
    authorName: 'Code Review Guild',
    authorAvatarIndex: 1,
    verified: false,
    following: true,
    eyebrow: 'Engineering note · Practice',
    headline: 'Reviewing agent output without reading every line',
    subhead:
        'A practical rubric for trusting a diff you did not write, without rubber-stamping it.',
    filter: 'Data Analysis',
    stats: const PostStats(likes: 8, bookmarks: 3, comments: 2),
    body: '''## The rubric

Reviewing agent output is a different skill from reviewing a colleague's patch. The diff is
usually *plausible*, which is exactly what makes it dangerous.

1. Read the tests before the implementation.
2. Check the boundaries it did not touch.
3. Ask what the agent would have had to know to get this wrong.
''',
  ),
  FeedPost(
    id: 'landing-page-webpage',
    authorName: 'Content Creator',
    authorAvatarIndex: 0,
    verified: true,
    eyebrow: 'Artifact · Webpage',
    headline: 'A launch page drafted, built and deployed in one session',
    subhead: 'From a single paragraph of intent to a live URL, with the copy still editable.',
    filter: 'Webpage',
    stats: const PostStats(likes: 5, bookmarks: 1, comments: 0),
    body: '''## What was generated

A single-page site: hero, three feature blocks, pricing and a footer — all of it editable
as Markdown before it is rendered.

> The point is not that a page appeared. It is that the *source* stayed a document.
''',
  ),
];