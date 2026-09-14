/**
 * Planner — turns a work request into the task graph the orchestrator executes.
 *
 * Cost discipline (the "few LLM calls" contract): a **SIMPLE** request never
 * touches the model — it collapses to a single generalist node. Only MEDIUM /
 * COMPLEX requests spend **one** completion, which returns a fenced-JSON plan
 * (tasks with role, dependencies, and file hints). That JSON is parsed
 * defensively and every task is validated against the {@link roles} registry;
 * any malformed output falls back to a single node so a weak model can never
 * stall the run. Writers to the same file are serialized
 * ({@link linkOverlappingWriters}) and the whole set is validated through a
 * {@link TaskGraph} (cycle/dup detection) before it is returned.
 *
 * The planner has no side effects of its own: it renders the plan as markdown
 * and hands it to an injected `writePlan` callback (the orchestrator wires that
 * to `writeProjectFile('plan.md', …)`), keeping this module pure and unit-
 * testable.
 */
import type { ChatMessage, Complexity, ProviderSettings, TaskNode } from '../../../shared/types'
import { providerFromSettings } from '../../providers'
import { toErrorMessage } from '../../providers/http'
import { isAbort } from '../resilience'
import { hasRole, roleIds } from './roles'
import { TaskGraph, linkOverlappingWriters } from './taskGraph'

/** The generalist role used for the SIMPLE path and the parse-failure fallback. */
const FALLBACK_ROLE = 'builder'

/** Upper bound on tasks a plan may contain (guards against a runaway model). */
const MAX_TASKS = 8

/** The outcome of planning: the graph nodes plus the rendered plan.md content. */
export interface PlanResult {
  complexity: Complexity
  /** Validated, ready-to-schedule task nodes (all `state: 'pending'`). */
  tasks: TaskNode[]
  /** The plan rendered as `plan.md` markdown. */
  markdown: string
  /** Whether planning spent a provider completion (false for SIMPLE). */
  usedLlm: boolean
}

/** Options for {@link buildPlan}. */
export interface PlanOptions {
  /** Project overview handed to the planner model as grounding context. */
  overview?: string
  /** Persists the rendered plan markdown (orchestrator → `plan.md`). */
  writePlan?: (markdown: string) => void
  /** Cancels the planner completion when the run is stopped. */
  signal?: AbortSignal
  /**
   * A hard ceiling on the number of tasks, from an explicit user scope ("in at
   * most 5 steps"). Clamped into `[1, MAX_TASKS]`; absent → the default ceiling.
   */
  maxTasks?: number
  /**
   * The user's explicit scope rendered as an imperative line (see
   * `describeConstraints`), injected into the planner prompt so a numeric or
   * "keep it minimal" budget is honoured while the graph is authored. Empty
   * string / undefined → no scope stated.
   */
  constraintsNote?: string
  /**
   * Reports that planning fell back to the one-node plan, and why. The fallback
   * is a real loss of fidelity — a multi-domain request becomes a single
   * generalist node — so it must not happen invisibly.
   */
  onDegraded?: (reason: string) => void
}

/** The loose shape a planner-model task may take before validation. */
interface RawTask {
  id?: unknown
  role?: unknown
  description?: unknown
  dependsOn?: unknown
  filesHint?: unknown
}

/**
 * Builds the execution plan for a request. SIMPLE → a single node with no LLM
 * call; MEDIUM/COMPLEX → one completion parsed into a validated task graph, with
 * a single-node fallback on any malformed output. Never throws: a provider or
 * parse failure degrades to the one-node plan.
 */
export async function buildPlan(
  request: string,
  complexity: Complexity,
  settings: ProviderSettings,
  opts: PlanOptions = {}
): Promise<PlanResult> {
  if (complexity === 'simple') {
    return finish(complexity, [singleNode(request)], false, opts)
  }

  const cap = clampCap(opts.maxTasks)
  const raw = await requestPlan(
    request,
    complexity,
    settings,
    cap,
    opts.overview,
    opts.signal,
    opts.onDegraded,
    opts.constraintsNote
  )
  // A provider/parse failure yields no tasks → single-node fallback.
  const tasks = raw ? normalizeTasks(raw, cap) : []
  if (tasks.length === 0) {
    return finish(complexity, [singleNode(request)], true, opts)
  }
  return finish(complexity, tasks, true, opts)
}

/**
 * Clamps a requested task ceiling into `[1, MAX_TASKS]`. An explicit user scope
 * can only *lower* the ceiling, never raise it above the runaway-model guard; a
 * missing or non-finite value leaves the default in place.
 */
function clampCap(maxTasks?: number): number {
  if (maxTasks === undefined || !Number.isFinite(maxTasks)) return MAX_TASKS
  return Math.max(1, Math.min(MAX_TASKS, Math.floor(maxTasks)))
}

/** Renders + persists the plan and packages the result. */
function finish(
  complexity: Complexity,
  tasks: TaskNode[],
  usedLlm: boolean,
  opts: PlanOptions
): PlanResult {
  const markdown = renderPlanMarkdown(complexity, tasks)
  opts.writePlan?.(markdown)
  return { complexity, tasks, markdown, usedLlm }
}

/** The one-node plan: a generalist builder handling the whole request. */
function singleNode(request: string): TaskNode {
  return {
    id: 't1',
    role: FALLBACK_ROLE,
    description: request.trim() || 'Complete the requested work.',
    dependsOn: [],
    state: 'pending',
    attempts: 0
  }
}

/**
 * Asks the model for a plan. Returns the raw task array, or `null` on any
 * provider or parse error (→ single-node fallback). Exactly one completion.
 */
async function requestPlan(
  request: string,
  complexity: Complexity,
  settings: ProviderSettings,
  cap: number,
  overview?: string,
  signal?: AbortSignal,
  onDegraded?: (reason: string) => void,
  constraintsNote?: string
): Promise<RawTask[] | null> {
  const provider = providerFromSettings(settings)

  const system =
    "You are Sylor's PLANNER. Break the user's request into the MINIMAL set of concrete tasks " +
    'for a team of specialist agents, expressed as a dependency graph.\n' +
    'Output ONLY a fenced ```json block: {"tasks":[{"id","role","description","dependsOn","filesHint"}]}.\n' +
    '- id: a short unique string like "t1".\n' +
    `- role: one of ${roleIds().join(', ')} — pick the best-fit specialist.\n` +
    '- description: one imperative sentence naming the concrete slice of work.\n' +
    '- dependsOn: ids of tasks that MUST finish first (only real data/sequence dependencies — ' +
    'keep independent tasks parallel with an empty array).\n' +
    '- filesHint: likely file paths this task writes (best guess; used to serialize conflicting edits).\n' +
    '\nDEFAULT SHAPE — most requests are one feature, not many domains. Prefer the core loop: ' +
    'explorer (read-only — locate the exact files and lines to change) → editor (make the code ' +
    'change; it reads and writes but has no shell) → test-runner (run the project’s checks and ' +
    'report pass/fail; it runs commands but makes no edits), chained through dependsOn. Reach for ' +
    'a domain specialist (frontend, backend, database, security, devops, docs, …) ONLY when the ' +
    'work genuinely spans that domain. Do NOT add a review or verify task — a mandatory reviewer ' +
    'gate already runs automatically after the plan.\n' +
    `Prefer the fewest tasks that cover the work; at most ${cap}. Do not invent work the user did not ask for. ` +
    `This request was routed as ${complexity.toUpperCase()} complexity — size the plan accordingly ` +
    '(a medium request is the core loop, ~2–4 tasks; a complex one may fan out across several ' +
    'domain specialists before converging).'

  // An explicit user scope ("in at most 5 steps", "keep it minimal") is a hard
  // budget, not a hint — restate it after the sizing guidance so it wins, and
  // re-pin the numeric ceiling in the model's own terms.
  const scoped = constraintsNote?.trim()
    ? `${system}\n\nHARD CONSTRAINTS — the user stated explicit scope; obey it exactly and do not exceed it:\n${constraintsNote.trim()}\nProduce no more than ${cap} tasks in total.`
    : system

  const user = overview ? `${request}\n\n## Project context\n${overview}` : request
  const messages: ChatMessage[] = [
    { role: 'system', content: scoped },
    { role: 'user', content: user }
  ]

  try {
    const rawText = await provider.getCompletion(settings.modelId, messages, undefined, signal)
    const parsed = parsePlanJson(rawText)
    // Parsed-to-nothing is a real degradation too, not just a thrown error: the
    // model answered, we just couldn't use it. Say so rather than quietly
    // collapsing a multi-domain request into one generalist node.
    if (!parsed) onDegraded?.('the planner’s reply was not a usable task graph')
    return parsed
  } catch (err) {
    if (!isAbort(err)) onDegraded?.(toErrorMessage(err))
    return null
  }
}

/** Tolerantly extracts the `tasks` array from a (possibly fenced) JSON reply. */
function parsePlanJson(raw: string): RawTask[] | null {
  const json = extractJson(raw)
  if (!json) return null
  try {
    const obj = JSON.parse(json) as { tasks?: unknown }
    return Array.isArray(obj.tasks) ? (obj.tasks as RawTask[]) : null
  } catch {
    return null
  }
}

/** Pulls a JSON object out of a reply, preferring a ```json fence. */
function extractJson(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  return body.slice(start, end + 1)
}

/**
 * Validates raw planner tasks into real {@link TaskNode}s: drops entries with no
 * description, assigns stable unique ids, maps unknown roles to the generalist
 * `builder`, keeps only `dependsOn` references that resolve (and never self),
 * caps the count, serializes overlapping writers, and finally validates the
 * whole graph (cycles/dups). Returns `[]` — signalling the single-node fallback
 * — if nothing survives or the graph is invalid. `cap` is the honoured task
 * ceiling (default {@link MAX_TASKS}, lowered by an explicit user scope).
 */
function normalizeTasks(raw: RawTask[], cap: number): TaskNode[] {
  const seen = new Set<string>()
  // Build nodes first (ids finalized), remembering each one's raw deps.
  const built: { node: TaskNode; rawDeps: string[] }[] = []
  for (let i = 0; i < raw.length && built.length < cap; i++) {
    const t = raw[i]
    if (!t || typeof t.description !== 'string' || !t.description.trim()) continue

    let id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `t${i + 1}`
    if (seen.has(id)) id = `${id}-${i + 1}`
    seen.add(id)

    const role = typeof t.role === 'string' && hasRole(t.role) ? t.role : FALLBACK_ROLE
    const filesHint = Array.isArray(t.filesHint)
      ? t.filesHint.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : []
    const rawDeps = Array.isArray(t.dependsOn)
      ? t.dependsOn.filter((d): d is string => typeof d === 'string')
      : []

    const node: TaskNode = {
      id,
      role,
      description: t.description.trim(),
      dependsOn: [],
      state: 'pending',
      attempts: 0
    }
    if (filesHint.length) node.filesHint = filesHint
    built.push({ node, rawDeps })
  }

  if (built.length === 0) return []

  // Resolve deps now that every id is known: keep only real, non-self refs.
  const ids = new Set(built.map((b) => b.node.id))
  for (const b of built) {
    b.node.dependsOn = b.rawDeps.filter((d) => d !== b.node.id && ids.has(d))
  }

  const tasks = linkOverlappingWriters(built.map((b) => b.node))
  try {
    // Validate cycles/dups/unknown-deps; discard the graph, keep the nodes.
    new TaskGraph(tasks)
  } catch {
    return []
  }
  return tasks
}

/**
 * Renders the plan as `plan.md`: a one-line goal, the complexity, and a checkable
 * task list (`- [ ]`) the builder/specialists tick off — the existing plan.md
 * convention the engine already reads and nudges against.
 */
export function renderPlanMarkdown(complexity: Complexity, tasks: TaskNode[]): string {
  const lines: string[] = ['# Plan', '', `**Complexity:** ${complexity}`, '', '## Tasks', '']
  for (const t of tasks) {
    const deps = t.dependsOn.length ? ` _(depends on: ${t.dependsOn.join(', ')})_` : ''
    const files = t.filesHint?.length ? ` — files: ${t.filesHint.join(', ')}` : ''
    lines.push(`- [ ] **${t.id}** (${t.role}) ${t.description}${deps}${files}`)
  }
  return `${lines.join('\n')}\n`
}
