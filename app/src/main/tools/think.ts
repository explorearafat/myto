import type { ToolDef } from './registry'

/**
 * The `think` tool: a scratchpad for the model to reason out loud MID-LOOP — to plan
 * its next step, weigh options, or record the decision it just made — without that
 * reasoning leaking into the visible answer.
 *
 * This is the well-known "think tool" pattern. Giving an agent an explicit place to
 * deliberate between tool calls measurably improves multi-step work: it stops a weaker
 * model from lurching straight into the wrong action, and it makes the chain of thought
 * inspectable. In Myto that inspection is literal — the streaming loop (provider-ipc.ts)
 * intercepts a `think` call and renders its `thought` as a live, tappable THINKING block
 * (the same out-of-band channel a reasoning model's native chain-of-thought uses) instead
 * of a tool card, then nudges the model to act on what it just reasoned. So `run` below is
 * only a fallback for contexts that don't special-case it (e.g. a nested sub-agent): it
 * simply acknowledges, since a thought changes nothing on disk or on the wire.
 *
 * Read-only: it touches nothing, so it never triggers a Cowork permission prompt, and it
 * is always available when tools are on — in plain Chat as well as Cowork.
 */
export const thinkTool: ToolDef = {
  name: 'think',
  description:
    'Think out loud before acting: use this to reason through a hard step, weigh options, or record the decision you just made and what you will do next. It performs no action and changes nothing — it is pure deliberation that is shown to the user as your thinking. Call it when a step is non-obvious or you need to plan, then act on your conclusion with another tool. Do not call it repeatedly without acting in between.',
  usage: '{"thought": "The build failed on a missing dep. Options: add it to package.json or vendor it. I\'ll add it and re-run the build."}',
  // No sideEffect: deliberation is read-only and never needs approval.
  schema: {
    type: 'object',
    properties: {
      thought: {
        type: 'string',
        description: 'Your reasoning, plan, or decision for this step — written for your own working-through, in as much detail as helps.'
      }
    },
    required: ['thought']
  },
  available: () => true,
  async run(input) {
    const thought = ((): string => {
      const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
      const raw = rec.thought ?? rec.thinking ?? rec.text
      return typeof raw === 'string' ? raw.trim() : ''
    })()
    if (!thought) {
      return 'think needs a non-empty "thought" string describing your reasoning for this step, e.g. {"thought": "…"}.'
    }
    // A thought changes nothing; acknowledge and point back at acting on it.
    return 'Noted your reasoning. Now take the next concrete action toward the goal, or give your final answer if the work is done.'
  }
}
