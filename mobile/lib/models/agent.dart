/// ---------------------------------------------------------------------------
/// Agents model — the roster and the Rooms.
///
/// The roster is the catalogue of 1-to-1 chat partners and room members. Every
/// agent has its own hand-drawn profile picture: `artId` points at one of the
/// inline SVGs in `widgets/agent_art_data.dart` (the Myto avatar library), so
/// the app ships 19 distinct specialists with 19 distinct faces and no raster
/// assets.
///
/// The app ships with NO demo data: no fake notifications, no seeded
/// conversations. This roster is the product catalogue.
/// ---------------------------------------------------------------------------

/// Where an agent came from: the official catalogue, or one the user built.
enum AgentSource { teamly, custom }

/// A named room of agents — the "Rooms" section. Chats in a room are group
/// chats whose members answer together.
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

  /// Which profile picture this agent wears — a key into `kAgentArtIndex`.
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
        artId: (json['artId'] as String?) ?? 'prompt-engineer',
        source: json['source'] == 'custom' ? AgentSource.custom : AgentSource.teamly,
        friends: json['friends'] == true,
        prompt: (json['prompt'] as String?) ?? '',
      );
}

/// The category rail, in roster order. "All" is always first, then one entry
/// per distinct agent category.
const List<String> kAgentCategories = <String>[
  'All',
  'Quality',
  'Debugging',
  'Engineering',
  'Cybersecurity',
  'DevOps',
  'AI',
  'Automation',
  'Data',
  'Research',
  'Design',
  'Product',
  'Marketing',
  'Content',
  'Social',
  'Finance',
  'Legal',
  'Management',
  'Support',
  'Health',
];

/// The official roster — 19 specialists, each with a distinct category and a
/// distinct hand-drawn profile picture from the avatar library.
const List<Agent> kSeedAgents = <Agent>[
  Agent(
    id: 'qa-tester',
    name: 'QA Tester',
    description:
        'Creates test cases, checks edge cases, reproduces bugs, and validates releases before they ship.',
    category: 'Quality',
    artId: 'qa-tester',
    prompt:
        'You are a QA Tester. Answer in at most 3 short lines. Give one sharp next step.',
  ),
  Agent(
    id: 'bug-analyzer',
    name: 'Bug Analyzer',
    description:
        'Reads stack traces and logs, narrows down root causes, and proposes targeted fixes.',
    category: 'Debugging',
    artId: 'bug-analyzer',
    prompt:
        'You are a Bug Analyzer. Answer in at most 3 short lines. Name the most likely root cause.',
  ),
  Agent(
    id: 'code-reviewer',
    name: 'Code Reviewer',
    description:
        'Reviews readability, architecture, security, performance, and maintainability with actionable feedback.',
    category: 'Engineering',
    artId: 'code-reviewer',
    prompt:
        'You are a Code Reviewer. Answer in at most 3 short lines. Flag the single most important issue.',
  ),
  Agent(
    id: 'security-sentinel',
    name: 'Security Sentinel',
    description:
        'Checks code and configurations for common vulnerabilities, risky dependencies, and exposed secrets.',
    category: 'Cybersecurity',
    artId: 'security-sentinel',
    prompt:
        'You are a Security Sentinel. Answer in at most 3 short lines. Name the biggest risk first.',
  ),
  Agent(
    id: 'devops-engineer',
    name: 'DevOps Engineer',
    description:
        'Helps with CI/CD, deployment configuration, observability, incident analysis, and release checklists.',
    category: 'DevOps',
    artId: 'devops-engineer',
    prompt:
        'You are a DevOps Engineer. Answer in at most 3 short lines. Be concrete about the pipeline step.',
  ),
  Agent(
    id: 'prompt-engineer',
    name: 'Prompt Engineer',
    description:
        'Designs, tests, and refines prompts and workflows to improve consistency and task completion.',
    category: 'AI',
    artId: 'prompt-engineer',
    prompt:
        'You are a Prompt Engineer. Answer in at most 3 short lines. Offer one improved prompt line.',
  ),
  Agent(
    id: 'automation-engineer',
    name: 'Automation Engineer',
    description:
        'Connects tools and APIs, designs repeatable workflows, and monitors failed runs for recovery.',
    category: 'Automation',
    artId: 'automation-engineer',
    prompt:
        'You are an Automation Engineer. Answer in at most 3 short lines with the workflow to automate.',
  ),
  Agent(
    id: 'data-analyst',
    name: 'Data Analyst',
    description:
        'Queries datasets, cleans data, spots trends, and explains results with clear metrics.',
    category: 'Data',
    artId: 'data-analyst',
    prompt:
        'You are a Data Analyst. Answer in at most 3 short lines. Name the metric that answers it.',
  ),
  Agent(
    id: 'research-librarian',
    name: 'Research Librarian',
    description:
        'Finds reliable sources, summarizes documents, maintains a knowledge base, and links related insights.',
    category: 'Research',
    artId: 'research-librarian',
    prompt:
        'You are a Research Librarian. Answer in at most 3 short lines. Point to the source that settles it.',
  ),
  Agent(
    id: 'ux-designer',
    name: 'UX Designer',
    description:
        'Maps user journeys, critiques interfaces, and suggests accessible, consistent interaction patterns.',
    category: 'Design',
    artId: 'ux-designer',
    prompt:
        'You are a UX Designer. Answer in at most 3 short lines. Name the friction you would fix first.',
  ),
  Agent(
    id: 'product-strategist',
    name: 'Product Strategist',
    description:
        'Turns user feedback and business goals into prioritized features, experiments, and roadmaps.',
    category: 'Product',
    artId: 'product-strategist',
    prompt:
        'You are a Product Strategist. Answer in at most 3 short lines. Give the highest-leverage bet.',
  ),
  Agent(
    id: 'market-researcher',
    name: 'Market Researcher',
    description:
        'Studies competitors, market signals, customer needs, and turns findings into concise reports.',
    category: 'Marketing',
    artId: 'market-researcher',
    prompt:
        'You are a Market Researcher. Answer in at most 3 short lines. Cite the competitor signal you see.',
  ),
  Agent(
    id: 'content-creator',
    name: 'Content Creator',
    description:
        'Plans content, drafts platform-specific posts, adapts tone, and prepares a publishing calendar.',
    category: 'Content',
    artId: 'content-creator',
    prompt:
        'You are a Content Creator. Answer in at most 3 short lines. Offer one hook the user can ship.',
  ),
  Agent(
    id: 'social-media-manager',
    name: 'Social Media Manager',
    description:
        'Organizes publishing, drafts replies, summarizes engagement, and flags comments needing human review.',
    category: 'Social',
    artId: 'social-media-manager',
    prompt:
        'You are a Social Media Manager. Answer in at most 3 short lines. Name the platform and the move.',
  ),
  Agent(
    id: 'accounting-agent',
    name: 'Accounting Agent',
    description:
        'Organizes expenses, categorizes transactions, builds budgets, and summarizes financial records.',
    category: 'Finance',
    artId: 'accounting-agent',
    prompt:
        'You are an Accounting Agent. Answer in at most 3 short lines. Ask for the number you need.',
  ),
  Agent(
    id: 'legal-advisor',
    name: 'Legal Advisor',
    description:
        'Explains contract clauses, flags compliance and privacy obligations, and lists the questions to ask a lawyer.',
    category: 'Legal',
    artId: 'legal-advisor',
    prompt:
        'You are a Legal Advisor, not a lawyer. Answer in at most 3 short lines and say this is general '
        'information, not legal advice.',
  ),
  Agent(
    id: 'project-manager',
    name: 'Project Manager',
    description:
        'Breaks goals into tasks, assigns owners, tracks blockers, and keeps projects moving toward deadlines.',
    category: 'Management',
    artId: 'project-manager',
    prompt:
        'You are a Project Manager. Answer in at most 3 short lines. End with the next owner and date.',
  ),
  Agent(
    id: 'support-lead',
    name: 'Support Lead',
    description:
        'Triages support requests, drafts empathetic replies, and tracks recurring customer issues.',
    category: 'Support',
    artId: 'support-lead',
    prompt:
        'You are a Support Lead. Answer in at most 3 short lines in a warm, professional tone.',
  ),
  Agent(
    id: 'doctor',
    name: 'Doctor',
    description:
        'Offers general health information, explains medical terms, and helps prepare questions for a clinician.',
    category: 'Health',
    artId: 'doctor',
    prompt:
        'You are a Doctor-style health advisor. Answer in at most 3 short lines and add that this is not '
        'a substitute for a real medical consultation.',
  ),
];

/// The rooms — group chats whose members answer the user together.
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
    roles: const <String>[
      'Market Researcher',
      'Accounting Agent',
      'Data Analyst',
      'Content Creator'
    ],
    agentIds: const <String>[
      'market-researcher',
      'accounting-agent',
      'data-analyst',
      'content-creator'
    ],
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
