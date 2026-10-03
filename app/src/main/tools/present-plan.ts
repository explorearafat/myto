/**
 * The `present_plan` tool — the model-facing half of Build mode's plan-first gate.
 *
 * When Myto takes on a substantial build (Plan toggle on, or an auto-detected big
 * task) it researches read-only and then calls this ONCE with a complete markdown
 * plan. The tool renders that plan into the preview pane as a document and returns a
 * confirmation; the reply loop then raises an approval prompt and holds every
 * write/exec tool until the user approves (see provider-ipc.ts). This is distinct
 * from {@link updatePlanTool}: `present_plan` is the readable plan DOCUMENT shown for
 * approval, while `update_plan` is the live checklist the agent ticks off during
 * execution. Both exist and do different jobs.
 *
 * Nothing secret flows through here — the plan is model-authored prose — so the
 * returned text needs no redaction beyond the central pass every tool result gets.
 */
import type { ToolDef, ToolGate } from './registry'
import type { PreviewTarget } from '../../shared/types'

/** The call's input as a plain record (never an array/null), so field reads are safe. */
function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

/** A trimmed non-empty string, or null. */
function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Available in the agentic modes (Cowork/Build and Research), where plans are drafted. */
function planAvailable(gate: ToolGate): boolean {
  return gate.mode === 'cowork' || gate.mode === 'research'
}

export const presentPlanTool: ToolDef = {
  name: 'present_plan',
  description:
    'Present a COMPLETE plan to the user for approval BEFORE writing files or running commands. Pass the plan as markdown: what you will build, your approach, the concrete steps, and how you will verify it works. The plan is shown in the preview pane and the user is asked to approve it; nothing is written or run until they do. Call this once at the start of a substantial task, then wait. (For the live checklist you tick off while working, use update_plan instead.)',
  usage:
    '{"plan": "## Plan\\n\\n**What:** a landing page…\\n\\n**Steps:**\\n1. Scaffold\\n2. …\\n\\n**Verify:** open the dev server and check the hero renders", "title": "Landing page plan"}',
  available: planAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const plan = readStr(o.plan)
    if (!plan) {
      return 'present_plan needs a "plan" string of markdown describing what you will build, the steps, and how you will verify it.'
    }
    if (!ctx.onPreview) {
      // No preview pane here (unit tests / non-Electron). Still acknowledge so the
      // loop can proceed rather than treating the call as a failure.
      return 'Plan recorded (no preview pane in this context).'
    }
    const title = readStr(o.title) ?? 'Plan'
    const target: PreviewTarget = { kind: 'markdown', markdown: plan, title }
    ctx.onPreview(target)
    return 'Plan presented for review in the preview pane — waiting for the user to approve before writing or running anything.'
  }
}
