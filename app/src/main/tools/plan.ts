import type { TodoItem, TodoStatus } from '../../shared/types'
import type { ToolDef, ToolGate } from './registry'

/**
 * The `update_plan` tool: the agent's working checklist, in Cowork.
 *
 * A multi-step task (build an app, refactor a module, produce a report) is far more
 * reliable when the agent decomposes it into an explicit ordered plan and keeps that
 * plan in view as it works — it stops the model from losing the thread halfway
 * through and lets the user watch progress advance. This tool lets Myto publish and
 * update that checklist: it hands the current list of steps (each `pending`,
 * `in_progress`, or `done`) to the renderer, which pins it above the reply.
 *
 * Read-only in the permission sense: it changes nothing on disk, so it never asks.
 * Like {@link previewTool} it just emits its payload through the stream loop (via
 * {@link ToolContext.onPlan}); the loop forwards it to the renderer as a `todos`
 * chunk. Available only in Cowork, where multi-step agentic work happens.
 */

/** How many steps a single plan may carry (a guardrail against runaway lists). */
const MAX_ITEMS = 40

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done']

function isStatus(v: unknown): v is TodoStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
}

/** Parse the model-supplied `todos` array into validated {@link TodoItem}s, or null. */
function parseTodos(input: unknown): TodoItem[] | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).todos : undefined
  if (!Array.isArray(raw)) return null
  const items: TodoItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const title = typeof rec.title === 'string' ? rec.title.trim() : ''
    if (!title) continue
    const status = isStatus(rec.status) ? rec.status : 'pending'
    items.push({ title, status })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/** Available in Cowork only — this is where multi-step agentic work happens. */
function planAvailable(gate: ToolGate): boolean {
  return gate.mode === 'cowork'
}

export const updatePlanTool: ToolDef = {
  name: 'update_plan',
  description:
    'Maintain your working checklist for a multi-step task. Pass the FULL ordered list of steps each time (not a diff), each with a "status" of "pending", "in_progress", or "done". Call it when you start a task to lay out the plan, and again whenever a step\'s status changes. Keep exactly one step "in_progress" while you work it.',
  usage:
    '{"todos": [{"title": "Scaffold the project", "status": "done"}, {"title": "Write SignUp.jsx", "status": "in_progress"}, {"title": "Verify the build", "status": "pending"}]}',
  available: planAvailable,
  async run(input, ctx) {
    if (!ctx.onPlan) {
      return 'The plan panel is not available in this context.'
    }
    const todos = parseTodos(input)
    if (!todos) {
      return 'update_plan needs a "todos" array, e.g. {"todos": [{"title": "…", "status": "pending"}]}.'
    }
    if (todos.length === 0) {
      return 'update_plan: the "todos" array had no usable items (each needs a non-empty "title").'
    }
    ctx.onPlan(todos)
    const done = todos.filter((t) => t.status === 'done').length
    const current = todos.find((t) => t.status === 'in_progress')
    const where = current ? ` Now working: ${current.title}.` : ''
    return `Plan updated — ${done}/${todos.length} done.${where}`
  }
}
