import type { ToolDef } from './registry'
import type { AskQuestion } from '../../shared/types'

/**
 * The `ask_user` tool: lets Myto ask the user its OWN clarifying questions mid-task
 * and wait for the answers before continuing — the same "check before you build" move
 * a careful collaborator makes. It can ask several at once. The model writes the
 * questions (and optional suggested options); the renderer shows a card; the answers
 * come back as this tool's result so the loop continues informed.
 *
 * Read-only (it changes nothing on disk), so it never needs a permission prompt. The
 * actual blocking/answer plumbing lives in provider-ipc.ts via {@link ToolContext.askUser}.
 */

/**
 * Read the questions out of the tool input as forgivingly as possible. The documented
 * shape is `{questions: [{question, header?, options?}]}`, but weaker models mangle it —
 * they send a bare string, a top-level `{question: "..."}`, an array of plain strings,
 * `{prompt}`/`{text}`, or a JSON string that still needs parsing. Rather than reject
 * those (which left the user staring at a card that asked nothing), we recover a real
 * question from any of them; only genuinely empty input yields `[]`.
 */
function readQuestions(input: unknown): AskQuestion[] {
  let root: unknown = input
  // A JSON string → parse it; a plain non-JSON string → treat as the question itself.
  if (typeof root === 'string') {
    const s = root.trim()
    if (!s) return []
    try {
      root = JSON.parse(s)
    } catch {
      return [{ question: s }]
    }
  }
  const obj = root && typeof root === 'object' ? (root as Record<string, unknown>) : {}
  let raw: unknown = obj.questions
  // No `questions` key, but a singular question lives on the object itself
  // (`{question|prompt|text|q: "..."}`) — reuse the object so any header/options ride along.
  if (raw === undefined) {
    const hasSingle = ['question', 'prompt', 'text', 'q'].some(
      (k) => typeof obj[k] === 'string' && (obj[k] as string).trim().length > 0
    )
    if (hasSingle) raw = [obj]
  }
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : []
  const out: AskQuestion[] = []
  for (const q of list) {
    if (typeof q === 'string') {
      const t = q.trim()
      if (t) out.push({ question: t })
      continue
    }
    if (!q || typeof q !== 'object') continue
    const o = q as Record<string, unknown>
    const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
    const question = pick('question') || pick('prompt') || pick('text') || pick('q')
    if (!question) continue
    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 6)
      : undefined
    out.push({
      question,
      header: typeof o.header === 'string' && o.header.trim() ? o.header.trim() : undefined,
      options: options && options.length ? options : undefined
    })
  }
  return out.slice(0, 6)
}

export const askUserTool: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user one or more clarifying questions and wait for their answers before continuing. Use ONLY when a choice genuinely needs the user (ambiguous requirement, a preference research cannot resolve) — otherwise decide yourself and proceed. You may ask several at once; give each a short "header" and, when helpful, a few "options".',
  usage:
    '{"questions": [{"header": "Framework", "question": "Which stack should I use?", "options": ["React + Vite", "Next.js", "Plain HTML"]}]}',
  // Read-only: asking changes nothing, so no permission gate.
  available: (gate) => gate.settings.tools.enabled,
  async run(input, ctx) {
    const questions = readQuestions(input)
    if (questions.length === 0) {
      return 'ask_user needs a non-empty "questions" array, each with a "question" string. Or, if nothing truly needs the user, do not call ask_user — decide and proceed.'
    }
    if (!ctx.askUser) {
      // No interactive channel (e.g. a sub-agent or a test): don't stall the task.
      return 'The user cannot be asked right now. Proceed with your best judgement and reasonable defaults.'
    }
    let answers: string[]
    try {
      answers = await ctx.askUser(questions)
    } catch {
      return 'Could not collect the user\'s answers. Proceed with sensible defaults.'
    }
    if (ctx.signal.aborted) return 'The user cancelled before answering.'
    const lines = questions.map((q, i) => {
      const a = (answers[i] ?? '').trim()
      return `Q: ${q.question}\nA: ${a || '(no answer — use your best judgement)'}`
    })
    return `The user answered your questions:\n\n${lines.join('\n\n')}\n\nContinue the task using these answers.`
  }
}
