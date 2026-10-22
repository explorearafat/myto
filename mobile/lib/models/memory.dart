/// ---------------------------------------------------------------------------
/// Memory model — the "Memory / Wiki" tab.
///
/// Reference screenshot: a private knowledge base that *builds itself from
/// chats* and *handles conflicts*. Its shape is what makes that possible:
///
///  • four fixed, colourful "system" pages (Overview, My Profile, Next Actions,
///    My Artifacts) pinned above everything else — the only place in the app
///    where solid accent colour appears;
///  • everything else filed under a collapsible uppercase group with a count
///    and a `NEW` dot on anything that arrived while you were away.
///
/// The `NEW` dot, the nav badge and the `Updates n` filter are the same signal
/// repeated three times, so they all read from [WikiDoc.isNew].
/// ---------------------------------------------------------------------------

/// The four fixed system pages, in reference order.
/// [pastelIndex] indexes the accent palette in the theme (pink · cyan · amber · violet).
const List<String> kSystemTopicIds = <String>[
  'overview',
  'my-profile',
  'next-actions',
  'my-artifacts',
];

/// A wiki page. [body] is Markdown — the same source-of-truth format the
/// Discover documents use, so a page can be exported and co-edited identically.
class WikiDoc {
  WikiDoc({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.body,
    this.group = 'Getting Started',
    this.tags = const <String>[],
    this.isNew = false,
    this.isSystem = false,
    this.accentIndex = 0,
    DateTime? updatedAt,
    DateTime? createdAt,
  })  : updatedAt = updatedAt ?? DateTime.now(),
        createdAt = createdAt ?? DateTime.now();

  final String id;
  final String title;
  final String subtitle;
  String body;

  /// The collapsible section this page lives under.
  String group;
  List<String> tags;

  /// "Arrived while you were away" — drives the dot, the badge and Updates.
  bool isNew;

  /// True for the four pinned system pages, which render as colour tiles.
  final bool isSystem;
  final int accentIndex;

  DateTime updatedAt;
  final DateTime createdAt;

  /// "just now" / "1 hour ago" / "Oct 20" — the meta line the reference shows.
  String get relativeUpdated {
    final d = DateTime.now().difference(updatedAt);
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes} minute${d.inMinutes == 1 ? '' : 's'} ago';
    if (d.inHours < 24) return '${d.inHours} hour${d.inHours == 1 ? '' : 's'} ago';
    if (d.inDays == 1) return 'yesterday';
    if (d.inDays < 7) return '${d.inDays} days ago';
    return '${updatedAt.day} ${_month(updatedAt.month)}';
  }

  static String _month(int m) => const <String>[
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      ][(m - 1).clamp(0, 11)];

  WikiDoc copyWith({String? title, String? body, List<String>? tags, bool? isNew}) => WikiDoc(
        id: id,
        title: title ?? this.title,
        subtitle: subtitle,
        body: body ?? this.body,
        group: group,
        tags: tags ?? this.tags,
        isNew: isNew ?? this.isNew,
        isSystem: isSystem,
        accentIndex: accentIndex,
        updatedAt: DateTime.now(),
        createdAt: createdAt,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'title': title,
        'subtitle': subtitle,
        'body': body,
        'group': group,
        'tags': tags,
        'isNew': isNew,
        'isSystem': isSystem,
        'accentIndex': accentIndex,
        'updatedAt': updatedAt.millisecondsSinceEpoch,
        'createdAt': createdAt.millisecondsSinceEpoch,
      };

  factory WikiDoc.fromJson(Map<String, dynamic> json) => WikiDoc(
        id: (json['id'] as String?) ?? '',
        title: (json['title'] as String?) ?? 'Untitled',
        subtitle: (json['subtitle'] as String?) ?? '',
        body: (json['body'] as String?) ?? '',
        group: (json['group'] as String?) ?? 'Getting Started',
        tags: ((json['tags'] as List?) ?? const <dynamic>[]).whereType<String>().toList(),
        isNew: json['isNew'] == true,
        isSystem: json['isSystem'] == true,
        accentIndex: (json['accentIndex'] as num?)?.toInt() ?? 0,
        updatedAt: DateTime.fromMillisecondsSinceEpoch(
          (json['updatedAt'] as num?)?.toInt() ?? 0,
        ),
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          (json['createdAt'] as num?)?.toInt() ?? 0,
        ),
      );
}

/// The three slice modes in the toolbar: everything, only unread deltas, or a
/// tag-filtered view.
enum MemoryScope { all, updates, tags }