/**
 * Keyword matching for the two heuristic routers ({@link import('./intent')} and
 * {@link import('./orchestrator/complexity')}).
 *
 * Both used to test their keyword lists with a bare `lower.includes(marker)`,
 * which matches a marker anywhere — *inside* an unrelated word. That is not a
 * theoretical worry: `'make'` fires on the Banglish "to**make**", `'ui'` fires on
 * "b**ui**ld", `'api'` on "r**api**d", `'test'` on "la**test**", `'add'` on
 * "**add**ress". Each false hit pushes the request one notch toward "big
 * production build", and stacked together they routed a chatty question into a
 * nine-phase build of a project the user never asked for.
 *
 * So matching is word-anchored here — but *loosely*, because these lists are
 * verb stems and real prompts inflect them: "adding", "creating", "renamed",
 * "builds" must all still count. {@link matchesWord} accepts the stem plus the
 * regular English tails, including the dropped-`e` gerund ("creat**e**" →
 * "creating") that a naive suffix list misses, and nothing else.
 */

/** Escapes a literal so it can be embedded in a `RegExp` source. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The regex source matching `marker` as a whole word with regular inflections.
 * The boundaries are `[a-z0-9]` classes rather than `\b`, so a separator inside
 * a compound still separates: "smoke-test" and "run_test" both mention "test",
 * while "latest" does not.
 */
function wordSource(marker: string): string {
  const stem = marker.endsWith('e')
    ? `${escapeRe(marker.slice(0, -1))}(?:e|es|ed|ing)?`
    : `${escapeRe(marker)}(?:s|es|d|ed|ing)?`
  return `(?<![a-z0-9])${stem}(?![a-z0-9])`
}

const wordCache = new Map<string, RegExp>()

/**
 * True when `text` contains `marker` as a whole word (or a regularly inflected
 * form of it). `text` and `marker` are both expected lower-cased.
 */
export function matchesWord(text: string, marker: string): boolean {
  let re = wordCache.get(marker)
  if (!re) {
    re = new RegExp(wordSource(marker))
    wordCache.set(marker, re)
  }
  return re.test(text)
}

/** True when any of `markers` matches as a whole word. */
export function matchesAnyWord(text: string, markers: readonly string[]): boolean {
  return markers.some((m) => matchesWord(text, m))
}

/** The markers from `markers` that match as whole words. */
export function wordMatches(text: string, markers: readonly string[]): string[] {
  return markers.filter((m) => matchesWord(text, m))
}

const leadCache = new Map<string, RegExp>()

/**
 * True when `text` *opens* with `marker`, tolerating a stretched letter: "hii",
 * "heyyy" and "helloo" are the same greeting as "hi", "hey" and "hello", and a
 * router that misses them starts scanning a project over a wave. The marker must
 * be followed by the end of the prompt or punctuation/whitespace, so "hidden"
 * is not a greeting.
 */
export function leadsWith(text: string, marker: string): boolean {
  let re = leadCache.get(marker)
  if (!re) {
    // Every letter may repeat, so `hi` also covers `hii`/`hhi`.
    const body = escapeRe(marker).replace(/[a-z]/g, '$&+')
    re = new RegExp(`^${body}(?=$|[\\s,.!?…:;-])`)
    leadCache.set(marker, re)
  }
  return re.test(text)
}
