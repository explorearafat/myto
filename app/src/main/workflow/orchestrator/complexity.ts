/**
 * Complexity router — decides how much team the orchestrator assembles for a
 * work turn: `simple` (one small change → a single execution node, no planner
 * LLM call), `medium` (a few related slices), or `complex` (multi-domain work,
 * many deliverables, or a broad refactor).
 *
 * It only sizes the team; the plan → execute → verify → review gate always runs,
 * so a wrong guess is low-stakes (it just over- or under-provisions specialists).
 *
 * **The model does the sizing.** {@link classifyComplexity} asks it, every turn,
 * with the project's overview for grounding. The keyword machinery below is the
 * *fallback* — the answer used when there is no model to ask (offline, provider
 * down, Stop pressed) — and nothing else. It used to be the other way round,
 * heuristic-first with the model consulted only where the keywords felt unsure,
 * and that inverted the two: judging how much work a person is asking for is
 * exactly what a word-frequency table cannot do and a model can.
 *
 * Every keyword list below is matched as a whole word (see
 * {@link import('../markers')}), not as a substring: `includes('ui')` fires on
 * "b**ui**ld" and `includes('make')` on the Banglish "to**make**", and a handful
 * of those phantom hits is all it takes to size a one-file tweak as a
 * multi-domain build.
 *
 * **Ceremony is earned, never guessed.** Counting *domains* used to be enough on
 * its own: two of them returned `complex`. But a domain is a vocabulary hit, and
 * ordinary requests name two of them by accident — "a login page" is the auth
 * domain ("login", "sign up") plus the frontend domain ("page"), so EVERY
 * login-page request was structurally unsizeable. It routed `complex`, and
 * `complex` is expensive in four separate places: the engine forces `max`
 * reasoning effort for the whole turn, the roadmap becomes the nine-phase
 * greenfield-product one, the plan renders all 29 sections, and a 20-section
 * PROJECT.md gets written first — four long serial calls before the first line of
 * the page the user asked for. So `complex` needs evidence a person would
 * recognise as breadth: the user saying so, three or more domains, or four or
 * more deliverables. Two nouns is not evidence. That rule now only governs the
 * offline fallback, but it governs the worst case, which is the one that stranded
 * a user for an hour.
 *
 * The asymmetry is deliberate, in the rubric and in the rungs alike. Under-sizing
 * means Sylor reads what it needs and does the work (plan → execute → verify →
 * review still runs, and the next turn re-routes); over-sizing means an hour of
 * documents. When two sizes both fit, take the smaller one.
 */
import type { ChatMessage, Complexity, ProviderSettings } from '../../../shared/types'
import { providerFromSettings } from '../../providers'
import { matchesAnyWord, wordMatches } from '../markers'
import { isAbort } from '../resilience'

/** Edit verbs — each distinct one present counts as a deliverable. */
const DELIVERABLE_VERBS = [
  'build',
  'create',
  'add',
  'implement',
  'write',
  'fix',
  'update',
  'refactor',
  'integrate',
  'migrate',
  'set up',
  'setup',
  'configure',
  'design',
  'make',
  'generate',
  'wire'
]

/**
 * "Substantial" verbs that imply the change is more than a one-liner even when
 * the prompt is short — never classified `simple` on their own.
 */
const SUBSTANTIAL_VERBS = [
  'refactor',
  'redesign',
  'rework',
  'migrate',
  'integrate',
  'architect',
  'overhaul',
  'optimize',
  'rewrite',
  'restructure'
]

/** Language signalling a broad, cross-cutting change → complex. */
const BROAD_SCOPE = [
  'entire',
  'whole project',
  'the whole',
  'across the',
  'every file',
  'all files',
  'all the files',
  'codebase',
  'throughout',
  'end-to-end',
  'end to end',
  'full stack',
  'fullstack',
  'multiple files',
  'several files',
  'from scratch',
  'the architecture'
]

/** Distinct technical domains, so we can detect multi-domain (→ complex) work. */
const DOMAIN_MARKERS: Record<string, string[]> = {
  frontend: ['frontend', 'front-end', 'ui', 'component', 'react', 'vue', 'svelte', 'css', 'styling', 'page', 'screen', 'layout'],
  backend: ['backend', 'back-end', 'api', 'endpoint', 'server', 'route', 'controller', 'handler'],
  database: ['database', 'schema', 'migration', 'sql', 'postgres', 'sqlite', 'mongo', 'query', 'queries'],
  auth: ['auth', 'authentication', 'authorization', 'login', 'signup', 'sign up', 'session', 'jwt', 'oauth'],
  devops: ['deploy', 'deployment', 'ci/cd', 'pipeline', 'docker', 'kubernetes', 'infra', 'infrastructure'],
  testing: ['unit test', 'e2e', 'integration test', 'test suite', 'coverage']
}

/**
 * Named UI surfaces. A surface is a countable *thing to build*, which is what
 * makes it a better scale signal than a domain: "a sign-up and login page" names
 * one surface however many domains its vocabulary happens to touch, and however
 * long the user takes to describe it.
 *
 * Only unambiguous surface nouns belong here. `view`, `list`, `row`, `field`,
 * `table` and `section` are all common in prose about code ("the list of files",
 * "in view of that") and would count surfaces that nobody asked for.
 */
const SURFACE_NOUNS = [
  'page',
  'screen',
  'form',
  'modal',
  'dialog',
  'popup',
  'drawer',
  'sidebar',
  'navbar',
  'header',
  'footer',
  'banner',
  'menu',
  'tab',
  'card',
  'panel',
  'button',
  'icon',
  'logo',
  'avatar',
  'badge',
  'toast',
  'tooltip',
  'dropdown',
  'spinner',
  'breadcrumb',
  'stepper',
  'wizard',
  'cart',
  'checkout',
  'onboarding'
]

/**
 * Whole products. Naming one as the thing being built is not one surface, so a
 * prompt mentioning a product without an obviously small surface count is left
 * for the LLM router to size rather than answered from vocabulary.
 *
 * Kept narrow on purpose: `store` (Zustand), `system` ("design system") and
 * `product` ("product page") are ordinary words in this codebase's own prose.
 */
const PRODUCT_NOUNS = [
  'app',
  'application',
  'webapp',
  'website',
  'site',
  'platform',
  'portal',
  'dashboard',
  'saas',
  'marketplace',
  'storefront',
  'shop',
  'blog',
  'crm',
  'erp',
  'clone',
  'game'
]

/**
 * How long a prompt with no scale signals at all may be and still be `simple`.
 * The old bound was 14 words, which meant a request explained carefully — or in
 * Banglish, which is wordier — could never be small no matter how little it
 * asked for. Length is not scope.
 */
const MAX_SIMPLE_WORDS = 60

/** The raw signals extracted from a prompt. */
interface Signals {
  wordCount: number
  domains: number
  broad: boolean
  deliverables: number
  substantial: boolean
  surfaces: number
  products: number
}

/** Counts distinct technical domains referenced by the prompt. */
function countDomains(lower: string): number {
  let n = 0
  for (const markers of Object.values(DOMAIN_MARKERS)) {
    if (matchesAnyWord(lower, markers)) n++
  }
  return n
}

/** Rough deliverable count: distinct edit verbs + explicit list items. */
function countDeliverables(lower: string): number {
  const verbs = new Set(wordMatches(lower, DELIVERABLE_VERBS))
  const listItems = (lower.match(/(^|\n)\s*(\d+[.)]|[-*])\s+/g) ?? []).length
  return verbs.size + listItems
}

/** Extracts the complexity signals from a prompt. */
function signalsFor(prompt: string): Signals {
  const lower = prompt.toLowerCase()
  return {
    wordCount: lower.split(/\s+/).filter(Boolean).length,
    domains: countDomains(lower),
    broad: matchesAnyWord(lower, BROAD_SCOPE),
    deliverables: countDeliverables(lower),
    substantial: matchesAnyWord(lower, SUBSTANTIAL_VERBS),
    surfaces: new Set(wordMatches(lower, SURFACE_NOUNS)).size,
    products: new Set(wordMatches(lower, PRODUCT_NOUNS)).size
  }
}

/**
 * The one place the keyword ladder lives, so no two callers can disagree about
 * what a prompt looks like.
 *
 * Rungs, in order:
 * 1. The user described breadth → complex. Their word is the best evidence there is.
 * 2. Three or more domains, or four or more deliverables → complex. Genuine breadth.
 * 3. One or two named surfaces and nothing substantial → simple, at any length.
 *    A screen is a screen even when the request explaining it is a paragraph.
 * 4. A whole product named → medium. Too big to be one surface, too vague to be a build.
 * 5. Three deliverables → complex.
 * 6. No signal at all in a short-enough prompt → simple.
 * 7. Anything left → medium.
 */
function route(prompt: string): Complexity {
  const s = signalsFor(prompt)
  if (s.broad) return 'complex'
  if (s.domains >= 3 || s.deliverables >= 4) return 'complex'
  if (s.surfaces > 0 && s.surfaces <= 2 && !s.substantial && s.deliverables <= 2) return 'simple'
  if (s.products > 0) return 'medium'
  if (s.deliverables >= 3) return 'complex'
  if (!s.substantial && s.domains === 0 && s.deliverables <= 1 && s.wordCount <= MAX_SIMPLE_WORDS) {
    return 'simple'
  }
  return 'medium'
}

/**
 * The keyword heuristic. **Not the router** — it is the answer used when the model
 * cannot be reached (offline, no model configured, a provider error, a Stop), so
 * that sizing degrades instead of blocking. {@link classifyComplexity} is the
 * router, and it asks the model.
 */
export function classifyComplexityHeuristic(prompt: string): Complexity {
  return route(prompt)
}

/** What the router asks the model for. `reason` first, so the label follows it. */
interface RouterVerdict {
  reason?: unknown
  complexity?: unknown
}

/** Extra grounding for the router, when the turn has it. */
export interface ComplexityContext {
  /** What already exists in this project — the engine's overview digest. */
  overview?: string
}

/** How many times a garbled or failed verdict is re-asked before falling back. */
const ROUTER_ATTEMPTS = 2

/**
 * Sizes the request. **The model decides**, every time.
 *
 * This used to be heuristic-first: keyword rungs answered whenever they felt
 * confident, and only a prompt they found ambiguous reached the model. That is
 * backwards — the rungs are a word-frequency table and the thing being judged is
 * how much work a person is asking for. It shipped the exact failure the user
 * named: "a sign up and login page" scored two domains, so a keyword table sized
 * one screen as a nine-phase product build and the model it could have asked was
 * never consulted.
 *
 * So the shape is now: ask the model, with the project's own overview for
 * grounding so "add a settings page" is sized against a repo that already has a
 * shell rather than against nothing. Re-ask once if the reply is garbled. Fall
 * back to {@link classifyComplexityHeuristic} only when there is no answer to be
 * had — offline, provider down, or the user pressed Stop. A turn never blocks on
 * this, and it never spends more than {@link ROUTER_ATTEMPTS} short calls.
 */
export async function classifyComplexity(
  prompt: string,
  settings: ProviderSettings,
  signal?: AbortSignal,
  context?: ComplexityContext
): Promise<Complexity> {
  // Nothing to size, and nothing a round-trip could add.
  if (!prompt.trim()) return 'simple'

  const provider = providerFromSettings(settings)
  const messages: ChatMessage[] = [
    { role: 'system', content: ROUTER_SYSTEM },
    { role: 'user', content: routerRequest(prompt, context) }
  ]

  for (let attempt = 0; attempt < ROUTER_ATTEMPTS; attempt++) {
    if (signal?.aborted) break
    try {
      const raw = await provider.getCompletion(settings.modelId, messages, undefined, signal)
      const parsed = parseComplexityJson(raw)
      if (parsed) return parsed
    } catch (err) {
      // A Stop is not a failure to retry — leave immediately.
      if (isAbort(err)) break
    }
  }
  return classifyComplexityHeuristic(prompt)
}

/**
 * The rubric. It names what each size *costs the user*, because that is the part
 * a model cannot infer and the part that goes wrong: `complex` is not a
 * compliment, it is a spec document, a nine-phase roadmap and a long planning
 * detour before the first line of code, and a model that reads "size this
 * request" without that context reaches for it to seem thorough.
 */
const ROUTER_SYSTEM = [
  "You are Sylor's complexity router. You decide how much process one work turn gets.",
  '',
  'Pick exactly one:',
  '- "simple" — one screen, one component, one file, one fix. The agent goes straight to work: no planning documents, no roadmap. A long or carefully-explained request for ONE thing is still simple.',
  '- "medium" — a few related pieces that touch a couple of areas, needing a short plan first.',
  '- "complex" — a whole product or a broad cross-cutting change: many separate deliverables across several domains (frontend + backend + database), or a refactor across the codebase.',
  '',
  'Judge the WORK, not the wording. Detail, politeness, design goals ("make it look classic"), named technologies and non-English phrasing add words, not scope. Two or three deliverables are not a product.',
  '',
  'Costs, so you can weigh them: "complex" makes the agent write a 20-section product specification, a nine-phase roadmap and a 29-section plan — several minutes of documents — before it writes any code. Choosing it for a single screen wastes the user\'s hour and is the most common mistake. "simple" only risks the agent doing the work and planning the rest next turn. When two sizes both fit, choose the smaller one.',
  '',
  'Reply with ONLY valid JSON, the reason first, one short sentence:',
  '{"reason":"...","complexity":"simple"|"medium"|"complex"}'
].join('\n')

/** The request as the router sees it: what was asked, and what already exists. */
function routerRequest(prompt: string, context?: ComplexityContext): string {
  const overview = context?.overview?.trim() ?? ''
  return (
    `## The request\n${prompt.trim()}\n\n` +
    (overview
      ? `## What already exists\n${overview}\n\n(An existing project means most requests are additions to it, not new products.)`
      : '## What already exists\nUnknown — no project context was gathered this turn.')
  )
}

/** Tolerantly parses the model's JSON, stripping any markdown fence noise. */
function parseComplexityJson(raw: unknown): Complexity | null {
  if (typeof raw !== 'string') return null
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    const obj = JSON.parse(raw.slice(start, end + 1)) as RouterVerdict
    if (obj.complexity === 'simple' || obj.complexity === 'medium' || obj.complexity === 'complex') {
      return obj.complexity
    }
    return null
  } catch {
    return null
  }
}
