/**
 * Curated built-in skills catalog.
 *
 * Skills are pure instruction text — playbooks the model follows once it invokes
 * one. They carry zero runtime cost (no process, no network), so unlike the MCP
 * catalog a small set of *safe essentials* defaults ON (coding, debugging,
 * planning, project analysis, codebase exploration); everything else is opt-in.
 *
 * Context stays lean: only ENABLED skills appear in the prompt's short listing,
 * and a skill's full body is injected only when the model actually invokes it
 * (see the engine's `use_skill` handling) — so a dozen catalog skills cost a few
 * lines of listing, not a dozen playbooks.
 *
 * A few skills declare `requiresMcp`: they lean on a catalog MCP server (e.g.
 * Git, Web Fetch). The UI surfaces that dependency and offers to enable the
 * server — it is never silently enabled. Built-ins are merged with disk-authored
 * skills ({@link ../skills/registry}); a disk skill of the same name overrides
 * the built-in, so users can customize any playbook by dropping a SKILL.md.
 */
import type { SkillCategory, SkillInfo } from '../../shared/types'

/** One curated built-in skill (its full instruction body lives inline). */
export interface SkillCatalogEntry {
  name: string
  title: string
  description: string
  whenToUse: string
  category: SkillCategory
  /** Safe essentials default on; the rest are opt-in. */
  defaultOn: boolean
  recommended: boolean
  /** MCP servers this playbook leans on (surfaced as a dependency in the UI). */
  requiresMcp?: string[]
  /** The playbook injected when the model invokes the skill. */
  instructions: string
}

export const SKILLS_CATALOG: readonly SkillCatalogEntry[] = [
  {
    name: 'coding',
    title: 'Coding',
    description: 'Disciplined implementation: match the codebase, keep changes tight, verify.',
    whenToUse: 'When writing or changing code in the project.',
    category: 'coding',
    defaultOn: true,
    recommended: true,
    instructions: [
      'Follow this implementation discipline:',
      '1. Read the surrounding code first. Match its naming, structure, error handling, and comment density — new code should read like it was always there.',
      '2. Prefer the smallest change that fully solves the problem. Do not refactor unrelated code, rename things, or add abstractions that are not needed yet.',
      '3. Reuse existing helpers, types, and patterns instead of introducing new dependencies.',
      '4. Handle the edge cases the surrounding code handles (nulls, empties, errors); do not silently swallow failures.',
      '5. After editing, re-read your change in context and check it compiles/type-checks and that names resolve.',
      '6. Keep comments about *why*, not *what*; only where the reason is non-obvious.'
    ].join('\n')
  },
  {
    name: 'debugging',
    title: 'Debugging',
    description: 'Trace a failure from its error text to the root cause — not guess-and-patch.',
    whenToUse: 'When something is broken, failing, crashing, or behaving unexpectedly.',
    category: 'debugging',
    defaultOn: true,
    recommended: true,
    instructions: [
      'Debug by tracing to the root cause, not by guessing:',
      '1. Anchor on the exact error text. Search the codebase for the literal message (and any framework-specific wording) to find where it is THROWN — the throw site, not just where it surfaced.',
      '2. Find what CATCHES it — a try/catch, an error boundary, a top-level handler. That tells you the blast radius and why the user saw what they saw.',
      '3. Trace from the throw site back to the trigger through the call chain AND the framework lifecycle. Where a thrown error lands depends on context — e.g. a throw in a UI render/effect is caught very differently from one in an event handler or an already-awaited async path.',
      '4. Pin the trigger condition — why it happens now, or only sometimes. Read the state and timing that drive the failing call; intermittent failures are usually races, ordering, or lifecycle timing. Correlate with WHEN the user sees it ("only during big tasks", "on the second click").',
      '5. Reproduce if you can — establish the exact input, expected result, and actual result. If you cannot reproduce on demand, reason statically from the throw site and the trigger you found rather than stalling.',
      '6. Test one hypothesis at a time with the cheapest possible check (a targeted read, a log, a minimal run). If a change you made to test it was not the cause, revert it before moving on.',
      '7. Fix the root cause at its source — usually a guard, an ordering fix, or a corrected precondition — not the symptom. Then confirm the original failure is gone, check no adjacent behavior broke, and add a regression test that fails without the fix.'
    ].join('\n')
  },
  {
    name: 'planning',
    title: 'Planning',
    description: 'Break a non-trivial task into an ordered, verifiable plan before coding.',
    whenToUse: 'Before starting a multi-step or ambiguous change.',
    category: 'planning',
    defaultOn: true,
    recommended: true,
    instructions: [
      'Before writing code for a substantial task:',
      '1. Restate the goal in one sentence and list the concrete acceptance criteria.',
      '2. Identify the files/modules involved and the order of changes (dependencies first).',
      '3. Break the work into small, independently verifiable steps.',
      '4. Call out risks, unknowns, and anything that needs a decision — surface these instead of guessing.',
      '5. Prefer a plan that can be validated incrementally (each step leaves the project runnable).',
      'Keep the plan proportional to the task; do not over-plan a one-line fix.'
    ].join('\n')
  },
  {
    name: 'project-analysis',
    title: 'Project Analysis',
    description: 'Quickly build an accurate mental model of an unfamiliar codebase.',
    whenToUse: 'When you need to understand how the project is structured or how a feature works.',
    category: 'project',
    defaultOn: true,
    recommended: true,
    instructions: [
      'To understand the project:',
      '1. Start from the entry points and configuration (package.json/build config, main/index files) to learn the stack and how it runs.',
      '2. Map the top-level directory layout to responsibilities before diving into files.',
      '3. Trace one representative flow end to end (e.g. a request, a command, a render) to see how the layers connect.',
      '4. Note the conventions actually in use (state management, error handling, testing) — follow them, do not impose your own.',
      '5. Summarize findings as file:line references so they are verifiable, not vague.'
    ].join('\n')
  },
  {
    name: 'codebase-exploration',
    title: 'Codebase Exploration',
    description: 'Efficiently locate the right code with search instead of reading everything.',
    whenToUse: 'When you need to find where something lives or is used.',
    category: 'coding',
    defaultOn: true,
    recommended: true,
    instructions: [
      'Search efficiently:',
      '1. Search for concrete symbols — function names, error strings, config keys — rather than reading files top to bottom.',
      '2. Find both the definition and the call sites before changing a shared symbol, so you catch every impact.',
      '3. Widen or narrow the query based on hit count; a few precise hits beat a broad scan.',
      '4. Confirm a match by reading the surrounding lines, not just the matching line.',
      '5. Cite what you find as file:line so it can be opened directly.'
    ].join('\n')
  },
  {
    name: 'testing',
    title: 'Testing',
    description: 'Write and run focused tests that actually pin the behavior.',
    whenToUse: 'When adding tests or verifying a change with tests.',
    category: 'testing',
    defaultOn: false,
    recommended: true,
    instructions: [
      'When testing:',
      '1. Match the project’s existing test framework, file layout, and naming — do not introduce a new runner.',
      '2. Test observable behavior and edge cases (empty, boundary, error paths), not implementation details.',
      '3. Keep each test independent and deterministic; avoid shared mutable state and real time/network.',
      '4. Write the test so it fails for the right reason before you make it pass.',
      '5. Run the suite and report the actual result. If a test fails, show the output — never claim green without running it.'
    ].join('\n')
  },
  {
    name: 'code-review',
    title: 'Code Review',
    description: 'Review a change for correctness, edge cases, and clarity.',
    whenToUse: 'When asked to review code or before finalizing a change.',
    category: 'coding',
    defaultOn: false,
    recommended: false,
    instructions: [
      'Review with this priority order:',
      '1. Correctness — does it do what it claims, including edge cases and error paths?',
      '2. Safety — inputs validated, no injection/path-escape, secrets not logged, resources released.',
      '3. Fit — consistent with surrounding conventions; no needless new abstraction or dependency.',
      '4. Clarity — names and structure make intent obvious; comments explain non-obvious *why*.',
      'Report findings most-severe first, each with a concrete file:line and the failure it causes. Distinguish real defects from style nits.'
    ].join('\n')
  },
  {
    name: 'refactoring',
    title: 'Refactoring',
    description: 'Improve structure safely without changing behavior.',
    whenToUse: 'When restructuring code that should keep the same behavior.',
    category: 'coding',
    defaultOn: false,
    recommended: false,
    instructions: [
      'Refactor safely:',
      '1. Confirm there is a way to verify behavior is unchanged (tests or a reproducible run) BEFORE you start.',
      '2. Make one behavior-preserving transformation at a time; keep the project runnable between steps.',
      '3. Do not mix refactoring with behavior changes in the same step — separate them.',
      '4. Update all call sites and types when you move or rename; do not leave dangling references.',
      '5. Re-verify after each meaningful step and at the end.'
    ].join('\n')
  },
  {
    name: 'documentation',
    title: 'Documentation',
    description: 'Write clear docs, comments, and READMEs that stay accurate.',
    whenToUse: 'When writing or updating documentation or code comments.',
    category: 'documentation',
    defaultOn: false,
    recommended: false,
    instructions: [
      'When documenting:',
      '1. Lead with what the reader needs to do; put the common case first.',
      '2. Keep it accurate to the current code — verify names, commands, and paths against the source.',
      '3. Prefer a short runnable example over prose.',
      '4. For code comments, explain the *why* and any non-obvious constraint; do not restate the code.',
      '5. Match the surrounding doc style and formatting.'
    ].join('\n')
  },
  {
    name: 'git-workflow',
    title: 'Git Workflow',
    description: 'Inspect history and craft focused commits using the Git MCP server.',
    whenToUse: 'When working with commits, diffs, branches, or history.',
    category: 'git',
    defaultOn: false,
    recommended: false,
    requiresMcp: ['git'],
    instructions: [
      'For Git work (use the Git MCP server’s tools to inspect state):',
      '1. Check status and the diff before committing — know exactly what is staged.',
      '2. Group related changes into one focused commit; keep unrelated changes out.',
      '3. Write a concise, imperative commit subject explaining *why*, with detail in the body if needed.',
      '4. Never commit secrets, large artifacts, or unrelated files.',
      '5. Only commit or push when the user asks; on the default branch, create a branch first.'
    ].join('\n')
  },
  {
    name: 'web-research',
    title: 'Web Research',
    description: 'Gather and verify information from the web using the Web Fetch MCP server.',
    whenToUse: 'When a task needs up-to-date external information.',
    category: 'research',
    defaultOn: false,
    recommended: false,
    requiresMcp: ['fetch'],
    instructions: [
      'When researching (use the Web Fetch MCP server to read pages):',
      '1. Prefer primary/official sources; corroborate a claim with a second source before relying on it.',
      '2. Note the date — prefer current information and flag anything that may be stale.',
      '3. Extract only what answers the question; do not paste whole pages.',
      '4. Distinguish what a source states from your own inference.',
      '5. Cite the URLs you actually used.'
    ].join('\n')
  },
  {
    name: 'performance',
    title: 'Performance',
    description: 'Find and fix the real bottleneck with evidence, not guesses.',
    whenToUse: 'When something is slow or needs optimization.',
    category: 'performance',
    defaultOn: false,
    recommended: false,
    instructions: [
      'Optimize with evidence:',
      '1. Measure first — establish a baseline and find the actual hot path. Do not optimize by intuition.',
      '2. Fix the dominant cost (algorithmic complexity, N+1 work, redundant I/O) before micro-tuning.',
      '3. Change one thing at a time and re-measure against the baseline to confirm it helped.',
      '4. Guard correctness — an optimization that changes results is a bug.',
      '5. Report the before/after numbers.'
    ].join('\n')
  },
  {
    name: 'security-review',
    title: 'Security Review',
    description: 'Audit code for common vulnerabilities and unsafe handling.',
    whenToUse: 'When reviewing code for security issues.',
    category: 'security',
    defaultOn: false,
    recommended: false,
    instructions: [
      'Audit for security (defensive review only):',
      '1. Validate and sanitize all external input; watch for injection (SQL, shell, path traversal) and unsafe deserialization.',
      '2. Check authn/authz on every sensitive path — no missing checks, no trusting client-supplied identity.',
      '3. Ensure secrets are never hardcoded or logged; sensitive data is handled and stored safely.',
      '4. Verify safe defaults, least privilege, and that errors do not leak internals.',
      '5. Report each issue with its location, impact, and a concrete remediation.'
    ].join('\n')
  }
]

/**
 * Turns a catalog entry into the {@link SkillInfo} shape the engine/UI consume.
 * Built-ins have no on-disk path.
 */
function toSkillInfo(entry: SkillCatalogEntry): SkillInfo {
  return {
    name: entry.name,
    title: entry.title,
    description: entry.description,
    whenToUse: entry.whenToUse,
    instructions: entry.instructions,
    source: 'builtin',
    path: '',
    category: entry.category,
    builtIn: true,
    defaultOn: entry.defaultOn,
    recommended: entry.recommended,
    requiresMcp: entry.requiresMcp ?? []
  }
}

/**
 * Merges the built-in catalog with disk-authored skills. Built-ins come first;
 * a disk skill of the same name overrides its built-in (users can customize any
 * playbook by dropping a `SKILL.md`). Kept out of the pure disk loader/registry
 * so those stay easily testable — this is the single merge point the engine and
 * skills IPC both call.
 */
export function mergeSkillCatalog(diskSkills: SkillInfo[]): SkillInfo[] {
  const merged = new Map<string, SkillInfo>()
  for (const entry of SKILLS_CATALOG) merged.set(entry.name, toSkillInfo(entry))
  for (const skill of diskSkills) merged.set(skill.name, skill)
  return [...merged.values()]
}
