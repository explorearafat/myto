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

/**
 * Container keys a model uses for "the list of steps". The documented key is `todos`,
 * but weaker models reach for `steps`/`tasks`/`plan`/`items`/`checklist`/`list` just as
 * often; accepting all of them (instead of erroring) is what stops the plan tool from
 * failing on every call — the "প্ল্যান টুলে সমস্যা হচ্ছে" stall. First one that holds an
 * array wins.
 */
const TODO_KEYS = ['todos', 'steps', 'tasks', 'plan', 'items', 'checklist', 'list'] as const

/** Per-item keys a model uses for the step's text, in priority order. */
const TITLE_KEYS = ['title', 'task', 'step', 'name', 'text', 'label', 'description', 'todo', 'content', 'item']

/** Windows-reserved-name-free? Not relevant here; this only maps status synonyms. */
function coerceStatus(v: unknown): TodoStatus {
  if (typeof v !== 'string') return 'pending'
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['in_progress', 'inprogress', 'doing', 'current', 'active', 'wip', 'started', 'working'].includes(s))
    return 'in_progress'
  if (['done', 'complete', 'completed', 'finished', 'closed', 'resolved', 'x', '✓', 'check'].includes(s))
    return 'done'
  return 'pending'
}

/** Pull a step's title out of an item object under any of the keys a model might use. */
function itemTitle(rec: Record<string, unknown>): string {
  for (const k of TITLE_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Parse the model-supplied plan into validated {@link TodoItem}s, or null when no list
 * of steps is present at all. Forgiving on purpose (mirrors ask.ts's `readQuestions`):
 * the array may be `input` itself, a JSON string, or live under any {@link TODO_KEYS}
 * key; each item may be a bare string or an object keyed by any {@link TITLE_KEYS} name,
 * with loose status synonyms. Returns `[]` (not null) when a list was found but held no
 * usable item, so the caller can tell "wrong shape" from "empty list".
 */
function parseTodos(input: unknown): TodoItem[] | null {
  let root: unknown = input
  if (typeof root === 'string') {
    const s = root.trim()
    if (!s) return null
    try {
      root = JSON.parse(s)
    } catch {
      return null
    }
  }
  // The list may BE the input (a bare array), or sit under one of the container keys.
  let raw: unknown = null
  if (Array.isArray(root)) {
    raw = root
  } else if (root && typeof root === 'object') {
    const rec = root as Record<string, unknown>
    for (const k of TODO_KEYS) {
      if (Array.isArray(rec[k])) {
        raw = rec[k]
        break
      }
    }
  }
  if (!Array.isArray(raw)) return null
  const items: TodoItem[] = []
  for (const entry of raw) {
    let title = ''
    let status: TodoStatus = 'pending'
    if (typeof entry === 'string') {
      title = entry.trim()
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>
      title = itemTitle(rec)
      status = coerceStatus(rec.status ?? rec.state)
    }
    if (!title) continue
    items.push({ title, status })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/** Available in the agentic modes (Cowork and Research) — where multi-step work happens. */
function planAvailable(gate: ToolGate): boolean {
  return gate.mode === 'cowork' || gate.mode === 'research'
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
