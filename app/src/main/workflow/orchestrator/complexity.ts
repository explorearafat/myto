/**
 * Complexity router — decides how much team the orchestrator assembles for a
 * work turn: `simple` (one small change → a single execution node, no planner
 * LLM call), `medium` (a few related slices), or `complex` (multi-domain work,
 * many deliverables, or a broad refactor).
 *
 * It only sizes the team; the plan → execute → verify → review gate always runs,
 * so a wrong guess is low-stakes (it just over- or under-provisions specialists).
 *
 * Mirrors {@link import('../intent')}'s design: a cheap deterministic heuristic
 * handles the clear cases (the extremes — obviously simple, obviously complex),
 * and only a genuinely ambiguous "middle" prompt spends a provider round-trip.
 * Any provider failure falls back to the heuristic, so a turn never blocks here.
 */
import type { ChatMessage, Complexity, ProviderSettings } from '../../../shared/types'
import { providerFromSettings } from '../../providers'

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
  database: ['database', 'schema', 'migration', 'sql', 'postgres', 'sqlite', 'mongo', 'query'],
  auth: ['auth', 'login', 'signup', 'sign up', 'session', 'jwt', 'oauth'],
  devops: ['deploy', 'ci/cd', 'pipeline', 'docker', 'kubernetes', 'infra', 'infrastructure'],
  testing: ['unit test', 'e2e', 'integration test', 'test suite', 'coverage']
}

/** The raw signals extracted from a prompt. */
interface Signals {
  wordCount: number
  domains: number
  broad: boolean
  deliverables: number
  substantial: boolean
}

/** Counts distinct technical domains referenced by the prompt. */
function countDomains(lower: string): number {
  let n = 0
  for (const markers of Object.values(DOMAIN_MARKERS)) {
    if (markers.some((m) => lower.includes(m))) n++
  }
  return n
}

/** Rough deliverable count: distinct edit verbs + explicit list items. */
function countDeliverables(lower: string): number {
  const verbs = new Set(DELIVERABLE_VERBS.filter((v) => lower.includes(v)))
  const listItems = (lower.match(/(^|\n)\s*(\d+[.)]|[-*])\s+/g) ?? []).length
  return verbs.size + listItems
}

/** Extracts the complexity signals from a prompt. */
function signalsFor(prompt: string): Signals {
  const lower = prompt.toLowerCase()
  return {
    wordCount: lower.split(/\s+/).filter(Boolean).length,
    domains: countDomains(lower),
    broad: BROAD_SCOPE.some((s) => lower.includes(s)),
    deliverables: countDeliverables(lower),
    substantial: SUBSTANTIAL_VERBS.some((v) => lower.includes(v))
  }
}

/**
 * Deterministic complexity heuristic. Cheap and used both for the fast path and
 * as the fallback when the LLM is unavailable or unsure.
 */
export function classifyComplexityHeuristic(prompt: string): Complexity {
  const s = signalsFor(prompt)
  if (s.broad || s.domains >= 2 || s.deliverables >= 3) return 'complex'
  if (!s.substantial && s.domains === 0 && s.deliverables <= 1 && s.wordCount <= 14) return 'simple'
  return 'medium'
}

/**
 * Whether the heuristic is confident enough to skip the LLM: only at the
 * extremes — a clearly complex request (broad scope, ≥2 domains, or ≥3
 * deliverables) or a clearly small one (no domain, ≤1 deliverable, short, and no
 * substantial verb). The mushy `medium` middle earns the smarter LLM call.
 */
export function heuristicIsConfident(prompt: string): boolean {
  const s = signalsFor(prompt)
  if (s.broad || s.domains >= 2 || s.deliverables >= 3) return true
  if (!s.substantial && s.domains === 0 && s.deliverables <= 1 && s.wordCount <= 14) return true
  return false
}

/**
 * Classifies request complexity, preferring the cheap heuristic and only
 * spending a provider round-trip on a genuinely ambiguous prompt. Falls back to
 * the heuristic on any failure so a turn never blocks on this.
 */
export async function classifyComplexity(
  prompt: string,
  settings: ProviderSettings
): Promise<Complexity> {
  // A trivially short prompt is simple; a confident heuristic answer is used
  // inline. Only the ambiguous middle pays for the completion below.
  if (prompt.trim().length < 12) return 'simple'
  if (heuristicIsConfident(prompt)) return classifyComplexityHeuristic(prompt)

  const provider = providerFromSettings(settings)

  const system =
    "You are Sylor's complexity router. Classify how much work the user's request needs: " +
    '"simple" (a single small change in one file/area), ' +
    '"medium" (a few related changes across a couple of areas), or ' +
    '"complex" (multi-domain work — e.g. frontend + backend + database — many deliverables, ' +
    'or a broad refactor across the codebase). ' +
    'Respond with ONLY valid JSON: {"complexity":"simple"|"medium"|"complex"}.'
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ]

  try {
    const raw = await provider.getCompletion(settings.modelId, messages)
    const parsed = parseComplexityJson(raw)
    if (parsed) return parsed
  } catch {
    // Fall through to the heuristic on any provider error.
  }
  return classifyComplexityHeuristic(prompt)
}

/** Tolerantly parses the model's JSON, stripping any markdown fence noise. */
function parseComplexityJson(raw: string): Complexity | null {
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    const obj = JSON.parse(raw.slice(start, end + 1)) as { complexity?: unknown }
    if (obj.complexity === 'simple' || obj.complexity === 'medium' || obj.complexity === 'complex') {
      return obj.complexity
    }
    return null
  } catch {
    return null
  }
}
