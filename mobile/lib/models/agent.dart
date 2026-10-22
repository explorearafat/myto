/// ---------------------------------------------------------------------------
/// Agents model — the Chat roster and the Rooms.
///
/// The roster is the catalogue of 1-to-1 chat partners (QA Tester, Doctor,
/// Bug Analyzer, ...) and the rooms are group chats where those agents
/// discuss a problem together and hand back a report. Every agent has a
/// unique `seed` + `glyph` pair so the app can generate a distinct SVG-style
/// avatar for each one (see widgets/agent_avatar.dart).
///
/// The app ships with NO demo data: no fake notifications, no seeded
/// conversations. This roster is the product catalogue the user asked for.
/// ---------------------------------------------------------------------------

/// Where an agent came from: the official catalogue, or one the user built.
enum AgentSource { teamly, custom }

/// A named room of agents — the "Rooms" section. Chats in a room are group
/// chats whose members research the user's problem and produce a report.
class AgentTeam {
  const AgentTeam({
    required this.id,
    required this.name,
    required this.roles,
    this.memberCount = 0,
    this.agentIds = const <String>[],
  });

  final String id;
  final String name;

  /// The comma-separated role list shown as the row subtitle.
  final List<String> roles;

  /// The agent ids in this room, in speaking order.
  final List<String> agentIds;
  final int memberCount;

  /// The subtitle exactly as the reference formats it: roles truncated at
  /// three plus an ellipsis when there are more.
  String get subtitle {
    if (roles.isEmpty) return '$memberCount agents';
    if (roles.length <= 3) return roles.join(', ');
    return '${roles.take(3).join(', ')},...';
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'roles': roles,
        'agentIds': agentIds,
        'memberCount': memberCount,
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
    this.glyph = 'chat',
    this.seed = 0,
    this.prompt = '',
  });

  final String id;
  final String name;

  /// The resume-style one-liner shown under the name.
  final String description;
  final String category;
  final AgentSource source;

  /// Legacy pastel disc index (kept for the old teamly kit).
  final int pastelIndex;

  /// Social relationship state.
  final bool friends;

  /// Which glyph the generated avatar draws (see agent_avatar.dart).
  final String glyph;

  /// Deterministic seed for the generated avatar (colours + pattern).
  final int seed;

  /// System prompt used when this agent chats 1-to-1 or inside a room.
  final String prompt;

  Agent copyWith({bool? friends}) => Agent(
        id: id,
        name: name,
        description: description,
        category: category,
        source: source,
        pastelIndex: pastelIndex,
        friends: friends ?? this.friends,
        glyph: glyph,
        seed: seed,
        prompt: prompt,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'description': description,
        'category': category,
        'source': source.name,
        'pastelIndex': pastelIndex,
        'friends': friends,
        'glyph': glyph,
        'seed': seed,
        'prompt': prompt,
      };

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? 'Agent',
        description: (json['description'] as String?) ?? '',
        category: (json['category'] as String?) ?? 'All',
        source: json['source'] == 'custom' ? AgentSource.custom : AgentSource.teamly,
        pastelIndex: (json['pastelIndex'] as num?)?.toInt() ?? 0,
        friends: json['friends'] == true,
        glyph: (json['glyph'] as String?) ?? 'chat',
        seed: (json['seed'] as num?)?.toInt() ?? 0,
        prompt: (json['prompt'] as String?) ?? '',
      );
}

/// The category rail, in reference order. "All" is always first.
const List<String> kAgentCategories = <String>[
  'All',
  'Engineering',
  'Health',
  'Finance',
  'Business',
  'Data Analysis',
  'Media',
  'Customer Support',
];

/// The official 1-to-1 roster — the chat partners the user asked for. Each
/// has a unique `glyph` + `seed` so its generated avatar is distinct.
const List<Agent> kSeedAgents = <Agent>[
  Agent(
    id: 'qa-tester',
    name: 'QA Tester',
    description:
        'Expert QA engineer specializing in test cases, edge cases and reproducible bug reports.',
    category: 'Engineering',
    pastelIndex: 0,
    glyph: 'bug',
    seed: 1,
    prompt:
        'You are a QA Tester. Help the user test their product: write clear test cases, cover edge cases, reproduce reported bugs step by step, and propose a test plan.',
  ),
  Agent(
    id: 'doctor',
    name: 'Doctor',
    description:
        'Caring health advisor sharing general medical information — never a substitute for a real doctor.',
    category: 'Health',
    pastelIndex: 1,
    glyph: 'med',
    seed: 2,
    prompt:
        'You are a Doctor-style health advisor. Give general, responsible health information and lifestyle guidance. Always add that this is not a substitute for a real medical consultation.',
  ),
  Agent(
    id: 'bug-analyzer',
    name: 'Bug Analyzer',
    description:
        'Expert debugger specializing in stack traces, logs and root-cause analysis.',
    category: 'Engineering',
    pastelIndex: 2,
    glyph: 'search',
    seed: 3,
    prompt:
        'You are a Bug Analyzer. When the user shares a stack trace, log or symptom, find the root cause and propose a concrete fix. Ask for the missing details you need.',
  ),
  Agent(
    id: 'code-reviewer',
    name: 'Code Reviewer',
    description:
        'Senior code reviewer specializing in readability, correctness, performance and security.',
    category: 'Engineering',
    pastelIndex: 3,
    glyph: 'code',
    seed: 4,
    prompt:
        'You are a Code Reviewer. Review code for correctness, readability, performance and security. Give kind, specific, actionable feedback with examples.',
  ),
  Agent(
    id: 'accounting-agent',
    name: 'Accounting Agent',
    description:
        'Trusted accounting assistant specializing in bookkeeping, invoices and financial reports.',
    category: 'Finance',
    pastelIndex: 0,
    glyph: 'calc',
    seed: 5,
    prompt:
        'You are an Accounting Agent. Help with bookkeeping, invoices, basic tax questions and financial reports. Ask clarifying questions before giving numbers.',
  ),
  Agent(
    id: 'market-researcher',
    name: 'Market Researcher',
    description:
        'Sharp market researcher specializing in competitors, pricing, customers and trends.',
    category: 'Business',
    pastelIndex: 1,
    glyph: 'chart',
    seed: 6,
    prompt:
        'You are a Market Researcher. Research competitors, pricing, customer segments and trends. Summarize findings with evidence and concrete next steps.',
  ),
  Agent(
    id: 'prompt-engineer',
    name: 'Prompt Engineer',
    description:
        'Expert prompt engineer specializing in task breakdowns, constraints and examples.',
    category: 'Engineering',
    pastelIndex: 2,
    glyph: 'spark',
    seed: 7,
    prompt:
        'You are a Prompt Engineer. Help craft and improve prompts: break the task down, add constraints and examples, and iterate until the output is reliable.',
  ),
  Agent(
    id: 'data-analyst',
    name: 'Data Analyst',
    description:
        'Expert analyst specializing in SQL modelling, funnels and turning raw exports into decisions.',
    category: 'Data Analysis',
    pastelIndex: 3,
    glyph: 'data',
    seed: 8,
    prompt:
        'You are a Data Analyst. Help model data, analyze funnels and turn raw exports into decisions. Ask for the data you need and explain the numbers plainly.',
  ),
  Agent(
    id: 'support-lead',
    name: 'Support Lead',
    description:
        'Expert support lead specializing in triage playbooks, tone-of-voice and escalation paths.',
    category: 'Customer Support',
    pastelIndex: 0,
    glyph: 'help',
    seed: 9,
    prompt:
        'You are a Support Lead. Help write support playbooks, customer replies and escalation paths with a warm, professional tone.',
  ),
  Agent(
    id: 'content-creator',
    name: 'Content Creator',
    description:
        'Expert content strategist and creator for multi-platform campaigns.',
    category: 'Media',
    pastelIndex: 1,
    glyph: 'pen',
    seed: 10,
    prompt:
        'You are a Content Creator. Plan and write content: hooks, scripts, captions and posts tailored to the platform and audience.',
  ),
];

/// The rooms — group chats where the roster agents research a problem
/// together and hand back a report. These are the catalogue, not demo data.
const List<AgentTeam> kSeedTeams = <AgentTeam>[
  AgentTeam(
    id: 'quality-bug-room',
    name: 'Quality & Bug Room',
    roles: const <String>['QA Tester', 'Bug Analyzer', 'Code Reviewer', 'Prompt Engineer'],
    agentIds: const <String>['qa-tester', 'bug-analyzer', 'code-reviewer', 'prompt-engineer'],
    memberCount: 4,
  ),
  AgentTeam(
    id: 'startup-research-room',
    name: 'Startup Research Room',
    roles: const <String>['Market Researcher', 'Accounting Agent', 'Data Analyst', 'Content Creator'],
    agentIds: const <String>['market-researcher', 'accounting-agent', 'data-analyst', 'content-creator'],
    memberCount: 4,
  ),
  AgentTeam(
    id: 'code-review-guild',
    name: 'Code Review Guild',
    roles: const <String>['Code Reviewer', 'QA Tester', 'Bug Analyzer'],
    agentIds: const <String>['code-reviewer', 'qa-tester', 'bug-analyzer'],
    memberCount: 3,
  ),
];

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

/// Build-time helper used by the Agents screen for the segmented control.
enum AgentMode { agents, automations }
