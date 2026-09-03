/**
 * Task graph — the DAG the orchestrator executes.
 *
 * A {@link TaskNode} is one unit of work; edges are `dependsOn` references. The
 * graph validates itself on construction (unknown deps, duplicate ids, and
 * cycles all throw), tracks each node's {@link TaskState}, and computes the
 * **ready set** — nodes whose dependencies have all completed — so the
 * {@link runScheduler} loop can run independent work in parallel and pick up
 * newly-unblocked nodes the instant their deps finish.
 *
 * State model:
 *   pending ──recompute(deps done)──▶ ready ──dispatch──▶ running
 *      │                                                    │
 *      └──recompute(a dep failed/blocked)──▶ blocked        ├─ok──▶ completed
 *                                                           └─fail─▶ retrying ──▶ ready
 *                                                                   (or failed when out of attempts)
 *   any non-terminal ──abort──▶ cancelled
 *
 * Pure data + control logic — no engine/Electron imports — so the whole
 * scheduler is unit-testable with a fake executor.
 */
import type { TaskNode, TaskState } from '../../../shared/types'

/** Dep states that make a dependent node un-runnable (→ blocked). */
const BLOCKING_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['failed', 'cancelled', 'blocked'])

/** States from which a node can be dispatched once its deps are satisfied. */
const DISPATCHABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['ready', 'retrying'])

/** States a node never leaves once reached. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['completed', 'failed', 'cancelled'])

/** The result an executor reports for a single node. */
export interface NodeOutcome {
  ok: boolean
  /** The specialist's final report (kept on the node as `result`). */
  result?: string
  /** Failure reason (kept on the node as `error`). */
  error?: string
}

/** Runs one node's work. Supplied by the orchestrator (wraps `runAgentLoop`). */
export type NodeExecutor = (node: TaskNode) => Promise<NodeOutcome>

/** Options controlling {@link runScheduler}. */
export interface SchedulerOptions {
  /** Aborts the run; in-flight nodes are left to settle, the rest → cancelled. */
  signal?: AbortSignal
  /** Max nodes running at once (default: unbounded — the whole ready set). */
  concurrency?: number
  /** Max total attempts per node before it stays `failed` (default 1 = no retry). */
  maxAttempts?: number
  /**
   * Marks a node as needing exclusive execution: at most one exclusive node runs
   * at any moment, even when `concurrency` would allow more. Non-exclusive nodes
   * still overlap freely, and still overlap the single running exclusive node.
   * Used to serialize file-writing specialists so their edits — and their tool
   * cards — land one at a time, the way a single engineer works, while read-only
   * or research nodes keep running in parallel. Default: nothing is exclusive.
   */
  exclusive?: (node: TaskNode) => boolean
  /** Called whenever a node changes state (drives `task-update` events). */
  onStateChange?: (node: TaskNode) => void
}

/**
 * A directed acyclic graph of task nodes with lifecycle tracking. Construct once
 * per run from the planner's nodes; mutate state through the `mark*` methods and
 * {@link recompute}.
 */
export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>()
  private readonly order: string[] = []

  /**
   * Builds and validates the graph. Throws when a node id is duplicated, a
   * `dependsOn` references a missing node, or the dependencies form a cycle.
   */
  constructor(nodes: readonly TaskNode[]) {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate task id "${node.id}".`)
      // Copy so callers can't mutate our state behind our back; normalize state.
      this.nodes.set(node.id, { ...node, dependsOn: [...node.dependsOn], state: node.state ?? 'pending' })
      this.order.push(node.id)
    }
    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep)) {
          throw new Error(`Task "${node.id}" depends on unknown task "${dep}".`)
        }
      }
    }
    this.assertAcyclic()
    this.recompute()
  }

  /** Kahn's algorithm: if any node can't be topologically ordered, there's a cycle. */
  private assertAcyclic(): void {
    const indegree = new Map<string, number>()
    for (const id of this.order) indegree.set(id, 0)
    // Every dep is known to exist (validated above), so a node's indegree is just
    // how many deps it declares.
    for (const node of this.nodes.values()) indegree.set(node.id, node.dependsOn.length)
    const queue = [...this.order].filter((id) => (indegree.get(id) ?? 0) === 0)
    let visited = 0
    while (queue.length) {
      const id = queue.shift() as string
      visited++
      for (const node of this.nodes.values()) {
        if (node.dependsOn.includes(id)) {
          const d = (indegree.get(node.id) ?? 0) - 1
          indegree.set(node.id, d)
          if (d === 0) queue.push(node.id)
        }
      }
    }
    if (visited !== this.order.length) {
      throw new Error('Task graph contains a dependency cycle.')
    }
  }

  /** All nodes in insertion order (stable for the UI + tests). */
  get all(): TaskNode[] {
    return this.order.map((id) => this.nodes.get(id) as TaskNode)
  }

  /** Number of nodes. */
  get size(): number {
    return this.nodes.size
  }

  /** The node with `id`, or `undefined`. */
  get(id: string): TaskNode | undefined {
    return this.nodes.get(id)
  }

  /** Whether every node has reached a terminal state (or is unreachably blocked). */
  isSettled(): boolean {
    for (const node of this.nodes.values()) {
      if (!TERMINAL_STATES.has(node.state) && node.state !== 'blocked') return false
    }
    return true
  }

  /** Whether any node ended in `failed`. */
  hasFailure(): boolean {
    for (const node of this.nodes.values()) if (node.state === 'failed') return true
    return false
  }

  /** Whether any node is `blocked` (a dependency failed/cancelled). */
  hasBlocked(): boolean {
    for (const node of this.nodes.values()) if (node.state === 'blocked') return true
    return false
  }

  /**
   * The nodes ready to dispatch now: state `ready` or `retrying` with every
   * dependency `completed`. (`recompute` promotes `pending → ready`; the
   * scheduler sets `retrying` on a retryable failure.)
   */
  ready(): TaskNode[] {
    return this.all.filter(
      (n) => DISPATCHABLE_STATES.has(n.state) && this.depsCompleted(n)
    )
  }

  /** Whether all of `node`'s dependencies are `completed`. */
  private depsCompleted(node: TaskNode): boolean {
    return node.dependsOn.every((id) => this.nodes.get(id)?.state === 'completed')
  }

  /**
   * Recomputes derived states: a `pending`/`blocked` node becomes `ready` when
   * all deps are `completed`, `blocked` when any dep is failed/cancelled/blocked,
   * else stays/returns to `pending`. Reconsidering `blocked` lets a node recover
   * when a failed dependency is later retried to success. Returns the nodes whose
   * state changed, so the scheduler can emit updates.
   */
  recompute(): TaskNode[] {
    const changed: TaskNode[] = []
    for (const node of this.all) {
      if (node.state !== 'pending' && node.state !== 'blocked') continue
      const next = this.deriveState(node)
      if (next !== node.state) {
        node.state = next
        changed.push(node)
      }
    }
    return changed
  }

  /** The state a not-yet-started node should hold given its deps. */
  private deriveState(node: TaskNode): TaskState {
    const deps = node.dependsOn.map((id) => this.nodes.get(id) as TaskNode)
    if (deps.some((d) => BLOCKING_STATES.has(d.state))) return 'blocked'
    if (deps.every((d) => d.state === 'completed')) return 'ready'
    return 'pending'
  }

  /** Marks a node `running` and counts the attempt. */
  markRunning(id: string): TaskNode {
    const node = this.require(id)
    node.state = 'running'
    node.attempts += 1
    return node
  }

  /** Marks a node `completed` with its report. */
  markCompleted(id: string, result?: string): TaskNode {
    const node = this.require(id)
    node.state = 'completed'
    if (result !== undefined) node.result = result
    return node
  }

  /** Marks a node `failed` with a reason. */
  markFailed(id: string, error?: string): TaskNode {
    const node = this.require(id)
    node.state = 'failed'
    if (error !== undefined) node.error = error
    return node
  }

  /** Marks a node `retrying` (re-dispatchable) for another attempt. */
  markRetrying(id: string): TaskNode {
    const node = this.require(id)
    node.state = 'retrying'
    return node
  }

  /** Marks a single node `cancelled`. */
  markCancelled(id: string): TaskNode {
    const node = this.require(id)
    node.state = 'cancelled'
    return node
  }

  /** Cancels every non-terminal node (used on abort). Returns changed nodes. */
  cancelAll(): TaskNode[] {
    const changed: TaskNode[] = []
    for (const node of this.all) {
      if (!TERMINAL_STATES.has(node.state)) {
        node.state = 'cancelled'
        changed.push(node)
      }
    }
    return changed
  }

  private require(id: string): TaskNode {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`Unknown task id "${id}".`)
    return node
  }
}

/**
 * Drives a {@link TaskGraph} to completion: repeatedly dispatch the ready set
 * (up to `concurrency`), await the next node to settle, mark it
 * completed/failed/retrying, recompute, and continue until nothing is running
 * and nothing is ready. Independent nodes overlap; a node starts the instant its
 * last dependency completes (not at a wave boundary). A retryable failure
 * (`attempts < maxAttempts`) re-enters as `retrying`; otherwise it stays
 * `failed` and its dependents become `blocked`.
 *
 * When {@link SchedulerOptions.exclusive} is given, at most one exclusive node
 * runs at a time (file-writing specialists, so their edits and tool cards land
 * one at a time); non-exclusive nodes keep overlapping up to `concurrency`.
 *
 * On abort, in-flight executors are left to settle on their own (they observe
 * the same signal) and all not-yet-terminal nodes are marked `cancelled`.
 */
export async function runScheduler(
  graph: TaskGraph,
  execute: NodeExecutor,
  opts: SchedulerOptions = {}
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? Number.POSITIVE_INFINITY)
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 1)
  const { signal, onStateChange, exclusive } = opts
  const notify = (nodes: TaskNode[]): void => {
    if (onStateChange) for (const n of nodes) onStateChange(n)
  }

  const running = new Map<string, Promise<void>>()
  // How many exclusive nodes are in flight (0 or 1 by construction).
  let exclusiveInFlight = 0

  const settle = async (node: TaskNode): Promise<void> => {
    let outcome: NodeOutcome
    try {
      outcome = await execute(node)
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (signal?.aborted) return // abort path handles final state
    if (outcome.ok) {
      notify([graph.markCompleted(node.id, outcome.result)])
    } else if (node.attempts < maxAttempts) {
      notify([graph.markRetrying(node.id)])
    } else {
      notify([graph.markFailed(node.id, outcome.error)])
    }
  }

  for (;;) {
    if (signal?.aborted) {
      notify(graph.cancelAll())
      break
    }
    notify(graph.recompute())
    for (const node of graph.ready()) {
      if (running.size >= concurrency) break
      if (running.has(node.id)) continue
      const isExclusive = exclusive?.(node) ?? false
      // One exclusive node at a time. `continue`, not `break`, so a non-exclusive
      // node further down the ready set can still start while this one waits.
      if (isExclusive && exclusiveInFlight > 0) continue
      notify([graph.markRunning(node.id)])
      if (isExclusive) exclusiveInFlight++
      const p = settle(node).finally(() => {
        running.delete(node.id)
        if (isExclusive) exclusiveInFlight--
      })
      running.set(node.id, p)
    }
    if (running.size === 0) {
      // Nothing in flight. If recompute yields nothing new, the run is settled.
      if (graph.ready().length === 0) break
      continue
    }
    await Promise.race(running.values())
  }
}

/**
 * Serializes writers to the same file: when two nodes both declare a `filesHint`
 * touching the same path and neither already depends (transitively) on the
 * other, adds a dependency from the later node (by insertion order) to the
 * earlier one. This keeps concurrent edits from clobbering each other while
 * leaving genuinely independent work parallel. Always later→earlier, so it can't
 * introduce a cycle. Mutates and returns the same node array.
 */
export function linkOverlappingWriters(nodes: TaskNode[]): TaskNode[] {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const overlap = (a.filesHint ?? []).some((f) => (b.filesHint ?? []).includes(f))
      if (!overlap) continue
      // b is later in order → depend b on a (acyclic by construction). Skip if
      // a already (transitively) depends on b, which would reverse the edge.
      if (dependsOnTransitively(nodes, a.id, b.id)) continue
      if (!b.dependsOn.includes(a.id)) b.dependsOn.push(a.id)
    }
  }
  return nodes
}

/** Whether `fromId` depends on `toId` transitively (a→…→to). */
function dependsOnTransitively(nodes: TaskNode[], fromId: string, toId: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const stack = [...(byId.get(fromId)?.dependsOn ?? [])]
  while (stack.length) {
    const id = stack.pop() as string
    if (id === toId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(byId.get(id)?.dependsOn ?? []))
  }
  return false
}
