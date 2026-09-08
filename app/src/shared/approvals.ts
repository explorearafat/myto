import type { ToolProposal } from './types'

/**
 * Run-scoped standing approvals — Sylor's answer to "I already told you yes, stop
 * asking". A long build in `ask` mode proposes dozens of writes and re-runs the
 * same check command a dozen times; answering each one individually is the
 * difference between a build that finishes while the user is away and one that
 * stalls on its fourth file. The user grants a standing approval once from the
 * permission bar and the rest of the run stops asking for THAT class of op.
 *
 * A standing approval is deliberately narrow:
 *
 *  - `write_file` → every write for the rest of this run. Writes are already
 *    confined to the project sandbox and each one is still shown as a card with
 *    its diff, so the risk this waives is "a file I did not individually okay",
 *    not "anything at all".
 *  - `run_command` / `diagnostics` → the EXACT command only. A build re-runs
 *    `npm test` and `tsc --noEmit` over and over, and saying yes to those is not
 *    saying yes to `rm -rf`. Keying on the command string is what makes the grant
 *    safe to give.
 *
 * Everything else returns `null` — no standing approval is possible:
 *
 *  - `browse` has its own risk-class policy the user configured in Settings
 *    (payment refused outright, send/delete always asked). A per-run shortcut
 *    would quietly outrank that policy.
 *  - `install_plugin` installs executable code; `mcp_call`, `web_fetch` and
 *    `web_search` leave the machine. Those stay one decision per op, which is the
 *    offline-first posture the permission matrix exists to keep honest.
 *  - `read` and `preview_inspect` are already auto in every mode, so there is
 *    nothing to escalate.
 *
 * The engine is the authority: it re-derives this key itself and ignores a
 * standing grant for anything that maps to `null`, so a renderer bug (or a
 * tampered-with renderer) cannot widen the set.
 */
export function standingApprovalKey(proposal: ToolProposal): string | null {
  switch (proposal.kind) {
    case 'write_file':
      return 'write_file'
    case 'run_command':
      return `run_command:${proposal.command.trim()}`
    case 'diagnostics':
      return `diagnostics:${proposal.scope}`
    default:
      return null
  }
}

/**
 * The one-line note recorded in the conversation when a standing approval is
 * granted. A grant silently changes how the rest of the run behaves — writes stop
 * being asked about — and a change the user cannot see afterwards is the kind of
 * thing they should not have to remember granting. Past tense, because unlike
 * {@link standingApprovalLabel} this is written after the fact.
 */
export function standingApprovalNote(proposal: ToolProposal): string | null {
  switch (proposal.kind) {
    case 'write_file':
      return "Standing approval — I won't ask again about file edits for the rest of this run."
    case 'run_command':
      return `Standing approval — I won't ask again about \`${proposal.command.trim()}\` for the rest of this run.`
    case 'diagnostics':
      return "Standing approval — I won't ask again about this check for the rest of this run."
    default:
      return null
  }
}

/**
 * What the standing-approval button promises, in the user's words. Shown as the
 * button's tooltip so the scope of the grant is never a surprise — "all file
 * edits" vs "this one command" is exactly the distinction that makes it safe.
 */
export function standingApprovalLabel(proposal: ToolProposal): string | null {
  switch (proposal.kind) {
    case 'write_file':
      return 'Approve this and stop asking about file edits for the rest of this run'
    case 'run_command':
      return `Approve this and stop asking about \`${proposal.command.trim()}\` for the rest of this run`
    case 'diagnostics':
      return 'Approve this and stop asking about the same check for the rest of this run'
    default:
      return null
  }
}

/**
 * Name a grant from its KEY alone, for the chips that sit above the composer while
 * it is in force. The chips are the visible half of the bargain: a grant that
 * stops the bar from appearing has to leave something on screen the user can read
 * and withdraw, or "it stopped asking" becomes indistinguishable from "it stopped
 * telling me". Key-shaped rather than proposal-shaped because by then the op that
 * earned the grant is long finished — the run only remembers the key.
 */
export function describeStandingKey(key: string): string {
  if (key === 'write_file') return 'File edits'
  const cmd = key.startsWith('run_command:') ? key.slice('run_command:'.length) : null
  if (cmd) return cmd
  const scope = key.startsWith('diagnostics:') ? key.slice('diagnostics:'.length) : null
  if (scope) return `Checks · ${scope}`
  // An unknown shape means the engine grew a key the UI has not learned yet: show
  // it verbatim rather than inventing a friendly name for something unrecognised.
  return key
}
