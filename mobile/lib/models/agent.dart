/// ---------------------------------------------------------------------------
/// Agents model — the roster and the Rooms.
///
/// The roster is the catalogue of 1-to-1 chat partners and group members. Each
/// of the ten chat agents wears one of the bundled mascot portraits shipped as
/// image assets (`assets/agents/chat/`); their `artId` uses the
/// `asset:<name>` scheme understood by [AgentAvatar]. A group can additionally
/// carry a user-uploaded photo (`file:<path>`), saved on-device.
///
/// The app ships with NO demo data: no seeded conversations and no prebuilt
/// teams — teams are always created by the user from the Agents tab.
/// ---------------------------------------------------------------------------

/// Where an agent came from: the official catalogue, or one the user built.
enum AgentSource { teamly, custom }

/// A named room of agents — the group chats the user assembles. Chats in a
/// room are group chats whose members answer together.
class AgentTeam {
  const AgentTeam({
    required this.id,
    required this.name,
    required this.roles,
    this.memberCount = 0,
    this.agentIds = const <String>[],
    this.avatar = '',
  });

  final String id;
  final String name;

  /// The comma-separated role list shown as the row subtitle.
  final List<String> roles;

  /// The agent ids in this room, in speaking order.
  final List<String> agentIds;
  final int memberCount;

  /// Group photo override: 'asset:agent-03' (one of the members) or
  /// 'file:<path>' (a photo the user uploaded, copied into app storage).
  /// Empty → the first member's portrait.
  final String avatar;

  /// The subtitle exactly as the reference formats it: roles truncated at
  /// three plus an ellipsis when there are more.
  String get subtitle {
    if (roles.isEmpty) return '$memberCount agents';
    if (roles.length <= 3) return roles.join(', ');
    return '${roles.take(3).join(', ')},...';
  }

  /// The artId the room's avatar renders: the explicit override, or the first
  /// member's portrait.
  String avatarArt(String Function(String) agentArtOf) {
    if (avatar.isNotEmpty) return avatar;
    for (final id in agentIds) {
      final art = agentArtOf(id);
      if (art.isNotEmpty) return art;
    }
    return '';
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'roles': roles,
        'agentIds': agentIds,
        'memberCount': memberCount,
        if (avatar.isNotEmpty) 'avatar': avatar,
      };

  factory AgentTeam.fromJson(Map<String, dynamic> json) => AgentTeam(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? 'Agent room',
        roles: ((json['roles'] as List?) ?? const <dynamic>[])
            .whereType<String>()
            .toList(),
        agentIds: ((json['agentIds'] as List?) ?? const <dynamic>[])
            .whereType<String>()
            .toList(),
        memberCount: (json['memberCount'] as num?)?.toInt() ?? 0,
        avatar: (json['avatar'] as String?) ?? '',
      );
}

class Agent {
  const Agent({
    required this.id,
    required this.name,
    required this.description,
    required this.category,
    required this.artId,
    this.source = AgentSource.teamly,
    this.friends = false,
    this.prompt = '',
  });

  final String id;
  final String name;

  /// The resume-style one-liner shown under the name.
  final String description;

  /// The agent's single specialism — one distinct category per agent.
  final String category;
  final AgentSource source;

  /// Social relationship state.
  final bool friends;

  /// Which profile picture this agent wears — `asset:<name>` for the bundled
  /// mascot portraits.
  final String artId;

  /// System prompt used when this agent chats 1-to-1 or inside a room.
  final String prompt;

  Agent copyWith({bool? friends}) => Agent(
        id: id,
        name: name,
        description: description,
        category: category,
        artId: artId,
        source: source,
        friends: friends ?? this.friends,
        prompt: prompt,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'description': description,
        'category': category,
        'artId': artId,
        'source': source.name,
        'friends': friends,
        'prompt': prompt,
      };

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? 'Agent',
        description: (json['description'] as String?) ?? '',
        category: (json['category'] as String?) ?? 'All',
        artId: (json['artId'] as String?) ?? 'asset:agent-01',
        source: json['source'] == 'custom' ? AgentSource.custom : AgentSource.teamly,
        friends: json['friends'] == true,
        prompt: (json['prompt'] as String?) ?? '',
      );
}

/// The category rail, in roster order. "All" is always first, then one entry
/// per distinct agent category.
const List<String> kAgentCategories = <String>[
  'All',
  'Travel',
  'Finance',
  'Games',
  'Health',
  'Research',
  'Photos',
  'Trends',
  'Presentations',
  'Data',
  'Planning',
];

/// The official roster — the ten chat agents, each with its own bundled
/// mascot portrait (assets/agents/chat/agent-01..10.jpg).
const List<Agent> kSeedAgents = <Agent>[
  Agent(
    id: 'scout',
    name: 'Scout',
    description: 'Places, routes and trip plans — tell Scout where you want to go.',
    category: 'Travel',
    artId: 'asset:agent-01',
    prompt:
        'You are Scout, a travel and places agent. Answer in at most 3 short lines. '
        'Give one concrete place, route or next step.',
  ),
  Agent(
    id: 'money-mentor',
    name: 'MoneyMentor',
    description: 'Budgets, spending breakdowns and saving plans in plain numbers.',
    category: 'Finance',
    artId: 'asset:agent-02',
    prompt:
        'You are MoneyMentor, a personal finance agent. Answer in at most 3 short lines. '
        'Use concrete numbers and end with one money move. Not financial advice.',
  ),
  Agent(
    id: 'game-buddy',
    name: 'GameBuddy',
    description: 'Game picks, build tips and strategies for whatever you are playing.',
    category: 'Games',
    artId: 'asset:agent-03',
    prompt:
        'You are GameBuddy, a gaming agent. Answer in at most 3 short lines. '
        'Be specific to the game and end with one actionable tip.',
  ),
  Agent(
    id: 'vital-coach',
    name: 'VitalCoach',
    description: 'Habits, fitness and plain-language health explanations.',
    category: 'Health',
    artId: 'asset:agent-04',
    prompt:
        'You are VitalCoach, a health information agent. Answer in at most 3 short lines and add '
        'that this is general information, not medical advice.',
  ),
  Agent(
    id: 'gem-hunter',
    name: 'GemHunter',
    description: 'Deep research, product comparisons and the best options for your budget.',
    category: 'Research',
    artId: 'asset:agent-05',
    prompt:
        'You are GemHunter, a research agent. Answer in at most 3 short lines. '
        'Compare options and end with one clear pick and why.',
  ),
  Agent(
    id: 'pixel-eye',
    name: 'PixelEye',
    description: 'Photo critique and analysis — composition, lighting, what to fix.',
    category: 'Photos',
    artId: 'asset:agent-06',
    prompt:
        'You are PixelEye, a photography critique agent. Answer in at most 3 short lines. '
        'Name what works, what to fix, and one concrete improvement.',
  ),
  Agent(
    id: 'star-guide',
    name: 'StarGuide',
    description: 'Trends, forecasts and what is rising right now.',
    category: 'Trends',
    artId: 'asset:agent-07',
    prompt:
        'You are StarGuide, a trends agent. Answer in at most 3 short lines. '
        'Name the trend and whether to ride it or wait.',
  ),
  Agent(
    id: 'slide-sensei',
    name: 'SlideSensei',
    description: 'Decks, explainers and teaching plans that make ideas land.',
    category: 'Presentations',
    artId: 'asset:agent-08',
    prompt:
        'You are SlideSensei, a presentation and teaching agent. Answer in at most 3 short lines. '
        'Give a slide-by-slide or step-by-step outline.',
  ),
  Agent(
    id: 'data-forge',
    name: 'DataForge',
    description: 'Databases, queries and data engineering with working examples.',
    category: 'Data',
    artId: 'asset:agent-09',
    prompt:
        'You are DataForge, a data engineering agent. Answer in at most 3 short lines. '
        'Prefer a short working snippet over prose.',
  ),
  Agent(
    id: 'task-pilot',
    name: 'TaskPilot',
    description: 'Plans, schedules and checklists that break big goals into steps.',
    category: 'Planning',
    artId: 'asset:agent-10',
    prompt:
        'You are TaskPilot, a planning agent. Answer in at most 3 short lines. '
        'End with a numbered next-step list.',
  ),
];

/// The rooms ship empty — teams are always user-created.
const List<AgentTeam> kSeedTeams = <AgentTeam>[];

/// Look up a roster agent by id (used by rooms and the chat list).
Agent? agentById(String id) {
  for (final Agent a in kSeedAgents) {
    if (a.id == id) return a;
  }
  return null;
}

/// The roster, keyed by id for quick lookups.
Map<String, Agent> get kAgentIndex => <String, Agent>{
      for (final Agent a in kSeedAgents) a.id: a,
    };

/// Find an agent by display name, case-insensitively — used to resolve an
/// `@mention` typed in a room to the specialist who should answer.
Agent? agentByName(String name) {
  final needle = name.trim().toLowerCase();
  if (needle.isEmpty) return null;
  for (final Agent a in kSeedAgents) {
    if (a.name.toLowerCase() == needle) return a;
  }
  return null;
}

/// Build-time helper used by the Agents screen for the segmented control.
enum AgentMode { agents, automations }
