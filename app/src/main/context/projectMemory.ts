import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { contextManager } from './manager'
import { readProjectFile, writeProjectFile } from '../fs/operations'

/**
 * Persistent project memory — the documents that let Sylor UNDERSTAND a project
 * once and never rediscover it.
 *
 * The failure this exists to kill is `READ → SEARCH → READ → SEARCH`: an agent
 * that re-derives the same facts every turn (what the stack is, what each file is
 * for, where the work stands) burns its whole budget on archaeology and never
 * finishes anything. So the understanding is written down, in the project, as a
 * small set of markdown documents that are re-injected into every run:
 *
 *   - `<instructions>.md`  permanent project instructions (purpose, stack, rules,
 *                          commands, constraints) — loaded by `instructions.ts`.
 *   - `PROJECT.md`         the product specification (objective, users, features).
 *   - `ARCHITECTURE.md`    how the thing is actually built.
 *   - `FILEMAP.md`         every important file and what it is RESPONSIBLE for —
 *                          the answer to "what is this file for?", so the model
 *                          never opens a file merely to find that out.
 *   - `CONVENTIONS.md`     the patterns new code must match.
 *   - `DECISIONS.md`       the append-only decision log (with reasons).
 *   - `STATE.md`           where the work stands right now.
 *   - `TASKS.md`           the phase-organised checklist.
 *
 * **Directory integration, never destruction.** A repo already set up for another
 * agent gets its directory reused: `.claude/` is detected first (and preferred
 * when both are present, so its existing docs stay where the user's other tooling
 * looks for them), then Sylor's own `.sylor/`. When neither exists Sylor creates
 * `.sylor/` — the home that already holds `index.json`, `SYLOR.md`, and `skills/`
 * — rather than fragmenting its memory across two directories.
 *
 * Everything here is best-effort and deterministic: no model calls, no throws. A
 * missing, unreadable, or half-written document degrades to "that section is
 * absent", never to a failed run.
 */

/** Recognised agent-memory directories, in detection-preference order. */
export const MEMORY_DIRS = ['.claude', '.sylor'] as const
export type MemoryDirName = (typeof MEMORY_DIRS)[number]

/** Created when Sylor scaffolds a doc; its presence means "not written yet". */
export const SCAFFOLD_MARKER = '<!-- sylor:scaffold -->'

/** Total char budget for the injected memory preamble (keeps the prompt lean). */
const MAX_MEMORY_CHARS = 11_000

/**
 * The phase plan's filename. It is looked for inside the memory dir first and at
 * the project root second, so the historical root-level `plan.md` keeps working.
 */
const PLAN_FILE = 'plan.md'

/** Where a project's memory documents live, and what its instruction doc is called. */
export interface MemoryHome {
  /** Project-relative directory name. */
  dir: MemoryDirName
  /** The permanent-instructions file inside it (matches the directory's convention). */
  instructions: string
  /** True when the directory already existed — integrate with it, don't recreate. */
  existed: boolean
}

/** True when `rel` is a directory inside the active project root. */
function isDir(rel: string): boolean {
  try {
    return statSync(join(contextManager.getRoot(), rel)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The memory directory for the active project: an existing `.claude/` first (so a
 * repo already carrying agent docs keeps them in place), then an existing
 * `.sylor/`, and `.sylor/` as the default when neither is present. The instruction
 * doc is named for its directory — `.claude/CLAUDE.md` or `.sylor/SYLOR.md` — both
 * of which `instructions.ts` already loads as standing guidance.
 */
export function resolveMemoryHome(): MemoryHome {
  for (const dir of MEMORY_DIRS) {
    if (isDir(dir)) return { dir, instructions: instructionFileFor(dir), existed: true }
  }
  return { dir: '.sylor', instructions: instructionFileFor('.sylor'), existed: false }
}

/** The instruction-doc filename that belongs to a memory directory. */
function instructionFileFor(dir: MemoryDirName): string {
  return dir === '.claude' ? 'CLAUDE.md' : 'SYLOR.md'
}

// ── Document registry ────────────────────────────────────────────────────────

/** The documents that make up project memory. */
export type MemoryDocId =
  | 'instructions'
  | 'project'
  | 'architecture'
  | 'filemap'
  | 'conventions'
  | 'decisions'
  | 'state'
  | 'tasks'
  | 'audit'
  | 'followups'

/** One memory document: how to name it, budget it, and scaffold it. */
interface MemoryDocSpec {
  id: MemoryDocId
  /** Filename inside the memory dir, or null when it varies by home (instructions). */
  file: string | null
  /** One-line note on what the doc answers, used in the preamble header. */
  purpose: string
  /** Char budget when injected; the doc is clipped to this. */
  budget: number
  /** Clip from the END (keep the newest) rather than the start. */
  tail?: boolean
  /**
   * Trim rank when the whole preamble overruns {@link MAX_MEMORY_CHARS} — the
   * highest number is dropped first, so "where the work stands" always survives.
   */
  rank: number
  /** False for docs already injected elsewhere (instructions → `instructions.ts`). */
  inject: boolean
  /** The starting skeleton written when the doc is absent; omit to never scaffold. */
  template?: (project: string) => string
}

// ── Scaffolds ────────────────────────────────────────────────────────────────
// Deliberately skeletal: headings the agent fills in as it learns, so the doc is
// already there to be maintained. Each carries SCAFFOLD_MARKER until it is written,
// which keeps unfilled placeholders out of the injected preamble.

/** Renders a scaffold: the marker, a title, a one-line brief, then the headings. */
function scaffold(title: string, brief: string, headings: string[]): string {
  return `${SCAFFOLD_MARKER}\n# ${title}\n\n${brief}\n\n${headings.map((h) => `## ${h}\n`).join('\n')}`
}

const INSTRUCTIONS_TEMPLATE = (project: string): string =>
  `${SCAFFOLD_MARKER}
# ${project} — agent instructions

Permanent instructions for anyone working in this repository, human or agent. Keep it
short enough to re-read at the start of every session.

## Purpose

## Stack

## Architecture rules

## Coding conventions

## Design conventions

## Commands

- install:
- dev:
- build:
- test:

## Constraints

_What must not break._
`

const PROJECT_TEMPLATE = (project: string): string =>
  scaffold(
    `${project} — specification`,
    'The stable source of truth for WHAT is being built. Fill each section as it becomes known.',
    [
      'Objective',
      'Target users',
      'Product requirements',
      'Core features',
      'Pages and screens',
      'Key user flows',
      'Technical requirements',
      'Design goals',
      'Non-functional requirements',
      'Assumptions',
      'Constraints',
      'Success criteria'
    ]
  )

const ARCHITECTURE_TEMPLATE = (): string =>
  scaffold(
    'Architecture',
    'How the project is ACTUALLY built right now. Update this whenever the shape changes.',
    [
      'App structure',
      'Frontend',
      'Backend',
      'Data flow',
      'State management',
      'Routing',
      'API',
      'Authentication',
      'Services and integrations',
      'Component relationships',
      'Dependencies'
    ]
  )

const FILEMAP_TEMPLATE = (): string =>
  `${SCAFFOLD_MARKER}
# File map

Every important file and what it is RESPONSIBLE for. This is the answer to "what is this
file for?" — read this instead of opening the file. Update it whenever a file is created,
deleted, renamed, or changes responsibility.

Format:

\`\`\`
path/to/file.ts
Purpose: one line on what this file is responsible for.
\`\`\`
`

const CONVENTIONS_TEMPLATE = (): string =>
  scaffold('Conventions', 'The patterns new code must match. Read before writing anything new.', [
    'Naming',
    'File and folder layout',
    'Components',
    'Styling',
    'State',
    'Data fetching',
    'Error handling',
    'Testing',
    'Commits'
  ])

const DECISIONS_TEMPLATE = (): string =>
  `${SCAFFOLD_MARKER}
# Decision log

One entry per decision that affects the architecture, the stack, or the product. Append
new entries at the END, newest last. Never rewrite history.

Format:

\`\`\`
## <date> — <the decision>
- Reason:
- Alternatives considered:
- Consequence:
\`\`\`
`

const STATE_TEMPLATE = (): string =>
  `${SCAFFOLD_MARKER}
# Current state

The single place that says where the work stands. Update it at the end of every phase and
whenever the build or preview health changes.

Phase: —
Status: not started
Build: UNKNOWN
Preview: UNKNOWN
Complexity: —

## Completed

## In progress

## Blocked

## Next action

## Last successful action

## Recently changed files

## Verified

## Remaining

## Known issues

## Context that must survive a reset
`

const TASKS_TEMPLATE = (): string =>
  `${SCAFFOLD_MARKER}
# Tasks

Status keys: \`[ ]\` pending · \`[x]\` complete · \`[~]\` in progress · \`[!]\` blocked.
Organised by phase, and kept in sync with STATE.md and the active plan.

## Phase 1 — Foundation

- [ ] Define the phase's tasks here.
`

/**
 * The registry, in the order the docs are rendered into the prompt. `rank` is the
 * trim order (highest dropped first) — so STATE/TASKS, the two docs that say where
 * the work stands, are the last things to be squeezed out of a crowded prompt.
 */
const DOCS: readonly MemoryDocSpec[] = [
  {
    id: 'instructions',
    file: null,
    purpose: 'permanent project instructions',
    budget: 2_000,
    rank: 0,
    // Already loaded as standing guidance by `instructions.ts` — scaffolded here,
    // injected there, so it is never sent twice.
    inject: false,
    template: INSTRUCTIONS_TEMPLATE
  },
  {
    id: 'project',
    file: 'PROJECT.md',
    purpose: 'what is being built, and for whom',
    budget: 1_800,
    rank: 4,
    inject: true,
    template: PROJECT_TEMPLATE
  },
  {
    id: 'architecture',
    file: 'ARCHITECTURE.md',
    purpose: 'how it is built',
    budget: 1_800,
    rank: 5,
    inject: true,
    template: ARCHITECTURE_TEMPLATE
  },
  {
    id: 'filemap',
    file: 'FILEMAP.md',
    purpose: 'what each important file is responsible for',
    budget: 2_600,
    rank: 3,
    inject: true,
    template: FILEMAP_TEMPLATE
  },
  {
    id: 'conventions',
    file: 'CONVENTIONS.md',
    purpose: 'the patterns new code must match',
    budget: 1_200,
    rank: 6,
    inject: true,
    template: CONVENTIONS_TEMPLATE
  },
  {
    id: 'decisions',
    file: 'DECISIONS.md',
    purpose: 'decisions already made, and why',
    budget: 1_000,
    // Append-only log: keep the most recent entries, drop the oldest.
    tail: true,
    rank: 7,
    inject: true,
    template: DECISIONS_TEMPLATE
  },
  {
    id: 'state',
    file: 'STATE.md',
    purpose: 'where the work stands right now',
    budget: 1_400,
    rank: 1,
    inject: true,
    template: STATE_TEMPLATE
  },
  {
    id: 'tasks',
    file: 'TASKS.md',
    purpose: 'the phase checklist',
    budget: 1_600,
    rank: 2,
    inject: true,
    template: TASKS_TEMPLATE
  },
  {
    id: 'audit',
    file: 'AUDIT.md',
    purpose: 'the final project audit',
    budget: 1_200,
    rank: 8,
    // Written once, when the roadmap finishes (§35). Never scaffolded — an empty
    // audit would read as "audited, nothing found" — and not injected, because a
    // report of a finished project is not context for the work that produced it.
    inject: false
  },
  {
    id: 'followups',
    file: 'FOLLOWUPS.md',
    purpose: 'out-of-scope work spotted and deliberately deferred',
    budget: 1_000,
    // Append-only log: keep the most recent entries, drop the oldest.
    tail: true,
    rank: 9,
    // Deliberately NOT injected. Feeding a list of unrelated open issues into every
    // prompt would invite exactly the scope creep the flag exists to prevent — the
    // agent would start "helpfully" fixing them mid-task. It is a record for the
    // USER to pick from, so it is read when they act on it, not on every turn.
    // Never scaffolded either: an empty file would read as "checked, nothing found".
    inject: false
  }
]

// ── Paths and reads ──────────────────────────────────────────────────────────

/** The project-relative path of a memory doc under `home`. */
function docPath(home: MemoryHome, spec: MemoryDocSpec): string {
  return `${home.dir}/${spec.file ?? home.instructions}`
}

/** The project-relative path of a memory doc, resolved against the active home. */
export function memoryDocPath(id: MemoryDocId): string {
  const home = resolveMemoryHome()
  const spec = DOCS.find((d) => d.id === id)
  return spec ? docPath(home, spec) : `${home.dir}/${id}.md`
}

/** Reads a memory doc, trimmed; null when it is missing, unreadable, or empty. */
function readDoc(rel: string): string | null {
  try {
    return readProjectFile(rel).trim() || null
  } catch {
    return null // missing, unreadable, or outside the sandbox
  }
}

/** Reads a memory doc by id (null when absent/empty) — the public read seam. */
export function readMemoryDoc(id: MemoryDocId): string | null {
  return readDoc(memoryDocPath(id))
}

/** True when a doc is still the untouched scaffold Sylor wrote. */
export function isPlaceholder(content: string): boolean {
  return content.includes(SCAFFOLD_MARKER)
}

/**
 * The active plan file: `<memory dir>/plan.md` when it exists, else the historical
 * project-root `plan.md`. Returns the root path when neither is present, so a
 * caller writing a plan lands somewhere sane. Keeps the engine's existing
 * root-level plan working while the memory-dir location becomes canonical.
 */
export function activePlanPath(): string {
  const inMemoryDir = `${resolveMemoryHome().dir}/${PLAN_FILE}`
  return readDoc(inMemoryDir) !== null ? inMemoryDir : PLAN_FILE
}

// ── Scaffolding ──────────────────────────────────────────────────────────────

/**
 * Creates any memory document that doesn't exist yet, as a skeleton the agent then
 * fills in. **Never overwrites**: a doc that is already on disk — whether Sylor
 * wrote it or another tool did — is left exactly as it is, which is what makes
 * adopting an existing `.claude/` safe. Returns the project-relative paths it
 * created (empty when everything was already there). Best-effort per doc: a write
 * failure is skipped, never thrown.
 */
export function scaffoldMemory(): string[] {
  const home = resolveMemoryHome()
  const project = basename(contextManager.getRoot()) || 'project'
  const created: string[] = []
  for (const spec of DOCS) {
    if (!spec.template) continue
    const rel = docPath(home, spec)
    if (readDoc(rel) !== null) continue
    try {
      writeProjectFile(rel, spec.template(project))
      created.push(rel)
    } catch {
      // Read-only checkout, permission error — memory is an optimization, not a gate.
    }
  }
  return created
}

// ── Injection ────────────────────────────────────────────────────────────────

/** Clips `text` to `budget` chars, from the end when `tail` (keep the newest). */
function clip(text: string, budget: number, tail?: boolean): string {
  if (text.length <= budget) return text
  return tail
    ? `… (earlier entries omitted)\n${text.slice(text.length - budget)}`
    : `${text.slice(0, budget)}\n… (truncated)`
}

/**
 * The header that turns these documents from decoration into behaviour: it tells
 * the model to TRUST memory instead of rediscovering the project, names the one
 * question FILEMAP.md already answers, and states the maintenance contract.
 */
function memoryHeader(dir: string): string {
  return `## Project memory (${dir}/)

The project's persisted understanding, written by earlier work on it. Trust it and USE it
instead of rediscovering the project:
- FILEMAP.md already says what each file is responsible for — never open a file just to
  find out what it is for.
- STATE.md and TASKS.md already say where the work stands — never re-audit to find out.
- PROJECT.md, ARCHITECTURE.md, CONVENTIONS.md and DECISIONS.md already hold the spec, the
  shape, the patterns and the calls already made — don't re-derive them.
- Before every inspection ask: "is this already in memory?" If it is, don't read the file.
  Inspect only what you must change, the smallest scope a specific error implicates, or
  something memory is missing or contradicts.

Keep it current — stale memory is worse than none:
- ${dir}/STATE.md and ${dir}/TASKS.md after every meaningful step.
- ${dir}/FILEMAP.md whenever a file is created, deleted, renamed, or repurposed.
- ${dir}/ARCHITECTURE.md when the architecture changes.
- ${dir}/DECISIONS.md when you make a call worth remembering (with the reason).
Update them with edit_file (or write_file for a new one) like any other file.`
}

/** A document resolved for injection: its spec plus the clipped body. */
interface LoadedDoc {
  spec: MemoryDocSpec
  body: string
}

/**
 * Builds the project-memory section of the system prompt: the discipline header,
 * every written document (clipped to its own budget), and a one-line roster of the
 * documents still unwritten so the model knows what to fill in.
 *
 * Returns '' when no memory document exists at all — a project Sylor has never
 * scaffolded adds nothing to the prompt. When the sections overrun
 * {@link MAX_MEMORY_CHARS} the lowest-ranked ones are dropped whole, so the prompt
 * stays bounded and STATE/TASKS survive. Never throws.
 */
export function buildMemoryPreamble(): string {
  const home = resolveMemoryHome()
  const loaded: LoadedDoc[] = []
  const unwritten: string[] = []
  let anyDoc = false

  for (const spec of DOCS) {
    const rel = docPath(home, spec)
    const raw = readDoc(rel)
    if (raw !== null) anyDoc = true
    if (!spec.inject) continue
    if (raw === null || isPlaceholder(raw)) {
      unwritten.push(spec.file ?? home.instructions)
      continue
    }
    loaded.push({ spec, body: clip(raw, spec.budget, spec.tail) })
  }

  if (!anyDoc) return ''

  // Drop whole low-rank sections until the budget fits (highest rank goes first).
  let total = loaded.reduce((sum, d) => sum + d.body.length, 0)
  while (total > MAX_MEMORY_CHARS && loaded.length > 1) {
    let worst = 0
    for (let i = 1; i < loaded.length; i++) {
      if (loaded[i].spec.rank > loaded[worst].spec.rank) worst = i
    }
    total -= loaded[worst].body.length
    loaded.splice(worst, 1)
  }

  const parts = [memoryHeader(home.dir)]
  for (const { spec, body } of loaded) {
    parts.push(`### ${spec.file ?? home.instructions} — ${spec.purpose}\n${body}`)
  }
  if (unwritten.length > 0) {
    parts.push(
      `### Not written yet\n${unwritten.join(', ')} — fill these in under ${home.dir}/ as you learn the answers.`
    )
  }
  return parts.join('\n\n')
}
