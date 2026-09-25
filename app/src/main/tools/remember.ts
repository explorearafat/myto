import type { ToolDef } from './registry'
import { appendUserMemory } from '../user-memory'
import { recordNote } from '../cowork-memory'

/**
 * The `remember` tool: let the agent persist a durable fact for future turns.
 *
 * Two scopes, both injected back into later runs' context so the model actually sees
 * what it saved:
 *  - `user` (default) — a CROSS-PROJECT fact written to the global `memory.md` under
 *    userData ("call me X", "we deploy with Y", "always run Z before committing").
 *    Works in plain chat and in Cowork alike, and is injected as USER MEMORY.
 *  - `project` — a fact scoped to the CURRENT Cowork working folder, appended to that
 *    folder's `.myto/journal.md` and injected as PROJECT MEMORY. Requires a working
 *    folder (Cowork); without one it falls back to user memory so a note is never lost.
 *
 * Read-only in the permission sense: it only touches Myto's OWN memory files, never the
 * user's project, so — like {@link ./plan updatePlanTool} — it never triggers an approval
 * prompt. Always available when tools are on.
 */

type Scope = 'user' | 'project'

function parse(input: unknown): { fact: string; scope: Scope } {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const fact = typeof rec.fact === 'string' ? rec.fact.trim() : ''
  const scope: Scope = rec.scope === 'project' ? 'project' : 'user'
  return { fact, scope }
}

export const rememberTool: ToolDef = {
  name: 'remember',
  description:
    'Save a durable fact so you recall it in future turns. Use scope "user" (default) for a cross-project preference or fact about the user; use scope "project" for something specific to the current Cowork working folder. Remember only stable, reusable facts — not step-by-step progress (that is journalled automatically).',
  usage: '{"fact": "The user prefers pnpm over npm", "scope": "user"}',
  available: () => true,
  async run(input, ctx) {
    const { fact, scope } = parse(input)
    if (!fact) {
      return 'remember needs a non-empty "fact" string, e.g. {"fact": "The user prefers pnpm", "scope": "user"}.'
    }
    if (scope === 'project') {
      const dir = ctx.workspaceDir?.trim()
      if (dir && recordNote(dir, fact)) {
        return `Remembered for this project (.myto/journal.md): "${fact.length > 80 ? `${fact.slice(0, 80)}…` : fact}"`
      }
      // No working folder — keep the note rather than drop it: fall through to user memory.
      if (appendUserMemory(fact)) {
        return `No Cowork working folder, so saved to your global memory instead: "${fact.length > 80 ? `${fact.slice(0, 80)}…` : fact}"`
      }
      return 'remember could not save that note (no working folder and global memory is unavailable).'
    }
    if (appendUserMemory(fact)) {
      return `Remembered globally: "${fact.length > 80 ? `${fact.slice(0, 80)}…` : fact}"`
    }
    return 'remember could not save that fact (global memory is unavailable right now).'
  }
}
