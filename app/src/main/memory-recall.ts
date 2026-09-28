/**
 * Local, offline relevance recall for the markdown memory files
 * ({@link ./cowork-memory} project journal + {@link ./user-memory} global memory).
 *
 * The memory readers inject a RECENCY TAIL — the last N chars — which means a long
 * project silently pushes useful EARLY facts out of the window. This module surfaces
 * the most task-RELEVANT older notes alongside that tail, using a keyword/TF-IDF
 * overlap scorer over the notes already on disk.
 *
 * Hard constraints (from the brief): **fully local, offline, deterministic.** No
 * network, no embeddings service — just term-frequency maths over the existing text.
 * It is purely additive: when the whole memory fits the budget, or the caller passes
 * no task query, or nothing older is relevant, the output is exactly the previous
 * recency-tail string. It only ever REPLACES trimmed-away bytes with the relevant
 * older notes that would otherwise have been lost. Reimplemented from the described
 * behaviour — no OpenClaw code copied.
 */

/** Function words that carry no topical signal — dropped before scoring. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'with', 'as', 'at', 'by', 'be', 'are', 'was', 'were', 'from', 'into',
  'you', 'your', 'i', 'we', 'me', 'my', 'so', 'if', 'do', 'does', 'can', 'will', 'not',
  'no', 'yes', 'up', 'out', 'get', 'got', 'make', 'made', 'use', 'used', 'want', 'need'
])

/** Lowercase alphanumeric tokens of length ≥ 2, minus stopwords. Deterministic. */
export function tokenize(s: string): string[] {
  const out: string[] = []
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0]
    if (t.length >= 2 && !STOPWORDS.has(t)) out.push(t)
  }
  return out
}

/** One memory note = one non-empty line (both files are line-per-fact). */
function splitBlocks(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * Score each block against the query with a light TF-IDF: a block earns, for every
 * DISTINCT query term it contains, that term's inverse document frequency across the
 * blocks. Rare shared terms (a filename, an identifier) therefore outweigh common
 * ones. Returns scores aligned to `blocks` (0 = no overlap). Pure.
 */
export function scoreBlocks(blocks: string[], query: string): number[] {
  const queryTerms = new Set(tokenize(query))
  if (queryTerms.size === 0 || blocks.length === 0) return blocks.map(() => 0)
  const blockTerms = blocks.map((b) => new Set(tokenize(b)))
  const n = blocks.length
  // Document frequency of each query term across the blocks.
  const df = new Map<string, number>()
  for (const term of queryTerms) {
    let count = 0
    for (const bt of blockTerms) if (bt.has(term)) count++
    if (count > 0) df.set(term, count)
  }
  return blockTerms.map((bt) => {
    let score = 0
    for (const term of queryTerms) {
      const d = df.get(term)
      if (d && bt.has(term)) score += Math.log(1 + n / d)
    }
    return score
  })
}

/** Options for {@link recallMemory}; both readers pass their existing cap. */
export interface RecallOptions {
  /** Total char budget for the injected string (the reader's READ_CAP). */
  cap: number
  /** Fraction of the budget reserved for surfaced relevant notes (rest = recency tail). */
  relevantFraction?: number
  /** Hard ceiling on how many relevant notes to surface. */
  topK?: number
  /** The reader's own "trimmed" marker, so the no-query output stays byte-identical. */
  trimmedMarker?: string
}

const HEADER = '(most relevant earlier notes for this task)'
const TRIMMED_WITH_RECALL = '…(other earlier entries trimmed; most relevant kept above)'
const TRIMMED_PLAIN = '…(earlier entries trimmed)'

/**
 * Drop-in replacement for the readers' recency-tail logic. Returns:
 *  - `text` unchanged when it already fits `cap` (the common case — byte-identical);
 *  - the plain recency tail (identical to the old output) when there is no query, no
 *    query terms, or nothing older is relevant;
 *  - otherwise the top relevant OLDER notes (that the tail would have dropped),
 *    prepended above a slightly shorter recency tail.
 * Never grows beyond roughly `cap` plus the short markers, matching prior behaviour.
 */
export function recallMemory(text: string, query: string, opts: RecallOptions): string {
  const { cap, relevantFraction = 0.4, topK = 6, trimmedMarker = TRIMMED_PLAIN } = opts
  if (text.length <= cap) return text // fits whole — unchanged, as before.

  const plainTail = `${trimmedMarker}\n${text.slice(-cap)}`
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return plainTail // no task query → old behaviour.

  const reserve = Math.max(0, Math.floor(cap * relevantFraction))
  const tailBudget = cap - reserve
  const tail = text.slice(-tailBudget)

  const blocks = splitBlocks(text)
  const scores = scoreBlocks(blocks, query)
  // Rank by relevance; break ties toward more-recent notes (higher index).
  const ranked = blocks
    .map((block, i) => ({ block, i, score: scores[i] }))
    .filter((b) => b.score > 0 && !tail.includes(b.block)) // only OLDER notes at risk of loss
    .sort((a, b) => (b.score - a.score) || (b.i - a.i))

  const picked: string[] = []
  const seen = new Set<string>()
  let used = 0
  for (const { block } of ranked) {
    if (picked.length >= topK) break
    if (seen.has(block)) continue
    if (used + block.length + 1 > reserve) continue // keep within the reserved budget
    picked.push(block)
    seen.add(block)
    used += block.length + 1
  }
  if (picked.length === 0) return plainTail // nothing relevant survived → old behaviour.

  return `${HEADER}\n${picked.join('\n')}\n${TRIMMED_WITH_RECALL}\n${tail}`
}
