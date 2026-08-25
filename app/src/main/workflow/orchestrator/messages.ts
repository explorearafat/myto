/**
 * Typed agent messages — factory helpers over the {@link AgentMessage} shape
 * defined in the shared contract.
 *
 * Messages are the orchestrator's structured control-flow currency: instead of
 * handing back prose the lead must re-parse, an agent emits a machine-readable
 * message (findings, filesChanged, status, nextAction). The orchestrator both
 * *acts* on these (scheduling, review routing) and forwards them to the renderer
 * as `agent-message` events for the activity view.
 *
 * These helpers just remove boilerplate + supply sensible defaults; they hold no
 * state and import nothing from the engine, so they're trivially testable.
 */
import type { AgentMessage, AgentMessageType, AgentRole, Finding, TaskState } from '../../../shared/types'

/** The sender id used for messages the orchestrator itself emits. */
export const ORCHESTRATOR = 'orchestrator'

/** Fields every factory shares. */
interface Base {
  taskId: string
  agentId: string
  role: AgentRole
  summary: string
}

/** Builds a message of `type` from the common fields plus any extras. */
export function message(
  type: AgentMessageType,
  base: Base,
  extra: Partial<AgentMessage> = {}
): AgentMessage {
  return { type, ...base, ...extra }
}

/** The orchestrator assigns a task to a specialist (with its dependencies). */
export function taskAssigned(
  base: Base,
  opts: { recipient?: string; dependencies?: string[] } = {}
): AgentMessage {
  return message('TASK_ASSIGNED', base, {
    recipient: opts.recipient,
    dependencies: opts.dependencies,
    status: 'ready'
  })
}

/** A specialist has begun its task. */
export function started(base: Base): AgentMessage {
  return message('STARTED', base, { status: 'running' })
}

/** A specialist reports a finding (added to the shared blackboard). */
export function finding(base: Base, findings: Finding[]): AgentMessage {
  return message('FINDING', base, { findings })
}

/** A specialist completed its task, with the files it changed + its findings. */
export function taskCompleted(
  base: Base,
  opts: { filesChanged?: string[]; findings?: Finding[]; artifacts?: string[] } = {}
): AgentMessage {
  return message('TASK_COMPLETED', base, {
    status: 'completed',
    filesChanged: opts.filesChanged,
    findings: opts.findings,
    artifacts: opts.artifacts
  })
}

/** A specialist failed; `errors` explains why (drives retry/reassign). */
export function taskFailed(base: Base, errors: string[]): AgentMessage {
  return message('TASK_FAILED', base, { status: 'failed', errors })
}

/** A dependency completed, so a downstream task is now unblocked. */
export function dependencyReady(base: Base, dependencies: string[]): AgentMessage {
  return message('DEPENDENCY_READY', base, { dependencies, status: 'ready' })
}

/** The orchestrator requests a review of the integrated work. */
export function requestReview(base: Base): AgentMessage {
  return message('REQUEST_REVIEW', base, { recipient: 'reviewer' })
}

/** Review failed; route rework back to a specialist with a reason + status. */
export function retryRequired(
  base: Base,
  opts: { recipient?: string; reason: string; parentTaskId?: string } = { reason: '' }
): AgentMessage {
  return message('RETRY_REQUIRED', base, {
    recipient: opts.recipient,
    parentTaskId: opts.parentTaskId,
    nextAction: opts.reason,
    status: 'retrying'
  })
}

/** A specialist is blocked (e.g. a dependency failed). */
export function blocked(base: Base, reason: string): AgentMessage {
  return message('BLOCKED', base, { status: 'blocked', nextAction: reason })
}

/** Convenience: derive a message status from a task state for a generic update. */
export function statusFor(state: TaskState): AgentMessageType {
  switch (state) {
    case 'completed':
      return 'TASK_COMPLETED'
    case 'failed':
      return 'TASK_FAILED'
    case 'running':
      return 'STARTED'
    case 'retrying':
      return 'RETRY_REQUIRED'
    case 'blocked':
      return 'BLOCKED'
    case 'ready':
      return 'DEPENDENCY_READY'
    default:
      return 'TASK_ASSIGNED'
  }
}
