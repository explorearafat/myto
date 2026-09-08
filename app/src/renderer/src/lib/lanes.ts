/**
 * lanes — who is working, derived from the run's own trace.
 *
 * A "lane" is one worker in a turn: the lead, or a subagent. The run log draws the
 * lanes as a filter strip, and the command palette offers them as jump targets, so
 * the derivation lives here instead of inside either surface. Both then agree about
 * which lanes exist and what each one is called, which matters because the palette's
 * "jump to lane" writes a lane key that the log has to recognise.
 *
 * Rows are the authority for *which* lanes exist — a lane with no steps would be a
 * filter that shows nothing — and the agent cards supply the role name and the live
 * state. Neither is enough alone: a subagent's card arrives with `agent-start`, but a
 * trace restored from disk may hold rows whose cards are long gone.
 */
import type { ActivityStep, AgentCardUI } from '@renderer/store/useChatStore'
import type { AgentRole } from '@shared/types'

/** Lane key for the lead. Its steps carry no `agentId`, so it needs its own. */
export const LEAD = '__lead__'

/** One worker in the turn. */
export interface Lane {
  /** `LEAD`, or the subagent's `agentId`. */
  key: string
  label: string
  /** Live state, when this lane is a subagent that reported one. */
  state: 'running' | 'done' | 'failed' | null
  count: number
  /** The user has asked this lane to stop and the engine hasn't closed it yet. */
  cancelling: boolean
  /** The lane's most recent step, for a tooltip ("what is it doing now"). */
  current: string | null
}

/** Title-case a role for a lane chip ("test-writer" → "Test writer"). */
export function roleLabel(role: AgentRole): string {
  const words = role.replace(/[-_]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Build the lane list for a trace: the lead first, then each subagent seen. */
export function lanesOf(activity: ActivityStep[], agents: AgentCardUI[]): Lane[] {
  const counts = new Map<string, number>()
  const roles = new Map<string, AgentRole>()
  const latest = new Map<string, string>()
  for (const step of activity) {
    const key = step.agentId ?? LEAD
    counts.set(key, (counts.get(key) ?? 0) + 1)
    latest.set(key, step.message)
    if (step.agentId != null && step.agentRole != null) roles.set(step.agentId, step.agentRole)
  }
  for (const agent of agents) roles.set(agent.agentId, agent.role)

  const lanes: Lane[] = [
    {
      key: LEAD,
      label: 'Sylor',
      state: null,
      count: counts.get(LEAD) ?? 0,
      cancelling: false,
      current: latest.get(LEAD) ?? null
    }
  ]
  for (const [key, count] of counts) {
    if (key === LEAD) continue
    const card = agents.find((a) => a.agentId === key)
    const role = roles.get(key)
    lanes.push({
      key,
      label: role ? roleLabel(role) : 'Subagent',
      state:
        card == null
          ? null
          : card.status === 'running'
            ? 'running'
            : card.ok === false
              ? 'failed'
              : 'done',
      count,
      cancelling: card?.cancelling === true,
      current: latest.get(key) ?? null
    })
  }
  return lanes
}
