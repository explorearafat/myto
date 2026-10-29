import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/agent.dart';
import '../models/artifact.dart';
import '../models/discover.dart';
import '../models/memory.dart';

/// ---------------------------------------------------------------------------
/// StudioStore — the data behind the four new tabs (Agents, Discover, Memory,
/// Artifacts).
///
/// One store rather than four, for the same reason [ConversationStore] is one
/// store: the four tabs share a single persistence blob, a single `load()` on
/// cold start, and a single `ChangeNotifier` in the widget tree. Every mutation
/// writes through to shared_preferences, so a follow/friend/bookmark survives a
/// restart exactly like a chat does.
///
/// It seeds from the reference screenshots on first run, then only ever stores
/// the user's own deltas on top — so the catalogue can grow later without
/// migrating anything.
/// ---------------------------------------------------------------------------
class StudioStore extends ChangeNotifier {
  static const String _key = 'sylor.studio.v1';

  // -- agents -----------------------------------------------------------------
  final List<Agent> _agents = [];
  List<Agent> get agents => List.unmodifiable(_agents);

  /// The official catalogue plus anything the user built, filtered by source.
  List<Agent> agentsBy(AgentSource source) =>
      _agents.where((a) => a.source == source).toList(growable: false);

  /// Agents matching a category chip, with "All" meaning everything.
  List<Agent> agentsIn(String category, {required AgentSource source}) {
    final base = agentsBy(source);
    if (category == 'All') return base;
    return base.where((a) => a.category == category).toList(growable: false);
  }

  final List<AgentTeam> _teams = [];
  List<AgentTeam> get teams => List.unmodifiable(_teams);

  /// Create a user-built group chat and add it to the list. [avatar] is the
  /// group photo override: 'asset:agent-XX' (one of the members) or
  /// 'file:<path>' (a photo the user uploaded, persisted on-device).
  AgentTeam createTeam({
    required String name,
    required List<String> roles,
    required List<String> agentIds,
    String avatar = '',
  }) {
    final team = AgentTeam(
      id: 'team-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}',
      name: name.trim().isEmpty ? 'New room' : name.trim(),
      roles: List<String>.from(roles),
      agentIds: List<String>.from(agentIds),
      memberCount: agentIds.length,
      avatar: avatar,
    );
    _teams.insert(0, team);
    notifyListeners();
    _persist();
    return team;
  }

  /// Remove a room (custom rooms only; the seeded catalogue is fixed).
  void removeTeam(String id) {
    final before = _teams.length;
    _teams.removeWhere((t) => t.id == id);
    if (_teams.length != before) {
      notifyListeners();
      _persist();
    }
  }

  AgentTeam? teamById(String id) {
    for (final t in _teams) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// Search over name + description, case-insensitive.
  List<Agent> searchAgents(String query, {required AgentSource source}) {
    final q = query.trim().toLowerCase();
    final base = agentsBy(source);
    if (q.isEmpty) return base;
    return base
        .where((a) =>
            a.name.toLowerCase().contains(q) || a.description.toLowerCase().contains(q))
        .toList(growable: false);
  }

  /// Add a user-built agent to the head of My Custom Agents.
  void addCustomAgent({
    required String name,
    required String description,
    required String category,
  }) {
    final id = 'custom-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    _agents.insert(
      0,
      Agent(
        id: id,
        name: name.trim().isEmpty ? 'My Agent' : name.trim(),
        description: description.trim(),
        category: category,
        source: AgentSource.custom,
        // A user-built agent has no face of its own, so it wears the library's
        // neutral tile. AgentAvatar falls back to the vector emblem if the id
        // ever goes missing.
        artId: 'asset:agent-01',
      ),
    );
    notifyListeners();
    _persist();
  }

  /// Start a 1:1 chat with an agent — the social "become friends" state the
  /// reference shows as "You are now friends".
  Agent? toggleFriend(String id) {
    final i = _agents.indexWhere((a) => a.id == id);
    if (i < 0) return null;
    final updated = _agents[i].copyWith(friends: !_agents[i].friends);
    _agents[i] = updated;
    notifyListeners();
    _persist();
    return updated;
  }

  bool isFriend(String id) => _agents.any((a) => a.id == id && a.friends);

  // -- discover ---------------------------------------------------------------
  final List<FeedPost> _posts = [];
  List<FeedPost> get posts => List.unmodifiable(_posts);

  final Set<String> _myPostIds = <String>{};

  /// Posts for a feed tab, optionally narrowed by the chip rail.
  List<FeedPost> postsFor(FeedTab tab, String filter) {
    var list = _posts;
    if (tab == FeedTab.following) {
      list = list.where((p) => p.following || _myPostIds.contains(p.id)).toList();
    }
    if (filter != 'All') {
      list = list.where((p) => p.filter == filter).toList();
    }
    return List.unmodifiable(list);
  }

  FeedPost? post(String id) {
    for (final p in _posts) {
      if (p.id == id) return p;
    }
    return null;
  }

  void toggleFollow(String id) {
    final p = post(id);
    if (p == null) return;
    p.following = !p.following;
    notifyListeners();
    _persist();
  }

  /// The heart. Toggling adds or removes one like.
  void toggleLike(String id) {
    final p = post(id);
    if (p == null) return;
    final liked = p.stats.likes > 0 && _likedIds.contains(id);
    if (liked) {
      _likedIds.remove(id);
      p.stats = p.stats.copyWith(likes: (p.stats.likes - 1).clamp(0, 1 << 30));
    } else {
      _likedIds.add(id);
      p.stats = p.stats.copyWith(likes: p.stats.likes + 1);
    }
    notifyListeners();
    _persist();
  }

  bool isLiked(String id) => _likedIds.contains(id);

  /// The bookmark. Bookmarking a post also files it as a *saved* artifact, which
  /// is what makes the Artifacts "Recently saved" tab meaningful.
  void toggleBookmark(String id) {
    final p = post(id);
    if (p == null) return;
    final saved = _bookmarkIds.contains(id);
    if (saved) {
      _bookmarkIds.remove(id);
      p.stats = p.stats.copyWith(bookmarks: (p.stats.bookmarks - 1).clamp(0, 1 << 30));
      _artifacts.removeWhere((a) => a.id == 'saved-$id');
    } else {
      _bookmarkIds.add(id);
      p.stats = p.stats.copyWith(bookmarks: p.stats.bookmarks + 1);
      _artifacts.insert(
        0,
        Artifact(
          id: 'saved-$id',
          title: p.headline,
          agentName: p.authorName,
          kind: ArtifactKind.document,
          saved: true,
          media: const <ArtifactMedia>[
            ArtifactMedia(id: 'doc', label: 'Saved post', aspect: '4:5', accentIndex: 3, icon: 2),
          ],
        ),
      );
    }
    notifyListeners();
    _persist();
  }

  bool isBookmarked(String id) => _bookmarkIds.contains(id);

  /// Save an in-place edit to a post's Markdown body. This is the "co-editable"
  /// half of Discover: the document is the source of truth, not a rendered card.
  void updatePostBody(String id, String body) {
    final p = post(id);
    if (p == null || p.body == body) return;
    p.body = body;
    notifyListeners();
    _persist();
  }

  /// Reset a post back to the seeded text (the document toolbar's Reset).
  void resetPostBody(String id) {
    final seeded = kSeedPosts.where((p) => p.id == id);
    final p = post(id);
    if (p == null || seeded.isEmpty) return;
    p.body = seeded.first.body;
    notifyListeners();
    _persist();
  }

  // -- memory -----------------------------------------------------------------
  final List<WikiDoc> _docs = [];
  List<WikiDoc> get docs => List.unmodifiable(_docs);

  /// The four pinned system pages, in reference order.
  List<WikiDoc> get systemDocs =>
      _docs.where((d) => d.isSystem).toList(growable: false);

  /// Everything that is not a system page, grouped in first-seen order.
  List<String> get docGroups {
    final seen = <String>[];
    for (final d in _docs) {
      if (d.isSystem) continue;
      if (!seen.contains(d.group)) seen.add(d.group);
    }
    return seen;
  }

  List<WikiDoc> docsIn(String group) =>
      _docs.where((d) => !d.isSystem && d.group == group).toList(growable: false);

  /// How many pages arrived while you were away — the nav badge, the
  /// `Updates n` chip and the per-row dot all read this one number.
  int get newCount => _docs.where((d) => d.isNew).length;

  /// The tool-bar slice: everything, only unread, or a tag filter.
  List<WikiDoc> docsFor(MemoryScope scope, {String? tag}) {
    switch (scope) {
      case MemoryScope.updates:
        return _docs.where((d) => d.isNew).toList(growable: false);
      case MemoryScope.tags:
        if (tag == null || tag.isEmpty) return const <WikiDoc>[];
        return _docs.where((d) => d.tags.contains(tag)).toList(growable: false);
      case MemoryScope.all:
        return List.unmodifiable(_docs);
    }
  }

  /// All tags across the wiki, de-duplicated, in first-seen order.
  List<String> get allTags {
    final seen = <String>[];
    for (final d in _docs) {
      for (final t in d.tags) {
        if (!seen.contains(t)) seen.add(t);
      }
    }
    return seen;
  }

  WikiDoc? doc(String id) {
    for (final d in _docs) {
      if (d.id == id) return d;
    }
    return null;
  }

  /// Opening a page clears its NEW dot — the third and final consumer of that
  /// one signal, so the badge drops the moment the page is read.
  void markDocRead(String id) {
    final d = doc(id);
    if (d == null || !d.isNew) return;
    d.isNew = false;
    notifyListeners();
    _persist();
  }

  void updateDocBody(String id, String body) {
    final d = doc(id);
    if (d == null || d.body == body) return;
    d.body = body;
    d.updatedAt = DateTime.now();
    notifyListeners();
    _persist();
  }

  /// Create a page — the `+ New` link.
  WikiDoc addDoc({required String title, String group = 'Getting Started'}) {
    final d = WikiDoc(
      id: 'doc-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}',
      title: title.trim().isEmpty ? 'Untitled' : title.trim(),
      subtitle: 'Created by you',
      body: '# ${title.trim()}\n\n',
      group: group,
      tags: const <String>['draft'],
    );
    _docs.insert(0, d);
    notifyListeners();
    _persist();
    return d;
  }

  // -- artifacts --------------------------------------------------------------
  final List<Artifact> _artifacts = [];
  List<Artifact> get artifacts => List.unmodifiable(_artifacts);

  List<Artifact> artifactsFor(ArtifactTab tab) {
    switch (tab) {
      case ArtifactTab.saved:
        return _artifacts.where((a) => a.saved).toList(growable: false);
      case ArtifactTab.memory:
        // Cross-link: the artifacts that the wiki's `My Artifacts` page knows about.
        return List.unmodifiable(_artifacts);
      case ArtifactTab.recent:
        final sorted = List<Artifact>.from(_artifacts)
          ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
        return List.unmodifiable(sorted);
    }
  }

  Artifact? artifact(String id) {
    for (final a in _artifacts) {
      if (a.id == id) return a;
    }
    return null;
  }

  /// The bookmark button on the artifact card.
  void toggleArtifactSaved(String id) {
    final i = _artifacts.indexWhere((a) => a.id == id);
    if (i < 0) return;
    _artifacts[i] = _artifacts[i].copyWith(saved: !_artifacts[i].saved);
    notifyListeners();
    _persist();
  }

  // -- lifecycle --------------------------------------------------------------
  final Set<String> _likedIds = <String>{};
  final Set<String> _bookmarkIds = <String>{};
  SharedPreferences? _prefs;

  /// Load the persisted studio, or seed from the reference screenshots on first
  /// run. Safe to call before the widget tree exists (main() awaits it).
  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    _agents.clear();
    _teams.clear();
    _posts.clear();
    _docs.clear();
    _artifacts.clear();
    _myPostIds.clear();
    _likedIds.clear();
    _bookmarkIds.clear();

    final raw = _prefs!.getString(_key);
    if (raw == null || raw.isEmpty) {
      _seed();
      notifyListeners();
      return;
    }

    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      _agents.addAll(_list(map['agents'], Agent.fromJson));
      _teams.addAll(_list(map['teams'], AgentTeam.fromJson));
      _posts.addAll(_list(map['posts'], FeedPost.fromJson));
      _docs.addAll(_list(map['docs'], WikiDoc.fromJson));
      _artifacts.addAll(_list(map['artifacts'], Artifact.fromJson));
      _myPostIds.addAll(_strings(map['myPostIds']));
      _likedIds.addAll(_strings(map['likedIds']));
      _bookmarkIds.addAll(_strings(map['bookmarkIds']));
      if (_agents.isEmpty) _seed();
    } catch (_) {
      /* corrupt store — reseed rather than crash */
      _seed();
    }
    notifyListeners();
  }

  void _seed() {
    _agents.addAll(kSeedAgents);
    _teams.addAll(kSeedTeams);
    _posts.addAll(kSeedPosts);
    _artifacts.addAll(kSeedArtifacts);
    _docs.addAll(_seedDocs());
  }

  /// The wiki the reference shows: four colour-tile system pages, then the three
  /// `Getting Started` documents — including the "About Me" page the product
  /// derives from your chats, which is the whole point of the Memory tab.
  ///
  /// `accentIndex` walks 0..3 so the tiles come out pink · cyan · amber · violet,
  /// which is the only place in the app where solid accent colour is allowed.
  List<WikiDoc> _seedDocs() {
    final now = DateTime.now();
    return <WikiDoc>[
      // -- pinned system pages ------------------------------------------------
      WikiDoc(
        id: 'overview',
        title: 'Overview',
        subtitle: 'All topics and how they connect',
        body: '# Overview\n\nThe map of everything your agents know about you.\n',
        group: 'System',
        isSystem: true,
        accentIndex: 0,
        updatedAt: now.subtract(const Duration(minutes: 2)),
      ),
      WikiDoc(
        id: 'my-profile',
        title: 'My Profile',
        subtitle: 'Your work and life profile',
        body: '# My Profile\n\nFilled in automatically from your chats.\n',
        group: 'System',
        isSystem: true,
        accentIndex: 1,
        updatedAt: now.subtract(const Duration(minutes: 5)),
      ),
      WikiDoc(
        id: 'next-actions',
        title: 'Next Actions',
        subtitle: 'Anticipated upcoming',
        body: '# Next Actions\n\nWhat the agents think you are about to need.\n',
        group: 'System',
        isSystem: true,
        accentIndex: 2,
        updatedAt: now.subtract(const Duration(minutes: 9)),
      ),
      WikiDoc(
        id: 'my-artifacts',
        title: 'My Artifacts',
        subtitle: 'Everything your agents produced',
        body: '# My Artifacts\n\nCross-linked with the Artifacts tab.\n',
        group: 'System',
        isSystem: true,
        accentIndex: 3,
        updatedAt: now.subtract(const Duration(minutes: 12)),
      ),

      // -- Getting Started group ---------------------------------------------
      WikiDoc(
        id: 'welcome',
        title: 'Welcome to Myto',
        subtitle: 'What Myto is — Personal AI, agents & teams, group chats, crea...',
        body: '# Welcome to Myto\n\nMyto is a personal AI workspace: agents do the work, '
            'the wiki remembers it.\n',
        group: 'Getting Started',
        tags: const <String>['getting-started', 'onboarding'],
        isNew: true,
        updatedAt: now,
      ),
      WikiDoc(
        id: 'wiki-basics',
        title: 'Myto Wiki: Your Personal Knowledge Base',
        subtitle: 'How your private wiki builds itself from chats, handles conflicts, ...',
        body: '# Your Personal Knowledge Base\n\nThis page writes itself from your '
            'chats and resolves conflicts when two sources disagree.\n',
        group: 'Getting Started',
        tags: const <String>['wiki', 'onboarding'],
        isNew: true,
        updatedAt: now,
      ),
      WikiDoc(
        id: 'about-me',
        title: 'About Me',
        subtitle: 'Your home base as a Software Engineer in Technology & Softwar...',
        body: '# About Me\n\nDerived from your chats: a Software Engineer working in '
            'Technology & Software.\n',
        group: 'Getting Started',
        tags: const <String>['software-engineering', 'technology'],
        isNew: true,
        updatedAt: now.subtract(const Duration(hours: 1)),
      ),
    ];
  }

  static List<T> _list<T>(dynamic raw, T Function(Map<String, dynamic>) build) {
    if (raw is! List) return <T>[];
    return raw.whereType<Map<String, dynamic>>().map(build).toList();
  }

  static List<String> _strings(dynamic raw) {
    if (raw is! List) return <String>[];
    return raw.whereType<String>().toList();
  }

  Future<void> _persist() async {
    final prefs = _prefs;
    if (prefs == null) return;
    await prefs.setString(
      _key,
      jsonEncode(<String, dynamic>{
        'agents': _agents.map((a) => a.toJson()).toList(),
        'teams': _teams.map((t) => t.toJson()).toList(),
        'posts': _posts.map((p) => p.toJson()).toList(),
        'docs': _docs.map((d) => d.toJson()).toList(),
        'artifacts': _artifacts.map((a) => a.toJson()).toList(),
        'myPostIds': _myPostIds.toList(),
        'likedIds': _likedIds.toList(),
        'bookmarkIds': _bookmarkIds.toList(),
      }),
    );
  }
}
