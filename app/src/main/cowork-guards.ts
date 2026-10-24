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
 * Does this reply contain a substantial fenced code block? Fires whenever the model
 * ends a turn with no tool call but its reply carries a real file's worth of code, to
 * tell a genuine "here is the file's contents" prose-dump apart from a plain textual
 * answer — so the loop can nudge the model to actually call write_file.
 *
 * NOTE: this is deliberately NOT gated on buildsMade === 0. The commonest mid-build
 * stall is the model writing file 1 with a tool call and then NARRATING files 2 and 3
 * as prose; gating on "wrote nothing yet" let that slip through (the earlier fix only
 * caught a reply that saved nothing at all). The loop now consults this on every silent
 * turn, bounded by {@link MAX_CODE_PROSE_NUDGES} and reset on each real tool call.
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
 * How many times a run may nudge the model to save code it printed in chat instead of
 * writing it (the {@link looksLikeUnsavedCode} guard). Bounds a genuinely stuck model
 * that keeps narrating, but the loop resets the counter on every real tool call — so a
 * legitimate multi-file build (write file 1, narrate file 2, get nudged, write file 2,
 * narrate file 3, …) is never starved: only a CONSECUTIVE run of prose-dumps with no
 * write between them can exhaust the cap.
 */
export const MAX_CODE_PROSE_NUDGES = 4

/**
 * A file the model printed in chat (a named, substantial fenced block) that was never
 * saved. {@link extractNarratedFiles} pulls these out so the loop can write them to disk
 * itself — the guaranteed cure for a model that keeps narrating file contents instead of
 * calling write_file, which no amount of nudging reliably fixes on a weaker model.
 */
export interface NarratedFile {
  path: string
  content: string
}

/**
 * File extensions we are willing to auto-persist from a narrated code block. Kept to
 * source/asset text files a coding agent actually produces — never an executable or a
 * dotfile-only name — so a stray fence can't cause us to write something surprising.
 */
const NARRATED_FILE_EXT =
  'html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|markdown|txt|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|yml|yaml|toml|ini|env|xml|svg|vue|svelte|sql|graphql|gql|astro|prisma|dockerfile'

/**
 * Matches a filename token ending in one of {@link NARRATED_FILE_EXT}, INCLUDING any
 * leading `./`, `../`, or `/` path prefix so a traversal or absolute path is captured
 * whole (and then rejected by {@link isSafeRelPath}) rather than silently trimmed to a
 * safe-looking basename.
 */
const filenameMatcher = (): RegExp =>
  new RegExp(`((?:\\.{0,2}/)*[A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${NARRATED_FILE_EXT}))\\b`, 'gi')

/**
 * Is `p` a relative, traversal-free path we're willing to write? Mirrors, at the string
 * level, what {@link ../tools/fs.resolveInWorkspace} enforces at the filesystem level —
 * no absolute path, no drive letter, no `..` segment, no backslash — plus a length cap
 * and a required extension, so auto-persist can only ever create a plain file inside the
 * working folder. The fs sandbox is still the real chokepoint; this just filters early.
 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string') return false
  const t = p.trim()
  if (!t || t.length > 200) return false
  if (t.includes('\\') || t.includes('\0')) return false
  if (t.startsWith('/') || /^[A-Za-z]:/.test(t)) return false
  if (t.split('/').some((seg) => seg === '..' || seg === '.')) return false
  if (!/\.[A-Za-z0-9]+$/.test(t)) return false
  return true
}

/** First / last filename token in a string, or null. Fresh matcher each call (no leak). */
const firstFilename = (s: string): string | null => {
  const m = filenameMatcher().exec(s)
  return m ? m[1] : null
}
const lastFilename = (s: string): string | null => {
  let out: string | null = null
  for (const m of s.matchAll(filenameMatcher())) out = m[1]
  return out
}

/**
 * Pull every clearly-named, substantial code block out of a Cowork reply so the loop can
 * write it to disk when the model narrated it instead of calling write_file. For each
 * fenced block of at least {@link MIN_UNSAVED_CODE_LINES} lines we look for the intended
 * filename in three places, most reliable first: (1) the fence info string (a language
 * tag followed by the name, e.g. "ts app.js"), (2) a leading comment on the block's first
 * line — a line-comment, an HTML comment, or a hash comment naming the file — and (3) the
 * last filename mentioned in the ~200 chars of prose right before the fence ("Here's
 * styles.css:"). Only relative, traversal-free paths ({@link isSafeRelPath}) are kept.
 * When the same path is narrated twice the later (more complete) copy wins. A block with
 * no confidently-named target is skipped — the loop falls back to nudging for those.
 */
export function extractNarratedFiles(text: string): NarratedFile[] {
  if (!text) return []
  const byPath = new Map<string, string>()
  const fence = /```([^\n]*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) {
    const info = m[1].trim()
    const body = m[2]
    if (body.split('\n').length < MIN_UNSAVED_CODE_LINES) continue
    const firstBodyLine = body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n'))
    const before = text.slice(Math.max(0, m.index - 200), m.index)
    const path =
      firstFilename(info) ?? firstFilename(firstBodyLine) ?? lastFilename(before)
    if (path && isSafeRelPath(path)) byPath.set(path, body)
  }
  return [...byPath].map(([path, content]) => ({ path, content }))
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

/** After this many back-to-back research calls with nothing built, nudge once…
 *  (raised from 8/12: a legitimate investigation of a real codebase or a research
 *  task routinely needs a dozen-plus distinct lookups, and the old caps interrupted
 *  productive research — each nudge also cost a full extra generation.) */
export const RESEARCH_STALL_NUDGE = 16
/** …and after this many, stop the loop rather than research to the turn ceiling. */
export const RESEARCH_STALL_STOP = 24

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

/** Announced-but-unexecuted action nudges allowed per reply before the reply stands. */
export const MAX_ANNOUNCED_ACTION = 2

/**
 * Declarative "I'm about to DO it" phrasings pointing at a concrete next action the
 * model then failed to take. Two families:
 *
 *  • BUILD — writing a file, creating the page, running a command. Present-progressive
 *    ("Now I'm building…", "I'm creating…") and immediate-future ("I'll write…", "Let me
 *    create…", "Next, I'll add…"). This is the Cowork half-finished-run stall.
 *  • RESEARCH / BROWSER — the Research-mode twin: "Let me grab a fresh snapshot", "I'll
 *    check your messages", "Now I'm reading the page", "Let me pull up your inbox". A
 *    research agent narrates the next inspection/browse step and then stops, emitting no
 *    browser/web/read tool call — so the loop reads the no-call turn as finished and ends
 *    a browser task half-done (the observed Instagram/Research stop).
 *
 * All four are deliberately first-person + action-verb: a past-tense wrap-up ("I've
 * built…", "Created the file.", "I checked your messages.") never matches, so a
 * genuinely finished reply isn't mistaken for an abandoned step. They are matched only
 * against the reply's LAST sentence (see {@link lastSentence}), which keeps a finished
 * answer that merely mentions an earlier step from tripping the guard.
 */
const ANNOUNCED_ACTION_PATTERNS: readonly RegExp[] = [
  // BUILD — present progressive: "Now I'm building…", "I am creating…", "I'm setting up…".
  /\bi(?:'m| am)\s+(?:now\s+)?(building|creating|writing|adding|implementing|generating|making|coding|scaffolding|drafting|assembling|putting together|setting up|starting)\b/i,
  // BUILD — immediate future / self-directive: base verb after "I'll / I will / I'm going
  // to / I'm about to / let me / next, I'll / then I'll". "I will now implement…" etc.
  /\b(?:i(?:'ll| will)|i(?:'m| am)\s+(?:going to|about to)|let me|next[,]?\s+i(?:'ll| will)?|then\s+i(?:'ll| will))\s+(?:now\s+)?(build|create|write|add|implement|generate|make|code|scaffold|draft|assemble|put together|set up|start)\b/i,
  // RESEARCH/BROWSER — present progressive: "Now I'm reading the page", "I'm checking your
  // DMs", "I am pulling up your inbox". The -ing form follows "I'm/I am" (optionally now/
  // going to/about to). "looking" excludes the "looking forward" sign-off (not an action).
  /\bi(?:'m| am)\s+(?:now\s+|going to\s+|about to\s+)?(checking|looking(?!\s+forward)|reading|opening|navigating|browsing|searching|scrolling|grabbing|fetching|gathering|loading|refreshing|reloading|pulling up|bringing up|logging in|signing in|taking a look|taking a snapshot|grabbing a snapshot)\b/i,
  // RESEARCH/BROWSER — immediate future / self-directive: inspection verb after the same
  // lead-ins. "Let me grab a fresh snapshot", "I'll check the page", "Let me pull up …".
  // "look" excludes "look forward" for the same reason.
  /\b(?:i(?:'ll| will)|i(?:'m| am)\s+(?:going to|about to)|let me|next[,]?\s+i(?:'ll| will)?|then\s+i(?:'ll| will))\s+(?:now\s+)?(check|look at|look up|look(?!\s+forward)|read|open|navigate|browse|search|find|examine|inspect|review|grab|fetch|gather|scroll|load|refresh|reload|pull up|bring up|go to|log in|sign in|take a look|take a snapshot|grab a snapshot|get a snapshot)\b/i
]

/**
 * Extract the LAST sentence of a reply — the announcement that matters is the final
 * thing the model says before it stops. Keying on the last sentence (not the whole
 * reply) is what tells the observed stall ("…and then Now I'm building index.html.")
 * apart from a finished reply that merely mentions a step earlier and then concludes
 * ("First I'll create the files. All three are written and the build passes."), where
 * the last sentence is a completion statement and no nudge should fire.
 */
function lastSentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const parts = t.split(/(?<=[.!?…])\s+/)
  return parts[parts.length - 1] ?? t
}

/**
 * Does this reply END by announcing a build action it never carried out? The exact
 * hard stall a weaker model falls into mid-run: it writes one file, narrates the next
 * step ("Now I'm building index.html…"), and stops — emitting no tool call — so the
 * loop reads the turn as a finished answer and ends the run with the work half-built.
 *
 * The signature-keyed and progress guards all miss it: nothing repeats, and a file WAS
 * written this run (buildsMade > 0), so it is neither an oscillation nor an
 * explore-only spin. This catches it directly off the reply's last sentence (see
 * {@link lastSentence} + {@link ANNOUNCED_ACTION_PATTERNS}) so the loop can nudge the
 * model to actually emit the tool call, bounded by {@link MAX_ANNOUNCED_ACTION}.
 */
export function looksLikeAnnouncedAction(text: string): boolean {
  const tail = lastSentence(text)
  if (!tail) return false
  return ANNOUNCED_ACTION_PATTERNS.some((re) => re.test(tail))
}

/** False-limit / deferral give-up nudges allowed per reply before the reply stands. */
export const MAX_FALSE_LIMIT_DEFERRAL = 2

/**
 * "I can't keep going / I'll do it later" excuses a weak model invents to abandon a run
 * with nothing built. Two shapes, either of which trips the guard:
 *
 *  1. DEFERRAL — postponing the actual work to a later turn/reply/session ("the
 *     implementation remains pending for the next available tool-enabled turn", "I'll
 *     finish this in the next turn"). A genuinely-finished reply never defers its own
 *     core task; a genuinely-blocked one asks a real question. Anchored on next/later +
 *     turn/reply/session (not "time"/"iteration", which show up in benign wrap-ups).
 *  2. FALSE LIMIT CLAIM — asserting a tool/usage/token/turn limit or quota was reached as
 *     the reason it stopped ("the tool-use limit was reached", "I've run out of tool
 *     calls"). Mid-loop this is never a real stop condition the model should honor: the
 *     turn ceiling is effectively unbounded, and if a real cap were ever hit the loop's
 *     own closing turn tells the model to answer with what it has — it does NOT ask the
 *     model to defer to a "next turn". So a reply that says so has invented the limit.
 *
 * The leading group must be immediately followed (≤1 separator) by a limit/quota/cap
 * word, so a bare "tool"/"turn"/"call" in ordinary prose can't trip it — only phrases
 * like "token limit", "tool-use limit", "rate quota", "turn budget".
 */
const FALSE_LIMIT_DEFERRAL_PATTERNS: readonly RegExp[] = [
  // Deferral to a later turn/reply/session.
  /\b(?:pending|deferred|postponed|resume[d]?|continue[d]?|finish(?:ed|ing)?|complete[d]?|do (?:this|it|so))\b[^.?!\n]{0,70}\b(?:next|later|following|subsequent|future|another|upcoming)\b[^.?!\n]{0,25}\b(?:turn|reply|response|session|message|round|prompt)\b/i,
  // Limit/quota "was reached" (limit-word first, then the verb).
  /\b(?:tool[- ]?use|tool|usage|token|api|rate|step|turn|call|message|request|quota|budget|compute)[- ]?(?:limit|quota|budget|cap|ceiling|allowance|restriction|allotment)\b[^.?!\n]{0,60}\b(?:reached|hit|exceeded|met|ran out|used up|exhausted|maxed(?:\s+out)?)\b/i,
  // "reached the limit/quota" (verb first, then the limit-word).
  /\b(?:reached|hit|exceeded|ran out of|used up|exhausted|out of|no more|maxed out)\b[^.?!\n]{0,40}\b(?:tool[- ]?use|tool|usage|token|api|rate|step|turn|call|message|request|quota|budget|compute)[- ]?(?:limit|quota|budget|cap|ceiling|allowance|restriction|allotment|calls?)\b/i
]

/**
 * Does this reply abandon the run by inventing a limit or deferring the work to a later
 * turn, rather than either finishing or taking the next action? The exact stall behind
 * "project complete na korei theme gelo" round two: a weak model, after only a plan,
 * writes "I couldn't build the app because the tool-use limit was reached … the
 * implementation remains pending for the next available tool-enabled turn" and stops —
 * no tool call, zero files. No other guard catches it (nothing was built so it is no
 * announced-action; nothing repeats; it prints no code; it is not a question), so the
 * loop reads the no-call turn as a finished answer and ends the run empty. Matched on the
 * whole reply — the phrases (see {@link FALSE_LIMIT_DEFERRAL_PATTERNS}) are distinctive
 * enough not to need tail-anchoring — so the loop can push the model to act now, bounded
 * by {@link MAX_FALSE_LIMIT_DEFERRAL}.
 */
export function looksLikeFalseLimitDeferral(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return FALSE_LIMIT_DEFERRAL_PATTERNS.some((re) => re.test(t))
}

/** Empty / content-free "you haven't started" nudges allowed per reply before it stands. */
export const MAX_EMPTY_START = 3

/**
 * Is this reply content-free — carrying no substance a user could read or run? True for
 * the empty string, whitespace only, and a reply made up solely of punctuation or stray
 * marks ("…", "—", a lone emoji) — anything with no letter or digit anywhere.
 *
 * This is the LAST stall shape a run can end on, and the subtlest: a weak model narrates
 * its intent ("I'll start by drafting a plan, then build every file out") and/or records a
 * few `think` thoughts, then closes its turn with a
 * blank reply — no tool call, no words. Every other {@link looksLikeUnsavedCode},
 * {@link looksLikeAnnouncedAction}, {@link looksLikeFalseLimitDeferral} guard keys on
 * SOMETHING in the text and so is silent on emptiness, and the announcement itself never
 * reached a no-call turn (it rode along with a `think` call), so the loop reads the blank
 * turn as a finished answer and ends the run with zero files. An empty reply is never a
 * real completion — nothing was built and nothing was said — so the loop, gated on
 * "nothing built this run", turns it back into "take your first concrete action now",
 * bounded by {@link MAX_EMPTY_START}. Keyed on the ABSENCE of any word character, so a
 * genuine one-line answer (which has letters) never trips it.
 */
export function looksLikeContentFreeReply(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/** Plan-incomplete "you still have open items" nudges allowed per run before the finish stands. */
export const MAX_PLAN_INCOMPLETE = 3

/**
 * The shape the plan gate needs from a todo item — just a title and a status string. Kept
 * structural (not the full {@link ../shared/types}.TodoItem) so this module stays
 * dependency-free and the helpers can be unit-tested with plain literals.
 */
export interface PlanItemLike {
  title?: string
  status?: string
}

/**
 * Does the plan still have work the model said it would do but hasn't finished? True once
 * ANY item's status is not exactly `'done'` — pending, in_progress, cancelled, missing, or
 * any unknown string all count as "not finished." This is the gate the loop was missing:
 * a no-tool-call turn with the plan at e.g. 0/4 was read as a finished run (RC-1). An EMPTY
 * plan returns false — the model never committed to a checklist, so there is nothing to
 * hold the finish against (the other stall guards own that case). Pure so the loop wiring
 * stays testable.
 */
export function planHasPending(plan: readonly PlanItemLike[]): boolean {
  return plan.length > 0 && plan.some((t) => t.status !== 'done')
}

/**
 * The titles of the not-done plan items, for the nudge message that lists what remains.
 * Same "not exactly done" rule as {@link planHasPending}. An item with no usable title
 * falls back to a positional `Step N` label (1-based over the FULL plan) so the model can
 * still tell which entry is meant. Returns [] for an empty or fully-done plan.
 */
export function pendingPlanTitles(plan: readonly PlanItemLike[]): string[] {
  const out: string[] = []
  plan.forEach((t, i) => {
    if (t.status !== 'done') out.push(t.title?.trim() || `Step ${i + 1}`)
  })
  return out
}

/**
 * The relative file path a plan item is *about*, or null. A plan like "Create app.js with
 * the chart logic" names its deliverable; RC-8 reconciliation uses that name to decide,
 * from real disk state, whether the step is actually done — independent of whether the
 * model remembered to call update_plan. Returns the first filename token (same matcher and
 * safety filter as {@link extractNarratedFiles}) so only a relative, traversal-free path is
 * ever returned; a title mentioning no file (e.g. "Verify in the preview pane") yields null.
 */
export function planFileTarget(title?: string): string | null {
  if (!title) return null
  const path = firstFilename(title)
  return path && isSafeRelPath(path) ? path : null
}

/** Verbs that mark a plan step as a check-the-result action rather than a build action. */
const VERIFY_VERB = /\b(verif|preview|test|check|confirm|review|open|validate|ensure|inspect|browse)/i

/**
 * Is this plan item a "verify the result" step with no file to produce — "Verify in the
 * preview pane", "Test the theme toggle", "Open the app and confirm the chart renders"?
 * RC-8 can only honestly auto-complete such a step once every file-producing step is done
 * and its file exists on disk; a step that names a file ({@link planFileTarget}) is a build
 * step no matter what verb it uses ("Create and test app.js") and is excluded here.
 */
export function isVerifyStep(title?: string): boolean {
  if (!title) return false
  if (planFileTarget(title)) return false
  return VERIFY_VERB.test(title)
}
