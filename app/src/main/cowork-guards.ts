/**
 * Small, dependency-free heuristics that keep the Cowork tool loop honest. Kept out
 * of {@link ./provider-ipc} (which loads Electron's `ipcMain` at eval time and so is
 * not unit-testable) so the logic that decides "did the model actually build, or just
 * talk about building?" can be exercised directly.
 */

/**
 * A fenced code block of at least this many lines, in a Cowork reply that wrote no
 * files, reads as "the model printed the deliverable in chat instead of saving it"
 * (see {@link looksLikeUnsavedCode}). Small enough to catch a real file, large enough
 * that a short illustrative snippet inside an explanation doesn't trip it.
 */
export const MIN_UNSAVED_CODE_LINES = 10

/**
 * Does this reply contain a substantial fenced code block? Used only once the loop's
 * "nothing was written this whole reply" fallback fires (buildsMade === 0), to tell a
 * genuine "here is the file's contents" prose-dump apart from a plain textual answer —
 * so the loop can nudge the model to actually call write_file exactly once.
 *
 * A fresh RegExp per call (not a shared `/…/g`) keeps `lastIndex` from leaking between
 * calls. The body is the capture between the opening fence's newline and the closing
 * fence; a block is "substantial" once it reaches {@link MIN_UNSAVED_CODE_LINES} lines.
 */
export function looksLikeUnsavedCode(text: string): boolean {
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (m[1].split('\n').length >= MIN_UNSAVED_CODE_LINES) return true
  }
  return false
}

/**
 * How many recent tool-call signatures {@link detectOscillation} inspects, and how many
 * times one signature must recur within that window to count as a stall. The loop's
 * consecutive-repeat guard already catches A,A,A (the same call back-to-back); this
 * catches the NON-consecutive ping-pong it misses — A,B,A,B,A… — where a call keeps
 * coming back and keeps returning the same result. Conservative on purpose: it keys on
 * the FULL signature (tool name + input), so distinct targets (`read_file a` vs
 * `read_file b`) never collide and only a genuinely identical, genuinely repeated call
 * trips it. Raising completion rates means stopping REAL loops, not real work.
 */
export const OSCILLATION_WINDOW = 8
export const OSCILLATION_MAX = 3

/** Soft-stop auto-continues allowed per reply before a "should I continue?" pause stands. */
export const MAX_AUTO_CONTINUE = 3

/**
 * Read-only "research / inspection" tools: looking at the project, the web, or a page,
 * as opposed to BUILDING (writing files, running commands). The classic hard stall —
 * and the exact one the ZahMon screenshot showed — is a weak model that RESEARCHES
 * forever across DISTINCT targets (google → maps → some other site → back), never
 * writing a file. Every signature-keyed guard ({@link detectOscillation}, the
 * consecutive-repeat check) misses it because no single call repeats: `browser_navigate`
 * to five different URLs is five different signatures. Counting the RUN of these with
 * nothing built in between is what catches it. Browser `click`/`type` are deliberately
 * NOT here — they act on the page and can BE the deliverable (filling a form), so they
 * count as building and reset the streak.
 */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  'list_dir',
  'read_file',
  'search_code',
  'find_files',
  'web_search',
  'web_fetch',
  'wiki_search',
  'browser_navigate',
  'browser_snapshot',
  'browser_read',
  'detect_runtimes',
  'verify_file'
])

/** After this many back-to-back research calls with nothing built, nudge once… */
export const RESEARCH_STALL_NUDGE = 8
/** …and after this many, stop the loop rather than research to the turn ceiling. */
export const RESEARCH_STALL_STOP = 12

/**
 * Classify a run of consecutive research-only tool calls (see {@link RESEARCH_TOOLS}).
 * 'nudge' fires exactly once, at {@link RESEARCH_STALL_NUDGE} — a strong "stop
 * researching, act now" directive with tools still live; 'stop' fires at
 * {@link RESEARCH_STALL_STOP} so a distinct-target research loop can't spin all the way
 * to the turn budget. Pure so the loop wiring stays testable. `streak` is the count of
 * consecutive research calls, which any building action resets to 0.
 */
export function researchStallVerdict(streak: number): 'ok' | 'nudge' | 'stop' {
  if (streak >= RESEARCH_STALL_STOP) return 'stop'
  if (streak === RESEARCH_STALL_NUDGE) return 'nudge'
  return 'ok'
}

/**
 * Find a tool-call signature that recurs too often within the recent-call window — a
 * stall the consecutive-repeat check misses because the repeats aren't back-to-back.
 * Pure: `recentSigs` is the running list of `name:JSON(input)` signatures (oldest →
 * newest). Returns the worst offender (`{ sig, count }`) once any signature reaches
 * `maxRepeatsInWindow` within the last `window` entries, else null.
 */
export function detectOscillation(
  recentSigs: readonly string[],
  opts: { window: number; maxRepeatsInWindow: number }
): { sig: string; count: number } | null {
  if (recentSigs.length < opts.maxRepeatsInWindow) return null
  const windowed = recentSigs.slice(-opts.window)
  const counts = new Map<string, number>()
  let worst: { sig: string; count: number } | null = null
  for (const sig of windowed) {
    const count = (counts.get(sig) ?? 0) + 1
    counts.set(sig, count)
    if (count >= opts.maxRepeatsInWindow && (!worst || count > worst.count)) {
      worst = { sig, count }
    }
  }
  return worst
}

/**
 * Interrogative "may I keep going?" phrasings. Matched only against a whole reply by
 * {@link looksLikeContinuationRequest}. Because a question puts the verb before the
 * subject ("should I continue"), first-person narration ("I should continue to the next
 * file", "I want to continue") never matches these — only an actual question does.
 */
const CONTINUATION_PATTERNS: readonly RegExp[] = [
  // "should / shall / can / may I … continue / proceed / go ahead / keep going / …?"
  /\b(should|shall|can|may)\s+i\b[^.?!\n]{0,50}\b(continue|proceed|go ahead|go on|keep going|carry on|move on)\b/i,
  // "do you want / would you like / want … me to … continue / proceed / build / …?"
  /\b(do you want|would you like|want)\b[^.?!\n]{0,40}\bme\s+to\b[^.?!\n]{0,50}\b(continue|proceed|go ahead|keep going|carry on|move on|build|implement|create|add|finish|do)\b/i,
  // "let me know if you'd like me to continue / proceed / …"
  /\blet me know\b[^.?!\n]{0,50}\b(continue|proceed|keep going|carry on|go ahead|move on)\b/i
]

/**
 * Does this reply READ as a soft "should I continue?" — a rhetorical ask for permission
 * to keep going, rather than a delivered answer or a genuine either/or the user must
 * decide? In autonomous Cowork building a weaker model often pauses to ASK instead of
 * finishing the job; the loop uses this to push it onward a bounded number of times
 * ({@link MAX_AUTO_CONTINUE}) so real work completes without a human babysitting it.
 *
 * Deliberately narrow (see {@link CONTINUATION_PATTERNS}): only interrogative
 * permission-asks match. A genuine choice question ("Postgres or MySQL?") does not, so
 * it falls through to a normal stop where the user can actually answer.
 */
export function looksLikeContinuationRequest(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return CONTINUATION_PATTERNS.some((re) => re.test(t))
}
