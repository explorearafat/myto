/**
 * Pure, Electron-free helpers for Build-mode (internally `cowork`) plan detection.
 *
 * The one export here, {@link looksLikeBigTask}, decides whether a user's ask looks
 * substantial enough to be worth drafting a plan for FIRST — the auto-plan path that
 * fires when the explicit Plan-mode toggle is OFF. It is deliberately conservative:
 * a false positive (planning a one-line fix) is far more annoying than a false
 * negative (building straight away on a big task the user can always re-run under
 * the Plan toggle), so it only fires when a build-intent verb or a scale word sits
 * next to a project noun — and it stays quiet on questions and tweaks.
 *
 * Kept pure (no Node/Electron imports) so it unit-tests in isolation and can run in
 * the main-process reply loop without pulling anything heavy in.
 */

/**
 * Build-intent verbs — English plus the Banglish the user actually types
 * ("banao" = make, "toiri" = create/build, "baniye" = having made). Matched on word
 * boundaries so "app" inside "happy" or "make" inside "makeshift" can't trip it.
 */
const BUILD_INTENT =
  /\b(build|rebuild|create|develop|make|implement|design|redesign|generate|scaffold|banao|banaw|bananor|baniye|toiri)\b/

/**
 * Scale words that, next to a project noun, mark a big ask even without an explicit
 * verb ("full dashboard", "puro website"). "puro" = whole/entire in Banglish.
 */
const SCALE = /\b(full|complete|entire|whole|production|puro)\b/

/** Single-word project nouns (word-boundary matched; both singular and plural listed). */
const PROJECT_NOUN =
  /\b(website|websites|site|sites|webapp|app|apps|application|applications|dashboard|game|games|portfolio|blog|store|shop|ecommerce|platform|clone|saas|extension|backend|frontend|homepage|webpage)\b/

/** Multi-word project nouns checked as plain substrings (word-boundary regex is awkward here). */
const PROJECT_PHRASES = [
  'web app',
  'web site',
  'landing page',
  'web page',
  'e-commerce',
  'single page',
  'full stack',
  'full-stack'
]

/**
 * Leading interrogatives that mark the ask as a QUESTION ("how do I build a site",
 * "what is a good app") rather than an instruction to build. We stay quiet on these
 * — explaining is not building. Note "can"/"could"/"would" are deliberately absent:
 * "can you build me a site" is a polite imperative, and should still plan.
 */
const QUESTION_START = /^(how|what|why|kivabe|kemne|keno|ki)\b/

/**
 * True when a prompt reads like a substantial build task worth a plan-first pass.
 *
 * Fires when the text contains a PROJECT NOUN and (a build-intent verb OR a scale
 * word), and does NOT open with an explanation-seeking interrogative. Everything
 * else — questions, typo fixes, one-line edits, a bare verb with no object — stays
 * quiet. Empty / whitespace input is never a big task.
 */
export function looksLikeBigTask(prompt: string): boolean {
  if (typeof prompt !== 'string') return false
  const text = prompt.trim().toLowerCase()
  if (!text) return false

  // A question asking how/what/why is a request to explain, not to build.
  if (QUESTION_START.test(text)) return false

  const hasNoun = PROJECT_NOUN.test(text) || PROJECT_PHRASES.some((p) => text.includes(p))
  if (!hasNoun) return false

  return BUILD_INTENT.test(text) || SCALE.test(text)
}
