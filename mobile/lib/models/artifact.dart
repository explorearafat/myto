/// ---------------------------------------------------------------------------
/// Artifacts model — the "Artifacts / Home" tab.
///
/// Reference screenshot: a *vault* of what the agents produced. One card held a
/// 9:16 animation centred on a black letterbox stage, with ‹ › arrows and a
/// `1/2` counter — so the data model is `Artifact → media[]`, never 1:1.
///
/// The card also carried `✧ Agent generated` (mint chip) and a `VIDEO` label,
/// which is why [ArtifactKind] exists: the feed filters and the card badges both
/// read from it.
/// ---------------------------------------------------------------------------

/// What the artifact actually is. Drives the `VIDEO` / `WEBPAGE` / `IMAGE` /
/// `MINI GAME` badge and the Discover filter rail's artifact types.
enum ArtifactKind {
  video('VIDEO'),
  image('IMAGE'),
  webpage('WEBPAGE'),
  miniGame('MINI GAME'),
  document('DOCUMENT');

  const ArtifactKind(this.label);

  /// The uppercase badge text the reference shows next to the tag.
  final String label;
}

/// One piece of media inside an artifact. An artifact is a carousel of these,
/// which is what the `1/2` counter in the reference counts.
class ArtifactMedia {
  const ArtifactMedia({
    required this.id,
    required this.label,
    this.aspect = '9:16',
    this.accentIndex = 0,
    this.icon = 0,
  });

  final String id;

  /// Caption shown under the stage ("Storyboard", "Final cut").
  final String label;

  /// Aspect ratio of the stage frame. The reference stage is tall (9:16).
  final String aspect;

  /// Index into the theme's avatar pastels, used to tint the placeholder frame
  /// so each carousel page reads as a different scene without shipping assets.
  final int accentIndex;

  /// Which simple placeholder glyph to draw (see ArtifactStage).
  final int icon;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'label': label,
        'aspect': aspect,
        'accentIndex': accentIndex,
        'icon': icon,
      };

  factory ArtifactMedia.fromJson(Map<String, dynamic> json) => ArtifactMedia(
        id: (json['id'] as String?) ?? '',
        label: (json['label'] as String?) ?? 'Media',
        aspect: (json['aspect'] as String?) ?? '9:16',
        accentIndex: (json['accentIndex'] as num?)?.toInt() ?? 0,
        icon: (json['icon'] as num?)?.toInt() ?? 0,
      );
}

/// A deliverable an agent produced. Chat tells you it is ready; this is where
/// it lands.
class Artifact {
  Artifact({
    required this.id,
    required this.title,
    required this.agentName,
    required this.kind,
    required this.media,
    this.agentGenerated = true,
    this.saved = false,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();

  final String id;
  final String title;

  /// Who made it — shown as attribution, never a placeholder.
  final String agentName;
  final ArtifactKind kind;

  /// The carousel. Always at least one entry.
  final List<ArtifactMedia> media;

  /// "Agent generated" — true for everything an agent produced unattended.
  final bool agentGenerated;

  /// Bookmarked from the card's top-right button (the `Recently saved` tab).
  bool saved;

  final DateTime createdAt;

  int get count => media.length;

  /// "Created Oct 20, 11:08 PM" — the meta line the reference shows.
  String get createdLabel {
    final h24 = createdAt.hour;
    final h12 = h24 % 12 == 0 ? 12 : h24 % 12;
    final ampm = h24 < 12 ? 'AM' : 'PM';
    final min = createdAt.minute.toString().padLeft(2, '0');
    return 'Created ${_month(createdAt.month)} ${createdAt.day}, $h12:$min $ampm';
  }

  static String _month(int m) => const <String>[
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      ][(m - 1).clamp(0, 11)];

  Artifact copyWith({bool? saved}) => Artifact(
        id: id,
        title: title,
        agentName: agentName,
        kind: kind,
        media: media,
        agentGenerated: agentGenerated,
        saved: saved ?? this.saved,
        createdAt: createdAt,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'title': title,
        'agentName': agentName,
        'kind': kind.name,
        'media': media.map((m) => m.toJson()).toList(),
        'agentGenerated': agentGenerated,
        'saved': saved,
        'createdAt': createdAt.millisecondsSinceEpoch,
      };

  factory Artifact.fromJson(Map<String, dynamic> json) => Artifact(
        id: (json['id'] as String?) ?? '',
        title: (json['title'] as String?) ?? 'Untitled artifact',
        agentName: (json['agentName'] as String?) ?? 'Teamly Agent',
        kind: ArtifactKind.values.firstWhere(
          (k) => k.name == json['kind'],
          orElse: () => ArtifactKind.video,
        ),
        media: ((json['media'] as List?) ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ArtifactMedia.fromJson)
            .toList(),
        agentGenerated: json['agentGenerated'] != false,
        saved: json['saved'] == true,
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          (json['createdAt'] as num?)?.toInt() ?? 0,
        ),
      );
}

/// The three slice modes in the header: newest, bookmarked, or the wiki view.
enum ArtifactTab { recent, saved, memory }

/// How the list is laid out — the header's grid/list toggle.
enum ArtifactView { grid, list }

/// The seeded vault: the `Animated Science Short` from the reference, plus two
/// more so each tab and both layouts have something real to show.
final List<Artifact> kSeedArtifacts = <Artifact>[
  Artifact(
    id: 'animated-science-short',
    title: 'Animated Science Short',
    agentName: 'Short-Video Editing Coach',
    kind: ArtifactKind.video,
    createdAt: DateTime.now().subtract(const Duration(hours: 13)),
    media: const <ArtifactMedia>[
      ArtifactMedia(id: 'storyboard', label: 'Storyboard', accentIndex: 2, icon: 0),
      ArtifactMedia(id: 'final', label: 'Final cut', accentIndex: 0, icon: 1),
    ],
  ),
  Artifact(
    id: 'weekly-brief-md',
    title: 'Weekly Industry Brief',
    agentName: 'Teamly Research',
    kind: ArtifactKind.document,
    createdAt: DateTime.now().subtract(const Duration(days: 1, hours: 4)),
    media: const <ArtifactMedia>[
      ArtifactMedia(id: 'brief', label: 'Brief', aspect: '4:5', accentIndex: 3, icon: 2),
    ],
  ),
  Artifact(
    id: 'launch-page',
    title: 'Launch Page',
    agentName: 'Content Creator',
    kind: ArtifactKind.webpage,
    createdAt: DateTime.now().subtract(const Duration(days: 2, hours: 1)),
    media: const <ArtifactMedia>[
      ArtifactMedia(id: 'hero', label: 'Hero', aspect: '16:9', accentIndex: 1, icon: 3),
    ],
  ),
];