import type { ToolDef, ToolGate } from './registry'

/**
 * `spawn_agent` — delegate a focused, read-only sub-task to a nested agent and get
 * back a compact digest. This is how Cowork scales to bigger jobs: instead of the
 * main agent reading twenty files itself (and filling its context with all of them),
 * it hands "investigate X and report what matters" to a sub-agent that does the
 * reading/searching in its OWN context and returns just the findings. The main
 * agent's context stays lean, so it can keep planning and building.
 *
 * The sub-agent is read-only — it can list, read, search, find, and browse the web,
 * but it cannot write, delete, or run code. All the writing stays with the main
 * agent, which keeps side effects in one place and makes delegation safe to use
 * freely. The actual nested loop lives in provider-ipc.ts (it needs the provider and
 * model), reached here through {@link ToolContext.delegate}.
 */

/** Available in Cowork (delegation is a folder-work capability). */
function agentAvailable(gate: ToolGate): boolean {
  return gate.mode === 'cowork'
}

export const spawnAgentTool: ToolDef = {
  name: 'spawn_agent',
  description:
    'Delegate a focused research/exploration sub-task to a read-only sub-agent and get back a short summary of its findings. Use this to investigate part of a large task (e.g. "find how auth is wired across the app and summarize it") without filling your own context with everything it reads. The sub-agent can read/search/find files and browse the web, but cannot write or run code — do the actual changes yourself with its findings.',
  usage: '{"task": "Find every file that imports the old useAuth hook and summarize how each uses it."}',
  available: agentAvailable,
  async run(input, ctx) {
    if (!ctx.delegate) {
      return 'Sub-agents are not available in this context.'
    }
    const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).task : undefined
    const task = typeof raw === 'string' ? raw.trim() : ''
    if (!task) {
      return 'spawn_agent needs a "task" string describing what the sub-agent should investigate.'
    }
    try {
      const report = await ctx.delegate(task)
      return report.trim() || 'The sub-agent returned no findings.'
    } catch (err) {
      return `The sub-agent failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Upper bound on fan-out so one call can't spawn an unbounded swarm of nested loops. */
const MAX_PARALLEL_TASKS = 5

/** Read a `tasks` string[] out of a tool input, trimming blanks; empty when absent/invalid. */
function readTasks(input: unknown): string[] {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).tasks : undefined
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
}

/** A one-line label for a sub-task's digest heading (first non-empty line, capped). */
function taskLabel(task: string): string {
  const firstLine = task.split('\n').find((l) => l.trim()) ?? task
  const t = firstLine.trim()
  return t.length > 80 ? `${t.slice(0, 79)}…` : t
}

export const spawnAgentsTool: ToolDef = {
  name: 'spawn_agents',
  description:
    'Delegate SEVERAL independent read-only research sub-tasks at once and get back all their findings together. Same read-only sub-agent as spawn_agent, but the tasks run IN PARALLEL — use it when a job splits into independent investigations (e.g. ["map the auth flow", "list every API route", "summarize the DB schema"]) so you get every digest in one round-trip instead of one at a time. Each sub-agent works in its own context; you do the actual writing/running yourself with the combined findings.',
  usage: '{"tasks": ["Summarize how routing works.", "List all React contexts and what each provides."]}',
  available: agentAvailable,
  async run(input, ctx) {
    if (!ctx.delegate) {
      return 'Sub-agents are not available in this context.'
    }
    const tasks = readTasks(input)
    if (tasks.length === 0) {
      return 'spawn_agents needs a non-empty "tasks" array of strings, e.g. {"tasks": ["investigate X", "investigate Y"]}.'
    }
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return `spawn_agents accepts at most ${MAX_PARALLEL_TASKS} tasks at once (got ${tasks.length}). Split the work into fewer, broader sub-tasks.`
    }
    const delegate = ctx.delegate
    // One failing sub-agent must not sink the batch: each result is captured
    // independently and labelled, success or failure, so the model still gets
    // whatever findings did come back.
    const digests = await Promise.all(
      tasks.map(async (task, i) => {
        const heading = `### Sub-agent ${i + 1}: ${taskLabel(task)}`
        try {
          const report = await delegate(task)
          return `${heading}\n${report.trim() || '(no findings)'}`
        } catch (err) {
          return `${heading}\n(failed: ${err instanceof Error ? err.message : String(err)})`
        }
      })
    )
    return digests.join('\n\n')
  }
}
