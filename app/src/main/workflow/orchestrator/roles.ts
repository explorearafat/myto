/**
 * Role registry — the capability-based replacement for the engine's old
 * three-arm `roleDirective` switch.
 *
 * Each role is an {@link AgentRoleDef}: a system directive (its mandate +
 * constraints, injected into the subagent prompt), the {@link Capability} set
 * that governs its tool/MCP/skill scoping, and how much project context it
 * receives. Roles live in a `Map`, so **adding a specialist is one entry** — the
 * orchestrator, planner, and prompt builder all resolve roles through here and
 * need no change (requirement: extensible capability-based roles, no giant
 * if/else).
 *
 * The core loop roles are `explorer` (read-only mapping), `editor` (edits, no
 * shell), `test-runner` (runs checks, no edits), and `reviewer` (static
 * read-only review); `lead`/`planner`/`builder` and the domain specialists
 * (frontend, backend, database, …) round out the registry. Adding a role is one
 * `define(...)` entry — the orchestrator, planner, and prompt builder all resolve
 * roles through here and need no change.
 *
 * Pure data + lookups — no Electron/engine imports — so it is unit-testable and
 * safe to import from both the engine and `toolStream.ts` (spawn-role
 * validation).
 */
import type { AgentRole } from '../../../shared/types'
import type { Capability } from './capabilities'

/**
 * How much project context a role's prompt carries:
 *  - `full`    → the whole project overview (lead / analyst / integration —
 *    roles that must reason over the entire codebase).
 *  - `scoped`  → its task brief + the findings of its upstream dependencies
 *    only (the default for a specialist working one slice).
 *  - `minimal` → its task brief only (the reviewer verifies from the report +
 *    what it can run, not the whole tree).
 */
export type ContextScope = 'full' | 'scoped' | 'minimal'

/** A role definition in the registry. */
export interface AgentRoleDef {
  /** Registry key (matches {@link AgentRole}); referenced by task nodes. */
  id: string
  /** Human-facing label for the UI. */
  title: string
  /**
   * The role's mandate + constraints, appended to the subagent system prompt.
   * No leading newline — {@link roleDirective} adds the separator so the
   * engine's prompt-assembly contract is unchanged.
   */
  systemDirective: string
  /** Permissions that drive tool/MCP/skill scoping (see capabilities.ts). */
  capabilities: Capability[]
  /** How much project context this role receives. */
  contextScope: ContextScope
  /**
   * Soft word budget for this role's handoff report. The engine truncates the
   * subagent's report to this many words (via `capWords`) before it reaches the
   * orchestrator, so no single agent floods the lead's context. Omit to use
   * {@link DEFAULT_REPORT_WORDS}. The explorer gets a larger budget because it
   * hands back key code snippets, not just prose.
   */
  reportWords?: number
  /**
   * Per-finding char cap for this role on the shared-context blackboard. Omit to
   * use the blackboard's default. The explorer raises it so its snippets aren't
   * clipped; every other role keeps the tight default.
   */
  detailChars?: number
}

const ROLES = new Map<string, AgentRoleDef>()

/** Registers a role and returns it (used to seed the built-ins). */
function define(def: AgentRoleDef): AgentRoleDef {
  ROLES.set(def.id, def)
  return def
}

// ── Historical roles — directives preserved verbatim from the old switch ──────

define({
  id: 'lead',
  title: 'Lead',
  // The lead's prompt is built by the engine's buildMessages (not the subagent
  // builder), so this directive is never appended; it exists so the lead has a
  // full-capability registry entry for tool scoping on the SIMPLE path.
  systemDirective: '',
  capabilities: [
    'filesystem',
    'terminal',
    'git',
    'web',
    'browser',
    'db',
    'code-exec',
    'testing',
    'image',
    'mcp',
    'skills'
  ],
  contextScope: 'full'
})

define({
  id: 'planner',
  title: 'Planner',
  systemDirective:
    'You are the PLANNER subagent. Produce or refine `plan.md` at the project root: the ' +
    'goal in one line, the files to create or modify, and the work as a numbered, checkable ' +
    'list (`- [ ]` items). Write it with a write_file block. Do NOT implement the feature ' +
    'yourself. Finish with a 2–4 line summary of the plan for the lead.',
  capabilities: ['filesystem', 'skills'],
  contextScope: 'full'
})

define({
  id: 'builder',
  title: 'Builder',
  systemDirective:
    'You are the BUILDER subagent. Implement exactly the slice the lead assigned — create ' +
    'or edit the needed files with write_file blocks and run any required commands, in small ' +
    'think → act → think steps. If a `plan.md` exists, check off (`- [x]`) each item you ' +
    'complete. Finish with a short report of what you built and anything still open.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'testing', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'reviewer',
  title: 'Reviewer',
  systemDirective:
    'You are the REVIEWER subagent. Statically review the changes: read the touched files ' +
    '(read_file) and grep for related call sites (search_files), then judge correctness, ' +
    'edge cases, and consistency with the surrounding code. Do NOT edit files and do NOT run ' +
    'commands — you report, you don’t fix. Finish in under 200 words: either concrete issues ' +
    'as `path:line — what is wrong` bullets, or exactly “No issues found.”',
  // Read-only: a reviewer inspects code but must never edit it or shell out. `read`
  // is always permitted regardless of capabilities, so `skills` alone is enough.
  capabilities: ['skills'],
  // `minimal`: the reviewer verifies against the plan + a compact execution
  // roll-up (what each node did), not the full finding firehose — this is the
  // digest `summarizeForAgent` builds for the REVIEW stage.
  contextScope: 'minimal',
  reportWords: 200
})

// ── Core execution roles (the everyday explore → edit → test → review loop) ──

define({
  id: 'explorer',
  title: 'Explorer',
  systemDirective:
    'You are the EXPLORER subagent. Read-only: locate the code that matters for the task with ' +
    'read_file / search_files / list_files. Do NOT write files or run commands. Hand back a ' +
    'map, not a data dump: the relevant file paths with line ranges, a one-line note on what ' +
    'each does, and the few short code snippets the editor will actually need to make the ' +
    'change. Never paste whole files. Keep it under ~350 words including snippets.',
  // Read-only explorer: `skills` only (read is always allowed); no filesystem/terminal.
  capabilities: ['skills'],
  contextScope: 'full',
  reportWords: 350,
  detailChars: 1800
})

define({
  id: 'editor',
  title: 'Editor',
  systemDirective:
    'You are the EDITOR subagent. You make the code change and nothing else: read_file to ' +
    'confirm context, then edit_file / write_file to apply it, in small think → act → think ' +
    'steps. You CANNOT run commands — do not attempt to build or test. Prefer the snippets the ' +
    'explorer gave you over re-reading whole files. Finish in under 150 words: what you ' +
    'changed, which files, and anything still open.',
  capabilities: ['filesystem', 'skills'],
  contextScope: 'scoped',
  reportWords: 150
})

define({
  id: 'test-runner',
  title: 'Test Runner',
  systemDirective:
    'You are the TEST-RUNNER subagent. Run the project’s tests / typecheck / lint with ' +
    'run_command and read the output — that is all you do. Do NOT edit files. Report only the ' +
    'verdict, never the full log: “N passed, M failed”, and for each failure the test name ' +
    'plus the one- or two-line assertion/error message. Keep it under 120 words.',
  // Runs commands but cannot edit: no filesystem.
  capabilities: ['terminal', 'testing', 'code-exec'],
  contextScope: 'minimal',
  reportWords: 120
})

// ── Specialist roles (new) ────────────────────────────────────────────────

define({
  id: 'project-analyst',
  title: 'Project Analyst',
  systemDirective:
    'You are the PROJECT ANALYST. Study the project context and the task, then report the ' +
    'facts the team needs: the relevant files, existing conventions, entry points, and any ' +
    'constraints or risks. Do NOT write code or run commands — you produce findings only. ' +
    'Finish with a concise, structured summary the planner and specialists can build on.',
  capabilities: ['web', 'skills'],
  contextScope: 'full'
})

define({
  id: 'frontend',
  title: 'Frontend Engineer',
  systemDirective:
    'You are the FRONTEND specialist. Implement the UI/client slice you were assigned — ' +
    'components, state, styling, and wiring — with write_file blocks, in small ' +
    'think → act → think steps. Match the project’s existing framework and conventions. ' +
    'Finish with a short report of the files you changed and anything still open.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'backend',
  title: 'Backend Engineer',
  systemDirective:
    'You are the BACKEND specialist. Implement the server/API/business-logic slice you were ' +
    'assigned with write_file blocks, in small think → act → think steps, following the ' +
    'project’s existing structure. Run any commands needed to wire or verify it. Finish with ' +
    'a short report of the files you changed and anything still open.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'database',
  title: 'Database Engineer',
  systemDirective:
    'You are the DATABASE specialist. Design or modify the schema, migrations, and queries ' +
    'for the assigned slice with write_file blocks. Keep changes backward-compatible where ' +
    'possible and note any migration steps. Finish with a short report of the files you ' +
    'changed and anything still open.',
  capabilities: ['filesystem', 'terminal', 'db', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'security',
  title: 'Security Engineer',
  systemDirective:
    'You are the SECURITY specialist. Harden the assigned slice: validate inputs, close ' +
    'injection/authz/secret-handling gaps, and fix concrete vulnerabilities with write_file ' +
    'blocks. Run any available scanners or checks. Finish with a short report of what you ' +
    'changed and any residual risks the lead should know about.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'research',
  title: 'Researcher',
  systemDirective:
    'You are the RESEARCHER. Gather the external information the task needs — APIs, library ' +
    'usage, docs, comparisons — using web tools. Do NOT write project code. Finish with a ' +
    'concise, sourced summary of what you found and a clear recommendation.',
  capabilities: ['web', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'devops',
  title: 'DevOps Engineer',
  systemDirective:
    'You are the DEVOPS specialist. Implement the build/CI/deploy/config slice you were ' +
    'assigned — scripts, pipelines, containerization, environment wiring — with write_file ' +
    'blocks and run any commands needed to validate them. Finish with a short report of the ' +
    'files you changed and anything still open.',
  capabilities: ['filesystem', 'terminal', 'git', 'code-exec', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'testing',
  title: 'Test Engineer',
  systemDirective:
    'You are the TEST specialist. Write tests that cover the assigned behavior with ' +
    'write_file blocks, then run them and report the results. Cover the happy path plus the ' +
    'edge cases that matter. Finish with a short report of the tests you added and their ' +
    'pass/fail status.',
  capabilities: ['filesystem', 'terminal', 'testing', 'code-exec', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'docs',
  title: 'Documentation Writer',
  systemDirective:
    'You are the DOCS specialist. Write or update the documentation for the assigned change ' +
    '— READMEs, guides, inline reference — with write_file blocks, matching the project’s ' +
    'existing tone. Do NOT change application code. Finish with a short report of the files ' +
    'you changed.',
  capabilities: ['filesystem', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'debugger',
  title: 'Debugger',
  systemDirective:
    'You are the DEBUGGER specialist. Diagnose the specific failure you were handed by tracing it ' +
    'to the root cause: search for the exact error text to find where it is THROWN (read_file / ' +
    'search_files), identify what catches it, and follow the call chain and lifecycle back to the ' +
    'trigger condition — reproduce it where you can, or reason statically from the throw site when ' +
    'you cannot. Confirm the root cause before changing anything, then fix it with the smallest ' +
    'correct edit (edit_file / write_file) and re-run to prove it is resolved. Finish with a short ' +
    'report: the root cause, the fix, and how you verified it.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'testing', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'refactorer',
  title: 'Refactorer',
  systemDirective:
    'You are the REFACTORER specialist. Restructure the assigned code for clarity WITHOUT ' +
    'changing its observable behavior — rename, extract, dedupe, and tidy with edit_file / ' +
    'write_file in small steps. Do not add features or fix unrelated bugs. Run the existing ' +
    'tests/typecheck after your changes to prove behavior is unchanged. Finish with a short ' +
    'report of what you restructured and the check results.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'testing', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'performance',
  title: 'Performance Engineer',
  systemDirective:
    'You are the PERFORMANCE specialist. Optimize the assigned slice: measure first (run the ' +
    'relevant profile/benchmark/command), find the real bottleneck, then apply the change with ' +
    'write_file blocks and measure again to confirm the win. Do not micro-optimize without ' +
    'evidence. Finish with a short report: the bottleneck, the change, and before/after numbers.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'testing', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'accessibility',
  title: 'Accessibility Engineer',
  systemDirective:
    'You are the ACCESSIBILITY specialist. Make the assigned UI slice accessible: correct ' +
    'semantics/roles, labels and alt text, keyboard navigation, focus order, and color ' +
    'contrast, with write_file blocks. Follow WCAG AA. Verify in the live preview where you ' +
    'can. Finish with a short report of what you fixed and any issues that remain.',
  capabilities: ['filesystem', 'terminal', 'browser', 'code-exec', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'api-designer',
  title: 'API Designer',
  systemDirective:
    'You are the API DESIGNER specialist. Design the contract for the assigned interface — ' +
    'endpoints/handlers, request/response shapes, error semantics, and types — and capture it ' +
    'with write_file blocks (schema, types, or a spec document). Favor consistency with the ' +
    'project’s existing API surface and backward compatibility. Do NOT implement the business ' +
    'logic. Finish with a short report of the contract you defined and how it should be used.',
  capabilities: ['filesystem', 'skills'],
  contextScope: 'scoped'
})

define({
  id: 'integration',
  title: 'Integration Engineer',
  systemDirective:
    'You are the INTEGRATION specialist. Combine the specialists’ outputs into a coherent ' +
    'whole: resolve conflicts between overlapping changes, wire the pieces together, and fix ' +
    'the seams with write_file blocks. Run any commands needed to confirm it holds together. ' +
    'Finish with a short report of what you reconciled and anything still open.',
  capabilities: ['filesystem', 'terminal', 'code-exec', 'skills'],
  contextScope: 'full'
})

// ── Lookups ───────────────────────────────────────────────────────────────

/** The fallback role for an unknown id — a safe generalist implementer. */
const FALLBACK_ROLE = 'builder'

/**
 * Default handoff word budget for a role that doesn't set its own — the
 * ~200-word cap on a subagent → orchestrator report (see {@link reportWordBudget}).
 */
export const DEFAULT_REPORT_WORDS = 200

/**
 * The word budget the engine truncates this role's handoff report to before it
 * reaches the orchestrator. Roles declare it via `reportWords`; unset roles use
 * {@link DEFAULT_REPORT_WORDS}.
 */
export function reportWordBudget(id: AgentRole): number {
  return resolveRole(id).reportWords ?? DEFAULT_REPORT_WORDS
}

/** Whether a role id is registered. */
export function hasRole(id: string): boolean {
  return ROLES.has(id)
}

/** The role def for `id`, or `undefined` if it isn't registered. */
export function getRole(id: string): AgentRoleDef | undefined {
  return ROLES.get(id)
}

/**
 * The role def for `id`, falling back to the generalist `builder` when `id`
 * isn't registered — so a stray planner/spawn role never crashes the engine.
 */
export function resolveRole(id: AgentRole): AgentRoleDef {
  return ROLES.get(id) ?? (ROLES.get(FALLBACK_ROLE) as AgentRoleDef)
}

/**
 * Registers (or replaces) a role at runtime — the extensibility hook. A new
 * specialist becomes usable by the planner and orchestrator with no other code
 * change. Returns the registered def.
 */
export function registerRole(def: AgentRoleDef): AgentRoleDef {
  return define(def)
}

/** All registered role ids (used to validate planner/spawn output). */
export function roleIds(): string[] {
  return [...ROLES.keys()]
}

/** All registered role defs (used by the settings UI / diagnostics). */
export function allRoles(): AgentRoleDef[] {
  return [...ROLES.values()]
}

/**
 * The role directive appended to a subagent's system prompt, preserving the
 * engine's old concatenation contract: a `\n\n` separator + the mandate, or ''
 * for a role with no directive (the lead, whose prompt is built elsewhere).
 */
export function roleDirective(id: AgentRole): string {
  const directive = resolveRole(id).systemDirective
  return directive ? `\n\n${directive}` : ''
}
