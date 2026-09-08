/**
 * The gathering pass: open every file you need ONCE, whole, in one message — then
 * say what you found before you touch anything.
 *
 * The failure this exists to remove (user report, 2026-09-04): fixing a plain
 * banner/navbar collision, the agent produced *thirteen* inspection steps —
 * `PromoBanner.tsx`, `Navbar.tsx`, `Index.tsx`, a search, `HeroSection.tsx` lines
 * 1–40, `HeroSection.tsx` lines 55–94, `PromoBanner.tsx` again, `Navbar.tsx`
 * again, an eval, another search, `PromoBanner.tsx` a third time, another search,
 * `Navbar.tsx` lines 1–70 — before making a single edit. Three separate defects
 * compound into that:
 *
 *  1. **Narrow windows.** A model that asks for `lines 830–889 of 1769` sees a
 *     keyhole, and a keyhole is never enough to edit against — so it comes back
 *     for another one, and another. Every window is also a DIFFERENT read-cache
 *     key, so nothing dedupes and each keyhole costs a fresh disk hit plus its
 *     own copy in the context window.
 *  2. **Re-opening.** With windows in play the dedup cache almost never hits, so
 *     the same file legitimately reaches disk three times — and each attempt still
 *     costs a step, a card in the feed, and a round-trip to the model.
 *  3. **No hand-off.** Nothing ever told the model that gathering was DONE. There
 *     was no point at which it had to state the problem and commit to a fix, so
 *     "one more look" was always the cheapest next move.
 *
 * So this module supplies the two mechanical halves — {@link planReadWindow} makes
 * the first read of a file the WHOLE file (which in turn makes the dedup cache hit
 * every time after), and {@link findingsNudge} / {@link stopGatheringNudge} close
 * the pass by demanding the findings message. Kept pure and Electron-free so both
 * halves are unit-testable without a run.
 */

/**
 * The four blocks that only LOOK at the project. A step built entirely from these
 * is a *gathering* step — it produced no change, so it is the pass this module
 * governs. Named by tool string rather than by `ExecutableTool` so this module
 * stays independent of `engine.ts` (whose Electron import chain would follow).
 */
const GATHER_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'find_files'])

/** True when `name` is one of the read-only inspection blocks. */
export function isGatherTool(name: string): boolean {
  return GATHER_TOOLS.has(name)
}

/**
 * The line window a `read_file` should ACTUALLY use, given whether this run has
 * already read the whole file.
 *
 * First read of a path → `{}`: the whole file, whatever window the model asked
 * for. This is the load-bearing decision. A model cannot reliably pick a useful
 * window before it has seen the file (that is the point of reading it), so
 * honouring a guessed `offset`/`limit` buys a keyhole and a second read. Taking
 * the whole file costs one disk hit, gives an exact `old_string` to edit against,
 * and — because the cache key for a whole-file read is the same every time — makes
 * every later read of that path a guaranteed dedup hit.
 *
 * Once the whole file HAS been read, an `offset` is honoured: that is no longer a
 * keyhole but a continuation — the only legitimate reason to read the same path
 * twice is that it was too big to fit in one read and the model is walking through
 * the rest (see `readFileSlice`, which prints the offset to continue from).
 *
 * A model-supplied `limit` is never taken at all, which is why it is not even a
 * parameter here: how much of a file fits in one read is the reader's cap to
 * enforce (`MAX_READ_CHARS`), not the model's to guess — and a small guessed limit
 * is precisely the keyhole this function exists to refuse.
 */
export function planReadWindow(
  readWholeAlready: boolean,
  offset?: number
): { offset?: number; limit?: number } {
  if (!readWholeAlready) return {}
  return offset !== undefined && offset > 1 ? { offset } : {}
}

/** Most paths named in one gather nudge before the list is elided. */
const MAX_LISTED_PATHS = 12

/** A bounded, comma-separated path list for a nudge ('a.ts, b.ts +3 more'). */
export function listPaths(paths: string[]): string {
  const head = paths.slice(0, MAX_LISTED_PATHS).join(', ')
  const rest = paths.length - MAX_LISTED_PATHS
  return rest > 0 ? `${head} +${rest} more` : head
}

/**
 * Fed back after the FIRST gathering pass of a turn, alongside the file contents
 * themselves. This is the hand-off the loop was missing: it declares the pass
 * over, and asks for the one message the user actually wants to read — what was
 * read, what is wrong and where, and how it will be fixed — before any edit.
 *
 * It deliberately does NOT ask for a tool block in the same message. The findings
 * message stands alone (a question-intent turn ends there, correctly answered; an
 * edit-intent turn is carried into the first write by the start-build nudge), so
 * the user sees `reading… → here is the problem and the plan → the fix` instead of
 * a wall of file cards followed by a silent edit.
 */
export function findingsNudge(paths: string[]): string {
  const held = paths.length > 0 ? ` You are holding: ${listPaths(paths)}.` : ''
  return (
    'Your gathering pass is done — the full text of everything you asked for is above.' +
    held +
    '\n\nNow send ONE message, and no tool block yet:\n' +
    '- what you read, in a line;\n' +
    '- what you actually found — the real problem, and exactly where it is (file, and the ' +
    'line or the class/symbol);\n' +
    '- if there is more than one problem, each one;\n' +
    '- how you are going to fix it: the concrete steps, in order.\n\n' +
    'Then take the first of those steps. Do NOT open any of those files again — you have them ' +
    'word for word, and re-reading them tells you nothing new. If a file you have NOT read yet ' +
    'turns out to be needed, read it in the SAME message as your next action, never as a step ' +
    'of its own.'
  )
}

/**
 * Fed back on every gathering pass AFTER the first: the model looked, was asked
 * for its findings, and went looking again instead. Escalates by naming the round
 * it is on and everything it already holds, and refuses the "one more look" move
 * explicitly.
 *
 * Uncapped on purpose — it costs no extra step (it rides the feedback turn that
 * was being sent anyway) and the honest answer to a fifth gathering round is a
 * firmer version of the same instruction. `MAX_STEPS` remains the backstop.
 */
export function stopGatheringNudge(pass: number, paths: string[]): string {
  const held = paths.length > 0 ? `You already have, in full: ${listPaths(paths)}. ` : ''
  return (
    `That is looking round ${pass} of this turn, and still nothing has changed. ` +
    held +
    'Stop gathering.\n\nDo not read, re-read, list, or search any of those again — every one of ' +
    'them is above in this conversation, complete. Say in one or two lines what the problem is ' +
    'and what you are doing about it, then emit the block that actually does it (edit_file, ' +
    'write_file, or run_command). If something is genuinely still missing, name that ONE thing ' +
    'and why you need it, and read it in the same message as your fix — not as another step.'
  )
}
