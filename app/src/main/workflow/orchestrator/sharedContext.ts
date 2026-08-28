/**
 * Shared context — the orchestration "blackboard".
 *
 * A single instance per run holds the task, the plan, and the running record of
 * everything specialists discover: {@link Finding}s, decisions, and artifacts.
 * Its point is to stop agents rediscovering the same facts and to stop the
 * orchestrator re-deriving state from prose. The key method,
 * {@link SharedContext.summarizeForAgent}, returns a **scoped** digest sized to
 * the node's role:
 *  - `full`    → the whole picture (plan + every finding/decision/artifact).
 *  - `scoped`  → the plan + only the findings of this node's upstream
 *    dependencies (what it actually needs to build on).
 *  - `minimal` → the plan + a compact per-task execution summary (what the
 *    reviewer verifies against), without the full finding firehose.
 *
 * Pure in-memory state; the only import with behavior is the role registry (to
 * read a role's context scope). Unit-testable in isolation.
 */
import type { AgentRole, Finding, TaskState } from '../../../shared/types'
import type { TaskGraph } from './taskGraph'
import { resolveRole } from './roles'

/** A decision recorded during the run (e.g. "use SQLite, not Postgres"). */
export interface Decision {
  /** The agent/role that made it. */
  by: string
  detail: string
}

/** An artifact produced during the run (a file, a generated asset, an id). */
export interface Artifact {
  by: string
  /** A path or opaque reference. */
  ref: string
  note?: string
}

/**
 * Default per-finding detail cap so one verbose agent can't flood a downstream
 * prompt. A role may raise its own cap via `detailChars` (the explorer does, to
 * fit code snippets); everything else uses this.
 */
const MAX_DETAIL = 600
/** Overall digest cap (chars) fed into any single agent prompt. */
const MAX_DIGEST = 6_000

/** Truncates `text` to `max` chars with an ellipsis marker. */
function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The run-wide blackboard. */
export class SharedContext {
  /** The user's request (the top-level task). */
  readonly task: string
  /** The current plan text (plan.md contents / planner summary). */
  plan: string

  private readonly findings: Finding[] = []
  private readonly decisions: Decision[] = []
  private readonly artifacts: Artifact[] = []
  /** The task graph, when available — used to resolve upstream dependencies. */
  private graph: TaskGraph | null

  constructor(task: string, opts: { plan?: string; graph?: TaskGraph | null } = {}) {
    this.task = task
    this.plan = opts.plan ?? ''
    this.graph = opts.graph ?? null
  }

  /** Attaches (or replaces) the task graph used for dependency scoping. */
  setGraph(graph: TaskGraph | null): void {
    this.graph = graph
  }

  /** Records a finding on the blackboard. */
  addFinding(finding: Finding): void {
    const cap = resolveRole(finding.role).detailChars ?? MAX_DETAIL
    this.findings.push({ ...finding, detail: clamp(finding.detail, cap) })
  }

  /** Records a decision. */
  addDecision(decision: Decision): void {
    this.decisions.push(decision)
  }

  /** Records an artifact. */
  addArtifact(artifact: Artifact): void {
    this.artifacts.push(artifact)
  }

  /** All findings recorded so far (read-only copy). */
  allFindings(): Finding[] {
    return [...this.findings]
  }

  /**
   * The scoped context digest injected into a node's prompt, sized by the role's
   * `contextScope`. Returns '' when there's nothing useful to add (e.g. a scoped
   * node with no completed upstream dependencies), so the caller can skip an
   * empty section.
   */
  summarizeForAgent(node: { id: string; role: AgentRole; dependsOn: string[] }): string {
    const scope = resolveRole(node.role).contextScope
    if (scope === 'full') return this.render(this.findings, { plan: true, execution: true })
    if (scope === 'minimal') return this.render([], { plan: true, execution: true })
    // scoped: only the findings of this node's (transitive) upstream deps.
    const upstream = this.upstreamTaskIds(node)
    const relevant = this.findings.filter((f) => upstream.has(f.taskId))
    return this.render(relevant, { plan: true, execution: false })
  }

  /** The transitive set of task ids `node` depends on. */
  private upstreamTaskIds(node: { id: string; dependsOn: string[] }): Set<string> {
    const out = new Set<string>()
    const stack = [...node.dependsOn]
    while (stack.length) {
      const id = stack.pop() as string
      if (out.has(id)) continue
      out.add(id)
      const dep = this.graph?.get(id)
      if (dep) stack.push(...dep.dependsOn)
    }
    return out
  }

  /** Renders a bounded markdown digest from the given findings + options. */
  private render(findings: Finding[], opts: { plan: boolean; execution: boolean }): string {
    const parts: string[] = []
    if (opts.plan && this.plan.trim()) {
      parts.push(`### Plan\n${this.plan.trim()}`)
    }
    if (findings.length) {
      const lines = findings.map((f) => `- (${f.role}) ${f.detail}${f.files?.length ? ` [${f.files.join(', ')}]` : ''}`)
      parts.push(`### Findings so far\n${lines.join('\n')}`)
    }
    if (this.decisions.length && (opts.execution || findings.length)) {
      parts.push(`### Decisions\n${this.decisions.map((d) => `- (${d.by}) ${d.detail}`).join('\n')}`)
    }
    if (opts.execution) {
      const exec = this.executionSummary()
      if (exec) parts.push(`### Work completed\n${exec}`)
      if (this.artifacts.length) {
        parts.push(`### Artifacts\n${this.artifacts.map((a) => `- ${a.ref}${a.note ? ` — ${a.note}` : ''}`).join('\n')}`)
      }
    }
    return clamp(parts.join('\n\n'), MAX_DIGEST)
  }

  /** A compact per-task state line (from the graph), for full/minimal scopes. */
  private executionSummary(): string {
    if (!this.graph) return ''
    const label = (state: TaskState): string => state
    return this.graph.all
      .map((n) => `- ${n.id} (${n.role}) — ${label(n.state)}${n.result ? `: ${clamp(n.result, 160)}` : ''}`)
      .join('\n')
  }
}
