/**
 * Sylorium's AI reasoning helpers — the bridge between what Sylor *sees* on a page
 * (a {@link PerceptionSnapshot}) and what it may *do* (a single, permission-gated
 * {@link ParsedAction}). These are pure functions with no React/DOM dependency so
 * both the browser area and the chat area can share them, and so they can be unit
 * tested in isolation.
 *
 * Security posture (unchanged from the original inline implementation): the model
 * is never shown cookies, passwords, or field values, and is explicitly told never
 * to type into credential fields. Sensitive actions still pass through the
 * controller's permission gate regardless of what the model proposes.
 */
import type { PerceptionSnapshot } from '@renderer/lib/sylorium/perception'

/** What the model may emit as a single next step (or nothing → it just answers). */
export interface ParsedAction {
  action: 'navigate' | 'click' | 'type' | 'fill' | 'scroll'
  url?: string
  idx?: number
  value?: string
  label?: string
  direction?: string
}

/** System brief: Sylor drives a REAL browser over MULTIPLE gated steps. */
export const SYSTEM_PROMPT = `You are Sylor, operating a REAL web browser called Sylorium on the user's behalf.
Each step you are shown the current PAGE (title, url, visible text, and an indexed list of interactive
elements). You complete a task over MULTIPLE steps: take ONE action, see the updated page, then take the
next — until the task is done.

Reply in one of exactly two ways:

1. ACT — to take the next step, reply with a SINGLE fenced json block and NOTHING else:
   \`\`\`json
   { "action": "navigate", "url": "https://example.com" }
   \`\`\`
   Supported actions (one per step):
   - { "action": "navigate", "url": "..." }                                  → load a page
   - { "action": "click", "idx": <n>, "label": "<visible text>" }
   - { "action": "type", "idx": <n>, "value": "<text>", "label": "<field label>" }
   - { "action": "scroll", "direction": "down" | "up" }
   After you act you'll be shown the RESULT and the updated PAGE, then you take the next step.

2. FINISH — when the task is complete, or the user only asked a question, reply in plain prose
   (a short answer or summary) with NO json block. That ends the task.

Rules:
- Use only element idx values that appear in the CURRENT PAGE listing. After the page changes the
  indexes change, so always read the new listing before you click or type.
- To search a site, type the query into its search box, then click its search/submit control (some
  boxes submit on their own — check the next PAGE before repeating).
- NEVER type into password, card, or other credential fields — the user enters those themselves.
- Sensitive actions (send, delete, payment) may ask the user for approval automatically; just propose
  the step. If a step is denied or blocked, FINISH and explain briefly.
- Don't repeat a step that already succeeded — take the next real step toward the goal, or FINISH.`

/** Compact the perception snapshot into a small, model-friendly PAGE brief. */
export function summarizeSnapshot(snap: PerceptionSnapshot): string {
  const head = `mode=${snap.mode} title=${snap.title || '(untitled)'} url=${snap.url}`
  if (snap.mode === 'vision') return `${head}\n(only a screenshot is available for this page)`
  const text = snap.text ? snap.text.slice(0, 1500) : ''
  const els = snap.elements
    .slice(0, 60)
    .map((e) => {
      const kind = e.editable ? `input:${e.type || 'text'}` : e.role
      const flags = e.disabled ? ' (disabled)' : ''
      return `[${e.idx}] ${kind} "${e.name}"${flags}`
    })
    .join('\n')
  return `${head}\n\nVISIBLE TEXT:\n${text}\n\nINTERACTIVE ELEMENTS:\n${els}`
}

/** Pull the first JSON action out of a model reply, or null if it's just prose. */
export function extractAction(reply: string): ParsedAction | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : reply.match(/\{[\s\S]*\}/)?.[0]
  if (!candidate) return null
  try {
    const obj = JSON.parse(candidate.trim()) as ParsedAction
    const verbs = ['navigate', 'click', 'type', 'fill', 'scroll']
    if (obj && typeof obj.action === 'string' && verbs.includes(obj.action)) return obj
    return null
  } catch {
    return null
  }
}

/**
 * A stable key identifying "the same step", so the loop can detect a model that
 * repeats an identical action with no progress and stop instead of spinning.
 */
export function actionKey(act: ParsedAction): string {
  return JSON.stringify([
    act.action,
    act.url ?? '',
    act.idx ?? -1,
    act.value ?? '',
    act.direction ?? ''
  ])
}

/** A short human phrase for an action (drives the live status line). */
export function describeAction(act: ParsedAction): string {
  switch (act.action) {
    case 'navigate':
      return `go to ${act.url ?? '(url)'}`
    case 'click':
      return `click ${act.label || `#${act.idx}`}`
    case 'type':
    case 'fill':
      return `type into ${act.label || `#${act.idx}`}`
    case 'scroll':
      return `scroll ${act.direction === 'up' ? 'up' : 'down'}`
    default:
      return String(act.action)
  }
}

/** The plain-prose part of a FINISH reply — any stray json block removed. */
export function proseOf(reply: string): string {
  return reply.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim()
}
