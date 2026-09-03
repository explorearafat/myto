import type { Complexity } from '../../shared/types'
import { readProjectFile, writeProjectFile } from '../fs/operations'
import { memoryDocPath, resolveMemoryHome, SCAFFOLD_MARKER } from './projectMemory'

/**
 * Project state bookkeeping — the machine-readable half of `STATE.md`, plus the
 * plan archive, the session checkpoint, and the decision log.
 *
 * `STATE.md` is the one document that answers "where does the work stand?", and
 * the staged workflow has to both READ it (to know which phase is next) and WRITE
 * it (at the end of every phase). Prose can't be trusted for that, so the doc
 * carries four fixed header lines that this module owns:
 *
 * ```
 * Phase: 3 — Core pages
 * Status: in progress
 * Build: PASSING
 * Preview: RUNNING
 * ```
 *
 * Everything below those lines is the agent's own prose and is never rewritten —
 * {@link updateProjectState} patches the four lines in place and leaves the rest
 * of the document exactly as it found it. Parsing is deliberately tolerant: a
 * missing, reordered, or hand-edited header degrades to `UNKNOWN` rather than
 * throwing, so a human editing STATE.md can never break a run.
 *
 * Nothing here calls a model. Every function is deterministic, best-effort, and
 * non-throwing: state tracking is how the agent avoids re-auditing, not a gate it
 * can fail at.
 */

/** How the project's own checks stood the last time they ran. */
export type BuildHealth = 'PASSING' | 'FAILING' | 'UNKNOWN'

/**
 * What the preview pane is actually showing (§23 — the preview must never be
 * presented as current when it isn't):
 * - `RUNNING` — the live dev server, reflecting the current code.
 * - `STALE` — serving the previous successful build; newer edits aren't in it.
 * - `COMPILE_ERROR` — the build broke, so the pane can't be current.
 * - `RUNTIME_ERROR` — it compiled and served, but the page itself is throwing.
 * - `UNAVAILABLE` — no preview server is up.
 */
export type PreviewHealth =
  | 'RUNNING'
  | 'STALE'
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'UNAVAILABLE'
  | 'UNKNOWN'

/** The parsed header of `STATE.md`. */
export interface ProjectState {
  /** Phase number, or 0 when no phase has started. */
  phase: number
  /** The phase's name (`''` when unnamed). */
  phaseName: string
  /** Free-text status: `not started` / `in progress` / `complete` / `blocked`. */
  status: string
  build: BuildHealth
  preview: PreviewHealth
  /**
   * The routed complexity this project's roadmap was sized to, once one has been
   * recorded. Persisted because the roadmap must not resize between turns: "phase 3
   * of 9" has to still be out of 9 next session, even if that turn's request would
   * have routed as simple on its own.
   */
  complexity?: Complexity
  /** True when STATE.md doesn't exist yet or is still the untouched scaffold. */
  fresh: boolean
}

/** A patch for the owned header lines; omitted fields are left alone. */
export interface ProjectStatePatch {
  phase?: number
  phaseName?: string
  status?: string
  build?: BuildHealth
  preview?: PreviewHealth
  complexity?: Complexity
}

const BUILD_VALUES: readonly BuildHealth[] = ['PASSING', 'FAILING', 'UNKNOWN']
const PREVIEW_VALUES: readonly PreviewHealth[] = [
  'RUNNING',
  'STALE',
  'COMPILE_ERROR',
  'RUNTIME_ERROR',
  'UNAVAILABLE',
  'UNKNOWN'
]
const COMPLEXITY_VALUES: readonly Complexity[] = ['simple', 'medium', 'complex']

/** Reads a project-relative file, trimmed of nothing; null on any failure. */
function read(rel: string): string | null {
  try {
    return readProjectFile(rel)
  } catch {
    return null
  }
}

/** Writes a project-relative file; swallows failures (read-only checkout etc.). */
function write(rel: string, content: string): boolean {
  try {
    writeProjectFile(rel, content)
    return true
  } catch {
    return false
  }
}

/** Value of a `Key: value` header line, or '' when absent. */
function headerValue(doc: string, key: string): string {
  const m = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, 'im').exec(doc)
  return m ? m[1].trim() : ''
}

/** `3 — Core pages` / `Phase 3: core pages` / `—` → number + name. */
function parsePhase(raw: string): { phase: number; phaseName: string } {
  const m = /(\d+)/.exec(raw)
  const phase = m ? Number(m[1]) : 0
  const name = raw
    .replace(/^\s*phase\s*/i, '')
    .replace(/^\s*\d+\s*/, '')
    .replace(/^[—\-:.]+\s*/, '')
    .trim()
  return { phase, phaseName: name === '—' ? '' : name }
}

/** Coerces a header value to one of `allowed`, defaulting to `UNKNOWN`. */
function parseEnum<T extends string>(raw: string, allowed: readonly T[]): T {
  const up = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return (allowed as readonly string[]).includes(up) ? (up as T) : ('UNKNOWN' as T)
}

/**
 * Reads the current project state. A missing or still-scaffolded `STATE.md`
 * yields `fresh: true` with phase 0 — the signal that this project has no
 * recorded progress and the workflow should start at phase 1.
 */
export function readProjectState(): ProjectState {
  const doc = read(memoryDocPath('state'))
  if (doc === null || doc.includes(SCAFFOLD_MARKER)) {
    return {
      phase: 0,
      phaseName: '',
      status: 'not started',
      build: 'UNKNOWN',
      preview: 'UNKNOWN',
      fresh: true
    }
  }
  const { phase, phaseName } = parsePhase(headerValue(doc, 'Phase'))
  const routed = headerValue(doc, 'Complexity').trim().toLowerCase()
  return {
    phase,
    phaseName,
    status: headerValue(doc, 'Status') || 'in progress',
    build: parseEnum(headerValue(doc, 'Build'), BUILD_VALUES),
    preview: parseEnum(headerValue(doc, 'Preview'), PREVIEW_VALUES),
    complexity: (COMPLEXITY_VALUES as readonly string[]).includes(routed)
      ? (routed as Complexity)
      : undefined,
    fresh: false
  }
}

/** The header block, rendered from a full state. */
function renderHeader(state: ProjectState): string {
  const phase =
    state.phase > 0 ? `${state.phase}${state.phaseName ? ` — ${state.phaseName}` : ''}` : '—'
  return [
    `Phase: ${phase}`,
    `Status: ${state.status}`,
    `Build: ${state.build}`,
    `Preview: ${state.preview}`,
    `Complexity: ${state.complexity ?? '—'}`
  ].join('\n')
}

/** Replaces a `Key: …` line in place, or returns null when the key is absent. */
function replaceHeaderLine(doc: string, key: string, value: string): string | null {
  const re = new RegExp(`^([ \\t]*${key}[ \\t]*:).*$`, 'im')
  return re.test(doc) ? doc.replace(re, `$1 ${value}`) : null
}

/**
 * Patches the owned header lines of `STATE.md`, preserving every other byte of the
 * document (the agent's own Completed / Next action / Known issues prose).
 *
 * A still-scaffolded doc has its {@link SCAFFOLD_MARKER} dropped on the first real
 * update, which is what promotes it from "not written yet" (listed by name only) to
 * a document the memory preamble actually injects. A doc missing a header line
 * gets the whole block re-inserted after its title. Returns the state that was
 * written, so a caller can log or emit it. Never throws.
 */
export function updateProjectState(patch: ProjectStatePatch): ProjectState {
  const current = readProjectState()
  const next: ProjectState = {
    phase: patch.phase ?? current.phase,
    phaseName: patch.phaseName ?? (patch.phase && patch.phase !== current.phase ? '' : current.phaseName),
    status: patch.status ?? current.status,
    build: patch.build ?? current.build,
    preview: patch.preview ?? current.preview,
    // Never un-sizes a roadmap: once recorded, only an explicit patch changes it.
    complexity: patch.complexity ?? current.complexity,
    fresh: false
  }

  const rel = memoryDocPath('state')
  const existing = read(rel)
  if (existing === null) {
    write(rel, `# Current state\n\n${renderHeader(next)}\n`)
    return next
  }

  let doc = existing.replace(`${SCAFFOLD_MARKER}\n`, '').replace(SCAFFOLD_MARKER, '')
  let patched = true
  const owned: [string, string][] = [
    ['Phase', next.phase > 0 ? `${next.phase}${next.phaseName ? ` — ${next.phaseName}` : ''}` : '—'],
    ['Status', next.status],
    ['Build', next.build],
    ['Preview', next.preview]
  ]
  // Only claim the Complexity line once there is a value for it, so a project that
  // has never been sized doesn't get a placeholder line it didn't ask for.
  if (next.complexity) owned.push(['Complexity', next.complexity])
  for (const [key, value] of owned) {
    const replaced = replaceHeaderLine(doc, key, value)
    if (replaced === null) {
      patched = false
      break
    }
    doc = replaced
  }

  if (!patched) {
    // A hand-mangled doc: drop whatever owned lines it does have and re-insert the
    // whole block after the first heading, so the header ends up complete, ordered
    // and unduplicated rather than half-patched.
    const lines = doc
      .split(/\r?\n/)
      .filter((l) => !/^[ \t]*(Phase|Status|Build|Preview|Complexity)[ \t]*:/i.test(l))
    const at = lines.findIndex((l) => l.startsWith('#')) + 1
    lines.splice(at, 0, '', renderHeader(next))
    doc = lines.join('\n')
  }

  write(rel, doc.trimStart())
  return next
}

// ── Plan archive ─────────────────────────────────────────────────────────────

/** `Core pages & routing` → `core-pages-routing`, for a stable archive filename. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'phase'
}

/** Where a finished phase's plan is filed. */
export function archivedPlanPath(phase: number, name: string): string {
  const num = String(Math.max(1, phase)).padStart(2, '0')
  return `${resolveMemoryHome().dir}/plans/phase-${num}-${slugify(name)}.md`
}

/**
 * Files the active plan under `plans/phase-XX-name.md` and clears the live
 * `plan.md` so it can never be mistaken for the current phase (§36 — "never leave
 * plan.md describing completed work"). The stub deliberately contains **no**
 * unchecked `- [ ]` box, so the engine's continue-nudge doesn't fire on it.
 *
 * `completedIds` ticks the task boxes of the nodes that actually finished, so the
 * archived plan records what was done rather than what was intended. This runs on
 * the plain fs path (not the gated tool path) because it is the engine's own
 * bookkeeping, not an edit the user needs to approve.
 *
 * Returns the archive path, or null when there was no plan to archive.
 */
export function archivePlan(
  phase: number,
  name: string,
  planPath: string,
  completedIds: readonly string[] = []
): string | null {
  const content = read(planPath)
  if (content === null || !content.trim()) return null

  let body = content
  for (const id of completedIds) {
    // Only the task lines carry `- [ ] **id**`, so this can't touch prose.
    body = body.replace(new RegExp(`^- \\[ \\] \\*\\*${escapeRe(id)}\\*\\*`, 'gm'), `- [x] **${id}**`)
  }

  const dest = archivedPlanPath(phase, name)
  const header = `<!-- archived: phase ${phase}${name ? ` — ${name}` : ''} -->\n`
  if (!write(dest, body.startsWith('<!--') ? body : header + body)) return null

  write(
    planPath,
    `# Plan\n\nPhase ${phase}${name ? ` (${name})` : ''} is complete and archived to \`${dest}\`.\nNo phase is active.\n`
  )
  return dest
}

/** Escapes a task id for use inside a RegExp. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Decision log ─────────────────────────────────────────────────────────────

/** One entry for the append-only decision log (§11). */
export interface DecisionEntry {
  decision: string
  reason: string
  alternatives?: string
  consequence?: string
}

/**
 * Appends a decision to `DECISIONS.md`, newest LAST — the log is append-only and
 * history is never rewritten. Creates the doc when absent and drops the scaffold
 * marker on the first real entry. Returns false when nothing could be written.
 */
export function appendDecision(entry: DecisionEntry): boolean {
  const rel = memoryDocPath('decisions')
  const date = new Date().toISOString().slice(0, 10)
  const block = [
    `## ${date} — ${entry.decision.trim()}`,
    `- Reason: ${entry.reason.trim()}`,
    `- Alternatives considered: ${entry.alternatives?.trim() || '—'}`,
    `- Consequence: ${entry.consequence?.trim() || '—'}`,
    ''
  ].join('\n')

  const existing = read(rel)
  if (existing === null) return write(rel, `# Decision log\n\n${block}`)
  const body = existing.replace(`${SCAFFOLD_MARKER}\n`, '').replace(SCAFFOLD_MARKER, '')
  return write(rel, `${body.replace(/\s*$/, '')}\n\n${block}`)
}

// ── Session checkpoints ──────────────────────────────────────────────────────

/** What a session checkpoint records (§27) so the next session need not re-audit. */
export interface SessionCheckpoint {
  objective: string
  completed: string
  inProgress: string
  nextAction: string
  filesChanged: string[]
  errors?: string
  decisions?: string
  /** The facts a fresh session must NOT spend calls rediscovering. */
  doNotRediscover: string
}

/**
 * The stable path of the most recent checkpoint. Written alongside the timestamped
 * copy so a new session can load it with ONE read and no directory listing.
 */
export function latestCheckpointPath(): string {
  return `${resolveMemoryHome().dir}/sessions/latest.md`
}

/** `2026-09-03-1642` — sortable, filesystem-safe, minute resolution. */
function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

/**
 * Writes a session checkpoint to `sessions/<timestamp>.md` **and** to
 * `sessions/latest.md`. Called before the context window is exhausted (and at the
 * end of a phase), so a session that gets cut off resumes from a document instead
 * of re-auditing the project. Returns the timestamped path, or null on failure.
 */
export function writeSessionCheckpoint(cp: SessionCheckpoint, now: Date = new Date()): string | null {
  const body = [
    `# Session checkpoint — ${now.toISOString()}`,
    '',
    '## Current objective',
    cp.objective.trim() || '—',
    '',
    '## Completed this session',
    cp.completed.trim() || '—',
    '',
    '## In progress',
    cp.inProgress.trim() || '—',
    '',
    '## Next action',
    cp.nextAction.trim() || '—',
    '',
    '## Files changed',
    cp.filesChanged.length ? cp.filesChanged.map((f) => `- ${f}`).join('\n') : '—',
    '',
    '## Errors encountered',
    cp.errors?.trim() || '—',
    '',
    '## Decisions made',
    cp.decisions?.trim() || '—',
    '',
    '## Do NOT rediscover',
    cp.doNotRediscover.trim() || '—',
    ''
  ].join('\n')

  const dir = `${resolveMemoryHome().dir}/sessions`
  const dated = `${dir}/${stamp(now)}.md`
  if (!write(dated, body)) return null
  write(latestCheckpointPath(), body)
  return dated
}

/** The most recent checkpoint's text, or null when this project has none. */
export function readLatestCheckpoint(): string | null {
  const text = read(latestCheckpointPath())
  return text && text.trim() ? text.trim() : null
}
