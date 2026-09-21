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
