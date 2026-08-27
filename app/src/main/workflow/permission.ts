import type { PermissionMode, ToolKind } from '../../shared/types'

/** Whether a proposal is auto-approved by the mode or must be asked. */
export type PermissionOutcome = 'auto' | 'ask'

/**
 * The permission matrix. Governs whether a given tool op runs without asking:
 *
 * | mode         | read | write_file | run_command | mcp_call |
 * |--------------|------|------------|-------------|----------|
 * | `ask`        | auto | ask        | ask         | ask      |
 * | `auto-edit`  | auto | auto       | ask         | ask      |
 * | `autonomous` | auto | auto       | auto        | auto     |
 *
 * `read` is auto in every mode — it changes nothing, and gating it would make the
 * agent unusable: understanding a single change can take a dozen file reads, and a
 * dozen approval prompts for looking at the user's own project is not a safety
 * feature. Every read is still sandbox-confined and still shown as a tool card, so
 * the user can see exactly what Sylor consulted.
 *
 * `autonomous` is an explicit, opt-in, hands-free posture (requirement D): it
 * auto-approves everything so a build runs without prompts. Even an `auto`
 * outcome still surfaces a (flagged) tool-request + tool-result to the UI, and
 * every write/command stays sandbox-scoped — silent or unsandboxed side effects
 * are never allowed. `ask` and `auto-edit` still never auto-run commands.
 */
export function decideAuto(mode: PermissionMode, kind: ToolKind): PermissionOutcome {
  // Looking is never a side effect — no mode asks about it.
  if (kind === 'read') return 'auto'
  switch (mode) {
    case 'autonomous':
      // Hands-free: auto-approve edits, commands, AND mcp calls (still shown & sandboxed).
      return 'auto'
    case 'auto-edit':
      return kind === 'write_file' ? 'auto' : 'ask'
    case 'ask':
    default:
      return 'ask'
  }
}
