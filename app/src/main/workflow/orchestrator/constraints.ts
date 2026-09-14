import type { Complexity, ReasoningEffort } from '../../../shared/types'

/**
 * Explicit planning constraints — the scope a user states in words, extracted
 * deterministically so the plan can obey it (design-proposal.md · Principle 1).
 *
 * This module is intentionally standalone: it imports only the `Complexity`
 * type and knows nothing about the planner, the roadmap or the engine. The
 * orchestrator is the single place that reads a request through it and threads
 * the result into the planner / staging seams.
 *
 * Everything here is heuristic and conservative by design. A missed constraint
 * means the plan is sized the way it always was (no regression); a false
 * positive would wrongly shrink a plan, so each matcher demands an explicit,
 * unambiguous phrase rather than guessing from tone.
 */
export interface PlanConstraints {
  /** "in at most 5 steps" / "5 tasks or fewer" → a hard ceiling on task nodes. */
  maxSteps?: number
  /** "no more than 2 phases" → a stated ceiling on the roadmap's phase count. */
  maxPhases?: number
  /** "keep it minimal" / "don't over-engineer" → a lean plan, whatever the size. */
  minimal?: boolean
  /** "only touch src/foo.ts" → the files the work is confined to (advisory). */
  filesScope?: string[]
  /** The phrase(s) matched, quoted back into the plan so the user sees them honoured. */
  verbatim?: string
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}

// Digits (1–3) or a spelled-out number up to twelve. Four-digit runs never match
// (`\d{1,3}` cannot span a year like 2026), so "in 2026 …" is not read as a cap.
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseNum(token: string): number | undefined {
  const t = token.toLowerCase()
  const n = /^\d+$/.test(t) ? Number(t) : NUMBER_WORDS[t]
  // A cap is only a real scope signal when it is a small positive count: "0 steps"
  // is not a plan, and an implausibly large number is noise rather than a budget.
  return n !== undefined && n >= 1 && n <= 50 ? n : undefined
}

/**
 * Find a numeric cap for a noun (`noun` is a non-capturing regex fragment such as
 * `(?:steps?|tasks?)`), in either order: "at most 5 steps" or "5 steps or fewer".
 */
function findCap(text: string, noun: string): { n: number; phrase: string } | undefined {
  const patterns = [
    new RegExp(
      `(?:at most|no more than|maximum of|max(?:imum)?|up to|within|in|using|keep(?: it)?(?: down)? to|limit(?:ed)? to)\\s+${NUM}\\s+${noun}`,
      'i',
    ),
    new RegExp(`${NUM}\\s+${noun}\\s+(?:or fewer|or less|or under|maximum|max|tops|at most)`, 'i'),
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) {
      const n = parseNum(m[1])
      if (n !== undefined) return { n, phrase: m[0].trim() }
    }
  }
  return undefined
}

// Curated phrases that unambiguously ask for a lean result. Kept explicit rather
// than inferred so ordinary requests are never mistaken for a minimal directive.
const MINIMAL_PHRASES = [
  'keep it minimal',
  'keep this minimal',
  'keep it simple',
  'keep it small',
  'keep it lean',
  'keep it light',
  'keep it basic',
  'minimal change',
  'minimal changes',
  'minimal implementation',
  'minimal version',
  'minimal footprint',
  'minimal scope',
  'smallest change',
  'smallest possible change',
  'the simplest thing',
  'as simple as possible',
  'as simply as possible',
  "don't over-engineer",
  'do not over-engineer',
  'no over-engineering',
  'without over-engineering',
  'nothing fancy',
  'no frills',
  'bare minimum',
  'quick and dirty',
  'lightweight',
  'no ceremony',
  'just the essentials',
  'only the essentials',
]
const MINIMAL_RE = new RegExp(`\\b(${MINIMAL_PHRASES.map(escapeRe).join('|')})\\b`, 'i')

/**
 * "only touch src/foo.ts and src/bar.ts" → the file-ish tokens named. Conservative:
 * a token counts only when it contains a path separator or a dotted extension, so
 * prose ("only touch the login flow") yields nothing rather than garbage.
 */
function findFilesScope(text: string): { files: string[]; phrase: string } | undefined {
  const m = /\bonly\s+(?:touch|modify|edit|change|update|work (?:in|on))\s+(.{1,140}?)(?:[.!?](?:\s|$)|\n|$)/i.exec(
    text,
  )
  if (!m) return undefined
  const tokens = m[1]
    .split(/[\s,]+|\band\b/i)
    .map((t) => t.replace(/^[`'"(]+/, '').replace(/[`'").]+$/, ''))
    .filter(Boolean)
  const files = tokens.filter(
    (t) => t.includes('/') || t.includes('\\') || /\.[a-z][a-z0-9]{0,7}$/i.test(t),
  )
  if (files.length === 0) return undefined
  const unique = [...new Set(files)]
  return { files: unique, phrase: `only touch ${unique.join(', ')}` }
}

/** Read a request and pull out any explicit scope the user stated. */
export function extractConstraints(request: string): PlanConstraints {
  const text = request ?? ''
  const out: PlanConstraints = {}
  const phrases: string[] = []

  const steps = findCap(text, '(?:steps?|tasks?)')
  if (steps) {
    out.maxSteps = steps.n
    phrases.push(steps.phrase)
  }

  const phases = findCap(text, 'phases?')
  if (phases) {
    out.maxPhases = phases.n
    phrases.push(phases.phrase)
  }

  const minimal = MINIMAL_RE.exec(text)
  if (minimal) {
    out.minimal = true
    phrases.push(minimal[1])
  }

  const scope = findFilesScope(text)
  if (scope) {
    out.filesScope = scope.files
    phrases.push(scope.phrase)
  }

  if (phrases.length > 0) out.verbatim = phrases.join('; ')
  return out
}

/** True when the user stated any scope worth honouring. */
export function hasConstraints(c: PlanConstraints): boolean {
  return (
    c.maxSteps !== undefined ||
    c.maxPhases !== undefined ||
    !!c.minimal ||
    (c.filesScope?.length ?? 0) > 0
  )
}

/**
 * The roadmap tier an explicit smaller-scope request should be clamped down to,
 * or `undefined` when the constraints imply no shrink.
 *
 * Deliberately never returns `'simple'`: the simple tier disables staged planning
 * entirely (a single node, no roadmap document), which is a larger behavioural
 * change than "fewer phases" and belongs to the complexity router, not to a scope
 * phrase. Arbitrary numeric phase counts (a literal "exactly 2 phases") need
 * cross-turn-persisted authored phase names — Principle 1 #3, deferred — so until
 * then explicit scope caps the ceremony at the medium roadmap and the precise task
 * count is enforced separately (see the planner's task cap). The caller applies
 * this shrink-only: it may lower the tier, never raise it.
 */
export function phaseCeilingComplexity(c: PlanConstraints): Complexity | undefined {
  const wantsSmaller =
    !!c.minimal ||
    (c.maxPhases !== undefined && c.maxPhases < 9) ||
    (c.maxSteps !== undefined && c.maxSteps <= 5)
  return wantsSmaller ? 'medium' : undefined
}

/**
 * The reasoning tier a turn runs its lead/base calls at (Principle 5) — sized from
 * the SAME inputs as the roadmap so the two can never disagree.
 *
 * A turn the model sized `complex` normally forces `max`: project creation and a
 * codebase-wide change must not be starved of thinking budget. But when the user
 * set an explicit smaller scope that clamps the roadmap to `medium` (see
 * {@link phaseCeilingComplexity}), the turn falls back to the `requested` tier
 * instead, so "build the login page — keep it minimal" never pays `max` thinking
 * for a `medium` roadmap. Shrink-only: it can lower a `complex` turn to the
 * requested tier, never raise a `simple`/`medium` turn above it. Pure over
 * (complexity, requested, request text).
 */
export function effectiveTurnEffort(
  complexity: Complexity | null,
  requested: ReasoningEffort,
  request: string
): ReasoningEffort {
  if (complexity !== 'complex') return requested
  const clampsToMedium = phaseCeilingComplexity(extractConstraints(request)) === 'medium'
  return clampsToMedium ? requested : 'max'
}

/**
 * A one-line, imperative rendering of the constraints for a model prompt / plan.
 * Empty string when there is nothing to say, so callers can concatenate freely.
 */
export function describeConstraints(c: PlanConstraints): string {
  if (!hasConstraints(c)) return ''
  const rules: string[] = []
  if (c.maxSteps !== undefined) rules.push(`use at most ${c.maxSteps} task${c.maxSteps === 1 ? '' : 's'}`)
  if (c.maxPhases !== undefined)
    rules.push(`use at most ${c.maxPhases} phase${c.maxPhases === 1 ? '' : 's'}`)
  if (c.minimal)
    rules.push(
      'keep it minimal — the smallest change that satisfies the request, with no extra scaffolding, abstraction or features the user did not ask for',
    )
  if (c.filesScope?.length) rules.push(`touch only these files: ${c.filesScope.join(', ')}`)
  const quoted = c.verbatim ? ` (the user's words: “${c.verbatim}”)` : ''
  return `Explicit scope set by the user${quoted} — honour it exactly, do not exceed it: ${rules.join('; ')}.`
}
