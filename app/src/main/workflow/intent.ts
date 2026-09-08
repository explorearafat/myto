import type { ChatMessage, IntentAnalysis, ProviderSettings } from '../../shared/types'
import { createProvider } from '../providers'
import { leadsWith, matchesAnyWord } from './markers'

/** Keywords suggesting an edit/change request vs. a question. */
const EDIT_MARKERS = [
  'fix',
  'build',
  'write',
  'create',
  'add',
  'update',
  'edit',
  'refactor',
  'implement',
  'change',
  'install',
  'rename',
  'delete',
  'remove',
  'convert',
  'migrate',
  'test',
  'debug',
  'configure',
  'optimize'
]

/** English phrases that ask for an explanation rather than a change. */
const EXPLAIN_MARKERS = [
  'explain',
  'what is',
  'what are',
  'what does',
  'why',
  'how does',
  'how do',
  'difference',
  'meaning',
  'describe',
  'summarize',
  'tell me about',
  'walk me through'
]

/**
 * Interrogative openers that lead a genuine question. Deliberately excludes
 * "can/could/would you", which in practice lead a polite imperative ("can you
 * add a logout button?") — a request, not a question.
 */
const QUESTION_LEADS = ['what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose']

/**
 * Banglish (romanised Bengali) question markers, matched anywhere in the prompt.
 * The router is English-first, so a Banglish question looked like an edit request
 * the moment it mentioned "build" — which is exactly how "hii tomake kono boro
 * project build korte dile tumi ki korbe?" ("if you were given a big project to
 * build, what would you do?") was answered with a nine-phase production build
 * instead of a sentence.
 *
 * Omits "tumi ki" / "apni ki" for the same reason English omits "can you": in
 * practice they lead a polite request ("tumi ki ei file ta fix korte parbe?").
 */
const BANGLISH_QUESTION_MARKERS = [
  'ki korbe',
  'ki korba',
  'ki korbo',
  'ki kore',
  'ki hobe',
  'ki hoy',
  'kivabe',
  'kibhabe',
  'ki vabe',
  'ki bhabe',
  'kemon',
  'keno',
  'kano',
  'kothay',
  'kokhon',
  'ki mane',
  'mane ki',
  'bujhao',
  'bujhiye'
]

/**
 * Greetings / social pleasantries that should get a plain conversational reply —
 * no project scan, no code. Matched against the whole prompt with a word
 * boundary (exact or leading-token) so short words like "hi" don't match inside
 * "hidden". An edit keyword anywhere in the prompt overrides this.
 */
const CHAT_MARKERS = [
  'hi',
  'hello',
  'hey',
  'yo',
  'sup',
  'hiya',
  'howdy',
  'good morning',
  'good afternoon',
  'good evening',
  'good night',
  'how are you',
  "how's it going",
  'how do you do',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'cheers',
  'who are you',
  'what are you',
  'what can you do',
  'what do you do',
  'help',
  'ok',
  'okay',
  'cool',
  'nice',
  'great',
  'bye',
  'goodbye'
]

/**
 * True when the prompt is a greeting / social message: it leads with a chat
 * marker (as a whole word, stretched letters allowed, optionally followed by
 * punctuation or more words) and carries no edit keyword. Kept deliberately
 * conservative — anything that smells like real work falls through to
 * question/edit.
 */
function isChitChat(lower: string): boolean {
  if (!lower) return false
  if (matchesAnyWord(lower, EDIT_MARKERS)) return false
  return CHAT_MARKERS.some((m) => leadsWith(lower, m))
}

/**
 * True when the prompt is shaped like a question: an explain phrase, an
 * interrogative opener, or a Banglish question marker. A trailing `?` alone does
 * NOT count — "can you add a logout button?" is a request, not a question.
 */
function looksInterrogative(lower: string): boolean {
  if (matchesAnyWord(lower, EXPLAIN_MARKERS)) return true
  if (matchesAnyWord(lower, BANGLISH_QUESTION_MARKERS)) return true
  return QUESTION_LEADS.some((lead) => leadsWith(lower, lead))
}

/**
 * Heuristic intent classification used when the LLM is unavailable or the
 * prompt is too short to justify a round trip. Cheap and deterministic.
 */
export function classifyIntentHeuristic(prompt: string): IntentAnalysis {
  const lower = prompt.toLowerCase().trim()

  // Greetings / small talk get a conversational reply — never a scan or an edit.
  if (isChitChat(lower)) {
    return { kind: 'chat', summary: 'You want to chat with Sylor.', needsContext: false }
  }

  // A question shape beats an edit keyword: someone asking *about* building is
  // not asking us to build. (This is the tie-break the LLM path also makes.)
  const isEdit = matchesAnyWord(lower, EDIT_MARKERS) && !looksInterrogative(lower)

  const needsContext = isEdit

  return {
    kind: isEdit ? 'edit' : 'question',
    summary: isEdit
      ? `You want to make a change to the project (${lower.slice(0, 60)}…).`
      : `You want to know something about ${lower.slice(0, 60) || 'the project'}.`,
    needsContext
  }
}

/**
 * Whether the cheap heuristic is confident enough to skip the LLM round-trip: a
 * clear greeting, or a prompt carrying exactly one of the two signals — an edit
 * marker XOR a question shape. A prompt with neither, or with both (an edit verb
 * inside a question — "kono project build korte dile ki korbe?"), is genuinely
 * ambiguous and still earns the smarter LLM classification. This keeps the common
 * case ("build/add/fix X", "explain/why X", "hi") instant instead of blocking
 * generation on a separate classification call.
 */
function heuristicIsConfident(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim()
  if (isChitChat(lower)) return true
  return matchesAnyWord(lower, EDIT_MARKERS) !== looksInterrogative(lower)
}

/**
 * Classifies intent, preferring the cheap deterministic heuristic and only
 * spending a provider round-trip when the prompt is genuinely ambiguous. Falls
 * back to the heuristic on any failure so the chat never blocks on this.
 */
export async function classifyIntent(
  prompt: string,
  settings: ProviderSettings,
  signal?: AbortSignal
): Promise<IntentAnalysis> {
  // Fast path: a very short prompt, or one the heuristic already reads
  // confidently, is classified inline — no LLM latency before the model starts
  // responding. Only a genuinely ambiguous prompt pays for the completion below.
  if (prompt.trim().length < 12 || heuristicIsConfident(prompt)) {
    return classifyIntentHeuristic(prompt)
  }

  const provider = createProvider(
    settings.activeProvider,
    settings.activeProvider === 'ollama' ? settings.ollama : settings.gateway
  )

  const system =
    "You are Sylor's intent analyzer. Classify the user's latest message into exactly one kind: " +
    '"chat" (a greeting, small talk, or social message needing no project work), ' +
    '"question" (they want an explanation or answer about the code/project), or ' +
    '"edit" (they want you to change, build, run, or fix something). ' +
    'The message may be in any language, or in a romanised mix (e.g. Banglish) — ' +
    'judge the intent, not the vocabulary. A hypothetical about work ' +
    '("if you were given a big project to build, what would you do?") is a QUESTION: ' +
    'it asks how you would work, and answering it means writing a sentence, not code. ' +
    'Only choose "edit" when the user is asking for the change itself, now. ' +
    'Respond with ONLY valid JSON: ' +
    '{"kind":"chat"|"question"|"edit","summary":"<short one-sentence restatement of what the user wants>","needsContext":true|false}. ' +
    'Set needsContext true only when answering requires reading the project files.'
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ]

  try {
    const raw = await provider.getCompletion(settings.modelId, messages, undefined, signal)
    const parsed = parseIntentJson(raw)
    if (parsed) return parsed
  } catch {
    // Fall through to the heuristic on any provider error.
  }
  return classifyIntentHeuristic(prompt)
}

/** Tolerantly parses the model's JSON, stripping any markdown fence noise. */
function parseIntentJson(raw: string): IntentAnalysis | null {
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    const obj = JSON.parse(raw.slice(start, end + 1)) as Partial<IntentAnalysis>
    if (obj.kind !== 'chat' && obj.kind !== 'question' && obj.kind !== 'edit') return null
    return {
      kind: obj.kind,
      summary:
        typeof obj.summary === 'string' && obj.summary.trim()
          ? obj.summary.trim()
          : classifyIntentHeuristic('').summary,
      needsContext: typeof obj.needsContext === 'boolean' ? obj.needsContext : obj.kind === 'edit'
    }
  } catch {
    return null
  }
}
