import type { Followup } from './types'

/**
 * Pure helpers for flagged follow-ups — out-of-scope work the agent noticed while
 * doing something else and deliberately left undone (the `flag_followup` tool).
 *
 * Kept dependency-free and out of the component file so both processes (and any
 * test) can build the same strings, the same way `commands.ts` and `approvals.ts`
 * hold the shared shape of their own concerns.
 */

/**
 * The prompt "Do it now" sends for a flagged follow-up. The title is written to stand
 * on its own — a cold-start task, no "this" or "that" — but the note and the files are
 * the context that stops the new turn re-deriving what was already noticed, so both are
 * folded in when present.
 */
export function buildFollowupPrompt(followup: Followup): string {
  const parts = [followup.title]
  if (followup.note) parts.push(followup.note)
  if (followup.files?.length) parts.push(`Files: ${followup.files.join(', ')}`)
  return parts.join('\n')
}
