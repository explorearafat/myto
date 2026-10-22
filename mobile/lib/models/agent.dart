/// ---------------------------------------------------------------------------
/// Agents model — the "Agents" tab.
///
/// Reference screenshot: the Agents directory. Every row is one *hireable
/// colleague*: a pastel avatar disc, a job title, a resume-style credential
/// line ("Expert ... specializing in ...") and a green "Chat" pill.
///
/// Categories and the paste colour of each disc are part of the data so the
/// screen never has to guess — `pastelIndex` picks from
/// [TeamlyColors.avatarPastels] in the same order the reference uses.
/// ---------------------------------------------------------------------------

/// Where an agent came from: the official catalogue, or one the user built.
enum AgentSource { teamly, custom }

/// A named crew of agents — the "Agent Teams" tab. Chats with a team live in
/// the Chat tab as group chats whose subtitle is the comma-separated role list.
class AgentTeam {
  const AgentTeam({
    required this.id,
    required this.name,
    required this.roles,
    this.memberCount = 0,
  });

  final String id;
  final String name;

  /// The comma-separated role list shown as the row subtitle.
  final List<String> roles;
  final int memberCount;

  /// The subtitle exactly as the reference formats it: "AI Engineer, Prompt
  /// Engineer, Data Engineer, Frontend..." — truncated at 3 roles plus ellipsis.
  String get subtitle {
    if (roles.isEmpty) return '$memberCount agents';
    if (roles.length <= 3) return roles.join(', ');
    return '${roles.take(3).join(', ')},...';
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'roles': roles,
        'memberCount': memberCount,
      };

  factory AgentTeam.fromJson(Map<String, dynamic> json) => AgentTeam(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? 'Agent team',
        roles: ((json['roles'] as List?) ?? const <dynamic>[])
            .whereType<String>()
            .toList(),
        memberCount: (json['memberCount'] as num?)?.toInt() ?? 0,
      );
}

class Agent {
  const Agent({
    required this.id,
    required this.name,
    required this.description,
    this.category = 'All',
    this.source = AgentSource.teamly,
    this.pastelIndex = 0,
    this.friends = false,
  });

  final String id;
  final String name;

  /// The resume-style one-liner. Always written as "Expert ... specializing in ...".
  final String description;
  final String category;
  final AgentSource source;

  /// Index into [TeamlyColors.avatarPastels] for this agent's disc.
  final int pastelIndex;

  /// The social relationship state the reference shows as "You are now friends".
  final bool friends;

  Agent copyWith({bool? friends}) => Agent(
        id: id,
        name: name,
        description: description,
        category: category,
        source: source,
        pastelIndex: pastelIndex,
        friends: friends ?? this.friends,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'description': description,
        'category': category,
        'source': source.name,
        'pastelIndex': pastelIndex,
        'friends': friends,
      };

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? 'Agent',
        description: (json['description'] as String?) ?? '',
        category: (json['category'] as String?) ?? 'All',
        source: json['source'] == 'custom' ? AgentSource.custom : AgentSource.teamly,
        pastelIndex: (json['pastelIndex'] as num?)?.toInt() ?? 0,
        friends: json['friends'] == true,
      );
}

/// The category rail, in reference order. "All" is always first and selected
/// on entry; the rail scrolls horizontally and clips the last chip on purpose.
const List<String> kAgentCategories = <String>[
  'All',
  'Content Creation',
  'Customer Support',
  'Data Analysis',
  'Engineering',
  'Media',
  'Productivity',
];

/// The seeded official catalogue — exactly the five agents visible in the
/// reference screenshot, plus a few so the rail has content under each filter.
const List<Agent> kSeedAgents = <Agent>[
  Agent(
    id: 'content-creator',
    name: 'Content Creator',
    description:
        'Expert content strategist and creator for multi-platform campaigns. Develops narratives that hold attention.',
    category: 'Content Creation',
    pastelIndex: 0,
  ),
  Agent(
    id: 'frontend-developer',
    name: 'Frontend Developer',
    description:
        'Expert frontend developer specializing in modern web technologies, component architecture and performance.',
    category: 'Engineering',
    pastelIndex: 1,
  ),
  Agent(
    id: 'backend-architect',
    name: 'Backend Architect',
    description:
        'Senior backend architect specializing in scalable system design, database modelling and service boundaries.',
    category: 'Engineering',
    pastelIndex: 2,
  ),
  Agent(
    id: 'ai-engineer',
    name: 'AI Engineer',
    description:
        'Expert AI/ML engineer specializing in machine learning model development, evaluation and deployment.',
    category: 'Data Analysis',
    pastelIndex: 2,
  ),
  Agent(
    id: 'short-video-coach',
    name: 'Short-Video Editing Coach',
    description: 'Hands-on short-video editing coach',
    category: 'Media',
    pastelIndex: 2,
  ),
  Agent(
    id: 'support-lead',
    name: 'Customer Support Lead',
    description:
        'Expert support lead specializing in triage playbooks, tone-of-voice guidelines and escalation paths.',
    category: 'Customer Support',
    pastelIndex: 3,
  ),
  Agent(
    id: 'data-analyst',
    name: 'Data Analyst',
    description:
        'Expert analyst specializing in SQL modelling, funnel analysis and turning raw exports into decisions.',
    category: 'Data Analysis',
    pastelIndex: 0,
  ),
  Agent(
    id: 'ops-assistant',
    name: 'Operations Assistant',
    description:
        'Expert operations assistant specializing in runbooks, weekly reviews and keeping commitments on track.',
    category: 'Productivity',
    pastelIndex: 3,
  ),
];

/// The seeded Agent Teams, matching the two group chats in the Chat reference.
const List<AgentTeam> kSeedTeams = <AgentTeam>[
  AgentTeam(
    id: 'feature-build-room',
    name: 'AI Feature Build Room',
    roles: <String>['AI Engineer', 'Prompt Engineer', 'Data Engineer', 'Frontend Developer'],
    memberCount: 4,
  ),
  AgentTeam(
    id: 'code-review-guild',
    name: 'Code Review Guild',
    roles: <String>['Code Reviewer', 'Senior Developer', 'Git Workflow Master'],
    memberCount: 3,
  ),
];

/// Build-time helper used by the Agents screen for the segmented control.
enum AgentMode { agents, automations }