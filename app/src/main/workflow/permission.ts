import { DEFAULT_BROWSER_PERMISSIONS } from '../../shared/defaults'
import type {
  BrowserAction,
  BrowserPermissions,
  PermissionMode,
  ToolKind
} from '../../shared/types'

/** Whether a proposal is auto-approved by the mode or must be asked. */
export type PermissionOutcome = 'auto' | 'ask'

/**
 * The permission matrix. Governs whether a given tool op runs without asking:
 *
 * | mode         | read | write_file | run_command | mcp_call | web_fetch/search |
 * |--------------|------|------------|-------------|----------|------------------|
 * | `ask`        | auto | ask        | ask         | ask      | ask              |
 * | `auto-edit`  | auto | auto       | ask         | ask      | ask              |
 * | `autonomous` | auto | auto       | auto        | auto     | auto             |
 *
 * `read` is auto in every mode — it changes nothing, and gating it would make the
 * agent unusable: understanding a single change can take a dozen file reads, and a
 * dozen approval prompts for looking at the user's own project is not a safety
 * feature. Every read is still sandbox-confined and still shown as a tool card, so
 * the user can see exactly what Sylor consulted.
 *
 * `web_fetch` and `web_search` reach the network, so they are gated exactly like
 * write_file's command siblings: asked in `ask`/`auto-edit`, auto only in
 * hands-free `autonomous`. This is what keeps the offline-first posture honest —
 * nothing leaves the machine without an explicit decision unless the user opted
 * into hands-free. (No kind-specific branch is needed below: anything that isn't
 * `read` or `write_file` follows the same network-egress path.)
 *
 * `autonomous` is an explicit, opt-in, hands-free posture (requirement D): it
 * auto-approves everything so a build runs without prompts. Even an `auto`
 * outcome still surfaces a (flagged) tool-request + tool-result to the UI, and
 * every write/command stays sandbox-scoped — silent or unsandboxed side effects
 * are never allowed. `ask` and `auto-edit` still never auto-run commands.
 *
 * `diagnostics` is gated as a command, not as a read, and that is deliberate: it
 * writes nothing, but it spawns a process from the project's own `node_modules`
 * and an ESLint config/plugin is executable JavaScript. Auto-approving it would
 * mean opening an unfamiliar repo could run that repo's code without a decision.
 * It therefore takes the same default path as `run_command` (no branch needed).
 */
export function decideAuto(
  mode: PermissionMode,
  kind: ToolKind,
  fullAccess = false
): PermissionOutcome {
  // Looking is never a side effect — no mode asks about it. `preview_inspect`
  // rides here too: it only observes/drives the user's OWN local preview (no
  // filesystem write, no outbound network), so like a read it is a look-like
  // affordance that would be maddening to gate behind a prompt each time. The one
  // real risk — typing into a credential field — is refused in the executor, not
  // by asking. Every action is still shown as a tool card.
  if (kind === 'read' || kind === 'preview_inspect') return 'auto'
  // Full-PC access (opt-in): every side effect on the user's own machine —
  // write, command, mcp, web — is auto-approved regardless of mode. It is still
  // surfaced as a (flagged) tool card, exactly like `autonomous`; the only thing
  // waived is the prompt. Browse keeps its own gate (see `decideBrowse`), so this
  // never touches payment/send/delete.
  if (fullAccess) return 'auto'
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

/**
 * Whether a browse action runs silently, needs approval, or is refused outright.
 * Unlike {@link PermissionOutcome} this has a `block`: a browse can touch the real
 * world (someone's money, someone else's inbox), so refusal has to be expressible.
 */
export type BrowseOutcome = 'auto' | 'ask' | 'block'

/**
 * Gate for one `browse` step, keyed on the RISK CLASS the engine classified it as
 * (see `classifyBrowse`) rather than on the raw action — a `click` is a `click`, a
 * `send`, a `delete` or a `payment` depending on what the element says it does.
 *
 * The user's own {@link BrowserPermissions} policy is the authority here, not the
 * run's {@link PermissionMode}: browsing risk is about the outside world, and the
 * user configured it deliberately in Settings. Three rules override the policy and
 * cannot be configured away:
 *
 *  - `payment` is ALWAYS blocked. Sylor never spends the user's money, in any mode.
 *  - `delete` ALWAYS asks, even if the policy says `allow` — destroying the user's
 *    data is not something to discover after the fact.
 *  - `send` ALWAYS asks too (posting/mailing as the user), UNLESS the user opted
 *    into hands-free sending via `autoSend` — the one narrow, explicit waiver.
 *  - `read` and `navigate` are auto unless the user explicitly blocked them, the
 *    same reasoning that makes file reads auto: gating "look at the page" makes the
 *    agent unusable, and it changes nothing.
 *
 * `autonomous` is honoured only where it is safe to: it upgrades a policy `ask` on
 * `click`/`fill` to auto, so a hands-free run can work through a site — never for
 * `send`/`delete`/`payment`.
 *
 * `autoSend` is the deliberate exception to the `send` rule (see `autoSendEnabled`
 * — it is a sub-permission of full-PC access). When it is on, a `send` goes auto
 * instead of asking, so Sylor can post/message/mail on its own. It is narrow on
 * purpose: it does NOT touch `delete` (still asks) or `payment` (still blocked),
 * and it does nothing on its own — the caller only passes it true when full access
 * is also on.
 */
export function decideBrowse(
  risk: BrowserAction,
  policy?: BrowserPermissions,
  mode: PermissionMode = 'ask',
  fullAccess = false,
  autoSend = false
): BrowseOutcome {
  if (risk === 'payment') return 'block'

  const setting = (policy ?? DEFAULT_BROWSER_PERMISSIONS)[risk] ?? DEFAULT_BROWSER_PERMISSIONS[risk]
  if (setting === 'block') return 'block'

  // Sending AS the user (post / message / mail) normally always surfaces, whatever
  // the policy or mode says — but this is the one gate the user can deliberately
  // waive with the opt-in `autoSend` sub-permission, so a "read my mail tonight and
  // reply" request can actually send. Even then `payment` (above) and `delete`
  // (below) stay gated: auto-send never spends money or destroys data.
  if (risk === 'send') return autoSend ? 'auto' : 'ask'

  // Deleting the user's data always surfaces — it reaches outside the machine, is
  // irreversible, and unlike `send` there is no waiver for it. This is exactly the
  // gate that survives full-PC access AND auto-send.
  if (risk === 'delete') return 'ask'

  if (setting === 'allow') return 'auto'
  // setting === 'ask': a hands-free run (autonomous) or full-PC access may skip
  // the prompt for a low-risk click/fill/navigate; nothing else reaches here.
  return mode === 'autonomous' || fullAccess ? 'auto' : 'ask'
}
