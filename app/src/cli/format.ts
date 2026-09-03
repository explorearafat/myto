import type { PermissionMode, ToolDecision, ToolProposal, WorkflowEvent } from '../shared/types'

/**
 * Pure helpers that turn the engine's {@link WorkflowEvent} stream into headless
 * output and approval decisions. No I/O and no engine imports, so the whole file
 * is unit-testable and stays free of the Electron-coupled main modules.
 */

/**
 * The text destined for stdout: the LEAD's streamed answer (deltas with no
 * `agentId`). Subagent deltas carry an `agentId` and are treated as progress, not
 * the final answer, so they never pollute a piped stdout. Returns null for every
 * other event.
 */
export function deltaForStdout(event: WorkflowEvent): string | null {
  if (event.type === 'delta' && event.agentId === undefined) return event.text
  return null
}

/** A short, human-readable target suffix for a proposal (path, command, url…). */
function describeProposalTarget(p: ToolProposal): string {
  switch (p.kind) {
    case 'write_file':
    case 'read':
      return ` ${p.path}`
    case 'run_command':
      return ` ${p.command}`
    case 'web_fetch':
      return ` ${p.url}`
    case 'web_search':
      return ` "${p.query}"`
    case 'mcp_call':
      return ` ${p.server}/${p.name}`
    case 'install_plugin':
      return ` ${p.source}`
    case 'diagnostics':
      return ` ${p.scope}`
    default:
      return ''
  }
}

/**
 * A one-line progress note for stderr, or null for events that carry no useful
 * headless signal (lead deltas — those are the stdout answer; `done`; the purely
 * structural orchestration updates). Kept terse: stderr is progress, stdout is
 * the answer.
 */
export function formatEventForStderr(event: WorkflowEvent): string | null {
  switch (event.type) {
    case 'status':
      return event.retrying ? `… ${event.message} (retrying)` : `… ${event.message}`
    case 'tool-request': {
      const who = event.agentId ? `${event.agentId} ` : ''
      return `${event.auto ? '⚙' : '⏳'} ${who}${event.proposal.kind}${describeProposalTarget(event.proposal)}`
    }
    case 'tool-result': {
      const r = event.result
      let ok = true
      if (r.kind === 'run_command') ok = r.exitCode === 0
      else if ('ok' in r) ok = r.ok
      return `${ok ? '✓' : '✗'} ${r.kind}`
    }
    case 'agent-start':
      return `▶ ${event.role}: ${event.task}`
    case 'agent-end':
      return `${event.ok ? '✓' : '✗'} ${event.role} finished`
    case 'plan':
      return `plan: ${event.tasks.length} task(s) [${event.complexity}]`
    case 'error':
      return `error: ${event.message}`
    default:
      // intent, delta, task-update, agent-message, done — no stderr line.
      return null
  }
}

/**
 * The verdict a headless run gives a proposal the engine did NOT pre-approve
 * (`auto === false`). With no human at the keyboard, the safe default is to
 * REJECT — the model is told and adapts — unless the operator explicitly opted
 * into hands-free `autonomous`, which approves (the same posture the GUI's
 * autonomous mode takes). Returns null when no decision is needed: the event is
 * not a `tool-request`, or the engine already auto-approved it (`auto === true`).
 */
export function headlessDecision(
  event: WorkflowEvent,
  permissionMode: PermissionMode
): { toolId: string; decision: ToolDecision } | null {
  if (event.type !== 'tool-request' || event.auto) return null
  const decision: ToolDecision = permissionMode === 'autonomous' ? 'approve' : 'reject'
  return { toolId: event.proposal.id, decision }
}
