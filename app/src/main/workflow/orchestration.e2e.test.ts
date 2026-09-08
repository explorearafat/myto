/**
 * End-to-end orchestration tests — the proof that the hierarchy actually RUNS.
 *
 * `orchestrator.test.ts` unit-tests the state machine with faked seams. This file
 * does the opposite: it drives the REAL `runWorkflow` entry point with only the
 * outermost collaborators mocked (provider, disk, terminal, MCP, skills, DB), so
 * every layer in between executes for real —
 *
 *   runWorkflow → intent → orchestrator → complexity router → planner →
 *   TaskGraph + scheduler → runSubagent → buildSubagentSystem (capability-scoped)
 *   → runAgentLoop → ToolStreamParser → permission gate → capability gate →
 *   writeProjectFile / runCommand → SharedContext → VERIFY → REVIEW → RESPOND
 *
 * The assertions are deliberately about *observable side effects of execution*
 * (which files landed on the virtual disk, which command ran, what text the
 * downstream specialist's prompt actually contained, which agents were started)
 * rather than about status strings — a implementation that merely printed the
 * stage names would fail every test here.
 *
 * It lives in its own file so the 300+ assertions in `engine.test.ts` are
 * untouched: this suite needs a shared (scriptable) `getCompletion` and a
 * path-aware `readProjectFile`, which that file's mocks deliberately don't have.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '@main/providers'
import type { DiagnosticsReport } from '@main/diagnostics/run'
import type {
  ChatMessage,
  CompletionChunk,
  IntentAnalysis,
  SkillInfo,
  TaskNode,
  WorkflowEvent,
  WorkflowRunRequest
} from '@shared/types'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

// ---- Mocks: only the outermost collaborators ---------------------------------

// One shared provider pair. `streamCompletion` drives every agent loop (lead and
// specialists); `getCompletion` is the planner's single call plus the reviewer's
// verdict — hoisted so a test can script them in order.
const { streamCompletion, getCompletion } = vi.hoisted(() => ({
  streamCompletion: vi.fn(),
  getCompletion: vi.fn()
}))
vi.mock('@main/providers', () => ({
  providerFromSettings: (): Provider =>
    ({
      streamCompletion,
      getCompletion,
      listModels: vi.fn(),
      testConnection: vi.fn()
    }) as unknown as Provider
}))

const settings = { ...DEFAULT_PROVIDER_SETTINGS, modelId: 'test-model', modelName: 'Test Model' }
vi.mock('@main/settings', () => ({
  getSettings: () => settings,
  isSkillEnabled: () => true,
  // Full-PC access off: the engine calls this directly on every gated op, so the
  // mock must export it (default safe posture) or the whole run throws.
  fullAccessEnabled: () => false,
  // Auto-send off too — same direct-call reason (browse send gate).
  autoSendEnabled: () => false
}))

// The root override used by worktree isolation. `runWithRoot` is a pass-through
// here (the flat virtualFs ignores root, so real write-confinement isn't
// observable in this suite — only the WIRING is), and it records the root it was
// handed so the isolation test can assert a subagent ran under the worktree dir.
const runWithRoot = vi.fn(<T>(_root: string, fn: () => T): T => fn())
vi.mock('@main/context/manager', () => ({
  contextManager: {
    listFiles: () => ['package.json', 'src/index.ts'],
    buildOverview: () => 'PROJECT OVERVIEW',
    getRoot: () => '/test',
    // The checkpoint trigger only fires when these two agree, i.e. when the op is
    // against the user's real project rather than a subagent's worktree. Equal here
    // (runWithRoot is a pass-through), so the lead's writes reach that branch and the
    // stub below stands in for the real snapshot.
    getProjectRoot: () => '/test',
    setRoot: vi.fn(),
    runWithRoot: (root: string, fn: () => unknown) => runWithRoot(root, fn),
    // The §3 audit reads the manifest through the manager; everything else it needs
    // it derives from the paths above.
    readFile: (rel: string) => virtualFs.get(rel) ?? null,
    fileStamp: () => null,
    noteRead: () => {},
    noteWrite: () => {},
    indexSummaryFor: () => undefined,
    flushIndex: () => {}
  }
}))

// Checkpoints are stubbed: the real one spawns git and would write into '/test' on
// the machine running the suite. `created: false` keeps this suite's event stream
// exactly as it was — the orchestration assertions count and order events, and a
// snapshot row is not what they are about.
vi.mock('@main/checkpoint/checkpoints', () => ({
  createCheckpoint: async () => null
}))

// Worktree isolation seam. Default: `createWorktree` returns null (no git / not a
// repo) so a normal spawn runs in the shared root — the common case. A test that
// wants isolation scripts `createWorktree` to hand back a fake handle, then
// asserts the subagent loop ran inside `runWithRoot(handle.dir, …)` and that
// `finalizeWorktree` was called to sync + tear down.
const { createWorktree, finalizeWorktree } = vi.hoisted(() => ({
  createWorktree: vi.fn<(agentId: string, signal?: AbortSignal) => Promise<unknown>>(
    async () => null
  ),
  finalizeWorktree: vi.fn<(handle: unknown, signal?: AbortSignal) => Promise<string>>(
    async () => ''
  )
}))
vi.mock('@main/workflow/worktree', () => ({
  createWorktree: (agentId: string, signal?: AbortSignal) => createWorktree(agentId, signal),
  finalizeWorktree: (handle: unknown, signal?: AbortSignal) => finalizeWorktree(handle, signal)
}))

const classifyIntent = vi.fn<() => Promise<IntentAnalysis>>()
vi.mock('@main/workflow/intent', () => ({ classifyIntent: () => classifyIntent() }))

/**
 * A virtual project on disk. Writes land here and reads come back out of it, so
 * the engine's own `readProjectFile` consumers — `detectVerifyCommand()` (which
 * needs a real package.json to pick `npm run typecheck`) and `readPlanMd()`
 * (requirement E: a specialist's prompt is seeded with the living plan) — see
 * exactly what the team just produced. A miss throws, like the real fs.
 */
const virtualFs = new Map<string, string>()
const PACKAGE_JSON = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } })

const writeProjectFile = vi.fn((path: string, content: string) => {
  virtualFs.set(path, content)
})
const readProjectFile = vi.fn((path: string): string => {
  const hit = virtualFs.get(path)
  if (hit === undefined) throw new Error(`ENOENT: ${path}`)
  return hit
})
vi.mock('@main/fs/operations', () => ({
  proposeWrite: (path: string, content: string) => ({
    exists: virtualFs.has(path),
    oldContent: virtualFs.get(path) ?? '',
    newContent: content
  }),
  writeProjectFile: (path: string, content: string) => writeProjectFile(path, content),
  readProjectFile: (path: string) => readProjectFile(path)
}))

const runCommand = vi.fn<
  (command: string) => Promise<{ exitCode: number | null; output: string; truncated: boolean }>
>(async () => ({ exitCode: 0, output: 'no errors', truncated: false }))
vi.mock('@main/terminal/runner', () => ({
  runCommand: (command: string) => runCommand(command)
}))

/**
 * The diagnostics feed. Default: NOTHING is installed, so VERIFY takes the plain
 * `npm run …` route every other test in this file asserts. A test that wants the
 * structured route flips {@link checkersAvailable} and scripts {@link diagnostics}.
 */
let checkersAvailable = { typescript: false, eslint: false }
const CLEAN_REPORT: DiagnosticsReport = {
  ok: true,
  entries: [],
  errors: 0,
  warnings: 0,
  truncated: false,
  ran: ['typescript (tsconfig.json)', 'eslint'],
  skipped: [],
  output: 'CHECKED: typescript (tsconfig.json), eslint\n\nNo problems reported.',
  summary: 'clean'
}
const diagnostics = vi.fn<(request: { scope: string }) => Promise<DiagnosticsReport>>(
  async () => CLEAN_REPORT
)
vi.mock('@main/diagnostics/run', () => ({
  availableCheckers: () => checkersAvailable,
  scopeFor: (a: { typescript: boolean; eslint: boolean }) =>
    a.typescript && a.eslint ? 'all' : a.typescript ? 'typescript' : a.eslint ? 'eslint' : null,
  realDiagnosticsDeps: () => ({}),
  runDiagnostics: (request: { scope: string }) => diagnostics(request)
}))

vi.mock('@main/mcp/manager', () => ({
  mcpManager: {
    ensureConnected: vi.fn(async () => {}),
    getTools: () => [],
    listServers: () => [],
    callTool: vi.fn(async () => ({ ok: true, output: 'mcp-ok', truncated: false }))
  }
}))

vi.mock('@main/skills/registry', () => ({ skillsRegistry: { getSkills: () => [] } }))
vi.mock('@main/skills/catalog', () => ({ mergeSkillCatalog: (disk: SkillInfo[]) => disk }))

vi.mock('@main/db/projects', () => ({
  getProject: () => null,
  listProjectKnowledge: () => [],
  appendProjectMemory: vi.fn(() => '')
}))

const { runWorkflow, cancelAgent } = await import('@main/workflow/engine')

// ---- Fixtures ---------------------------------------------------------------

/**
 * A request that is genuinely broad — three distinct domains and three
 * deliverables — so the scripted router below sizes it `complex` and the staged
 * hierarchy actually assembles a team. The offline heuristic agrees, which is why
 * this fixture is safe to use in the abort tests, where no verdict comes back.
 */
const COMPLEX_REQUEST = 'add a login API endpoint and a React component and a database migration'

const planJson = (tasks: unknown[]): string => JSON.stringify({ tasks })
const verdict = (v: 'pass' | 'fail', reason = '', targetRole = 'builder'): string =>
  JSON.stringify({ verdict: v, reason, targetRole })

/**
 * A PROJECT.md the SPEC stage will actually accept. `expandSpec` refuses a thin or
 * off-format answer — a bad specification would be re-read as truth on every later
 * turn — so the fixture carries every mandated heading with a real body.
 */
const SPEC_DOC = [
  '# Login — specification',
  ...[
    'Objective',
    'Target users',
    'Product requirements',
    'Major features',
    'Pages and screens',
    'User flows',
    'Information architecture',
    'Component architecture',
    'Data requirements',
    'Backend, API and authentication',
    'Responsive and accessibility',
    'Error, loading and empty states',
    'Security, performance and SEO',
    'Visual and interaction direction',
    'Testing and deployment',
    'Edge cases',
    'Dependencies and technical risks',
    'Assumptions',
    'Constraints',
    'Completion criteria'
  ].map((h) => `## ${h}\n\nEmail-and-password login for returning customers.`)
].join('\n\n')

/** The judgement sections the plan-writing call returns, keyed by section id. */
const PLAN_SECTIONS = JSON.stringify({
  state: 'A bare project: package.json and src/index.ts, nothing else.',
  requirements: 'The endpoint authenticates a user; the form submits to it.',
  protect: 'package.json — the toolchain is already correct.',
  implStrategy: 'Endpoint first, then the form that calls it.'
})

/** A section long enough for the audit to accept it as real (§3). */
const auditSection = (what: string): string =>
  `## ${what}\n\n${`Electron main plus a React renderer; ${what} lives in src/index.ts. `.repeat(3)}`

/** The analyst's answer: ARCHITECTURE.md and CONVENTIONS.md, authored in one call. */
const AUDIT_DOCS = JSON.stringify({
  architecture: auditSection('Structure'),
  conventions: auditSection('Naming')
})

/** The closing report, for the turn that finishes the last phase of a roadmap. */
const FINAL_AUDIT_DOC = [
  '# Final project audit',
  '',
  '## What was built',
  'Login, end to end, across the phases recorded in the archive.',
  '',
  '## Against the completion criteria',
  'Every criterion in the specification is met by a file that exists.',
  '',
  '## Verification status',
  '`npm run typecheck` passed on the final phase.',
  '',
  '## Known gaps',
  'None recorded.',
  '',
  '## Recommended next steps',
  'Ship it, then watch the logs.'
].join('\n')

/** The coordination calls, identified by the marker in each one's system prompt. */
const KINDS: readonly (readonly [marker: string, kind: string])[] = [
  ['complexity router', 'router'],
  ['PROJECT ANALYST', 'audit'],
  ['AUDITOR', 'final-audit'],
  ['PRODUCT ARCHITECT', 'spec'],
  ['TECHNICAL ARCHITECT', 'phase-plan'],
  ['PLANNER', 'plan'],
  ['REVIEWER', 'review'],
  ['compacting the middle', 'compact']
]

const kindOf = (messages: ChatMessage[]): string => {
  const system = String(messages[0]?.content ?? '')
  return KINDS.find(([marker]) => system.includes(marker))?.[1] ?? 'unknown'
}

/**
 * Scripts the non-streaming coordination calls by KIND rather than by position.
 *
 * The staged workflow spends calls either side of the two the hierarchy always
 * spends — a once-per-project specification and a once-per-phase plan document —
 * and a positional queue would silently start feeding the reviewer a plan the moment
 * that budget changed. Verdicts stay a queue, because a rework round genuinely needs
 * "fail, then pass"; the last one repeats so an extra review can't run dry.
 */
function coordination(opts: { plan?: string; verdicts?: string[] } = {}): void {
  const verdicts = [...(opts.verdicts ?? [verdict('pass')])]
  getCompletion.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
    switch (kindOf(messages)) {
      case 'router':
        // The model sizes every work turn (`classifyComplexity`), so it is part of
        // the budget rather than a detail. It stands in for a real one here by
        // agreeing with the fixtures: the three-domain request is a team's worth of
        // work, a typo is not.
        return JSON.stringify({
          reason: 'e2e',
          complexity: String(messages[1]?.content ?? '').includes(COMPLEX_REQUEST)
            ? 'complex'
            : 'simple'
        })
      case 'audit':
        return AUDIT_DOCS
      case 'final-audit':
        return FINAL_AUDIT_DOC
      case 'spec':
        return SPEC_DOC
      case 'phase-plan':
        return PLAN_SECTIONS
      case 'plan':
        return opts.plan ?? planJson([])
      case 'review':
        return verdicts.length > 1 ? (verdicts.shift() as string) : verdicts[0]
      case 'compact':
        return 'Earlier steps: the specialist wrote its file and reported.'
      default:
        throw new Error(`unscripted coordination call: ${String(messages[0]?.content).slice(0, 60)}`)
    }
  })
}

/**
 * Which coordination calls were spent, in order — the call budget, made visible.
 *
 * Mid-run history compaction is excluded: it is context management rather than
 * coordination, and it fires only when a particular loop's history happens to grow
 * past the fold boundary, so it is not a stable budget to assert on.
 */
const coordinationCalls = (): string[] =>
  getCompletion.mock.calls.map((c) => kindOf(c[1] as ChatMessage[])).filter((k) => k !== 'compact')

/** The user message of the `nth` coordination call of one kind. */
function coordinationPrompt(kind: string, nth = 0): string {
  const hit = getCompletion.mock.calls.filter((c) => kindOf(c[1] as ChatMessage[]) === kind)[nth]
  if (!hit) throw new Error(`no ${kind} call #${nth} was made`)
  return String((hit[1] as ChatMessage[])[1].content)
}

/** Every version of the active plan that was written, in order. */
const planWrites = (): string[] =>
  writeProjectFile.mock.calls.filter((c) => c[0] === 'plan.md').map((c) => c[1] as string)

/** A `sylor-tool` write block exactly as a model would stream it. */
const writeBlock = (path: string, content: string): string =>
  '```sylor-tool\n' + JSON.stringify({ tool: 'write_file', path, content }) + '\n```\n'

/**
 * A `sylor-tool` `spawn_agent` block, with the optional execution modifiers a
 * lead can attach: `background: true` (non-blocking) and `isolation: 'worktree'`
 * (a private git worktree). Streamed exactly as a model would emit it.
 */
const spawnBlock = (spec: {
  role: string
  task: string
  background?: boolean
  isolation?: 'worktree'
}): string => '```sylor-tool\n' + JSON.stringify({ tool: 'spawn_agent', ...spec }) + '\n```\n'

function req(runId: string, overrides: Partial<WorkflowRunRequest> = {}): WorkflowRunRequest {
  return {
    runId,
    messages: [{ role: 'user', content: COMPLEX_REQUEST }],
    // The only mode that auto-approves commands, so the VERIFY stage can run
    // unattended. Writes and the capability gate behave identically in any mode.
    permissionMode: 'autonomous',
    mode: 'code',
    ...overrides
  }
}

const noTerminal = (): void => {}

function collector(): { events: WorkflowEvent[]; emit: (e: WorkflowEvent) => void } {
  const events: WorkflowEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const textOf = (events: WorkflowEvent[]): string =>
  events
    .filter((e) => e.type === 'delta')
    .map((e) => (e as { text: string }).text)
    .join('')

const stagesOf = (events: WorkflowEvent[]): string[] =>
  events.filter((e) => e.type === 'status').map((e) => (e as { stage: string }).stage)

const statusMessages = (events: WorkflowEvent[]): string[] =>
  events.filter((e) => e.type === 'status').map((e) => (e as { message: string }).message)

const messageTypes = (events: WorkflowEvent[]): string[] =>
  events
    .filter((e) => e.type === 'agent-message')
    .map((e) => (e as { message: { type: string } }).message.type)

const agentStarts = (events: WorkflowEvent[]): { agentId: string; role: string; task: string }[] =>
  events.filter((e) => e.type === 'agent-start') as unknown as {
    agentId: string
    role: string
    task: string
  }[]

const agentEnds = (events: WorkflowEvent[]): { role: string; report: string; ok: boolean }[] =>
  events.filter((e) => e.type === 'agent-end') as unknown as {
    role: string
    report: string
    ok: boolean
  }[]

/** The system prompt of the agent loop whose brief matched `needle`. */
function systemPromptFor(needle: string): string {
  const call = streamCompletion.mock.calls.find((c) => {
    const messages = c[1] as ChatMessage[]
    return typeof messages[1]?.content === 'string' && messages[1].content.includes(needle)
  })
  if (!call) throw new Error(`no agent was briefed with "${needle}"`)
  return (call[1] as ChatMessage[])[0].content
}

/**
 * Paths the AGENTS wrote, in order — excluding the two infrastructure writes the
 * engine owns: plan.md (the orchestrator's) and the scaffolded project-memory docs.
 */
const filesWritten = (): string[] =>
  writeProjectFile.mock.calls
    .map((c) => c[0])
    .filter((p) => p !== 'plan.md' && !p.startsWith('.sylor/') && !p.startsWith('.claude/'))

/**
 * Scripts one specialist: on its FIRST step (a 2-message conversation) it emits
 * prose plus a `write_file` block; on every later step it emits a prose-only
 * report, which is what ends its loop. `route` maps a brief to the file that
 * specialist writes; a brief with no entry reports without writing.
 */
function specialists(route: Array<[needle: string, path: string, tag: string]>): void {
  streamCompletion.mockImplementation((async (_model, messages, onChunk) => {
    const brief = String((messages as ChatMessage[])[1]?.content ?? '')
    const hit = route.find(([needle]) => brief.includes(needle))
    const tag = hit ? hit[2] : 'GENERIC'
    if (!hit || (messages as ChatMessage[]).length > 2) {
      onChunk({ delta: `${tag}_REPORT: done.` } as Omit<CompletionChunk, 'streamId'>)
      return
    }
    onChunk({
      delta: `Working on it.\n\n` + writeBlock(hit[1], `// ${tag}\n`)
    } as Omit<CompletionChunk, 'streamId'>)
  }) as Provider['streamCompletion'])
}

beforeEach(() => {
  streamCompletion.mockReset()
  getCompletion.mockReset()
  classifyIntent.mockReset()
  writeProjectFile.mockClear()
  readProjectFile.mockClear()
  runCommand.mockClear()
  runWithRoot.mockClear()
  // Reset the worktree seam to its default: isolation unavailable → spawns run in
  // the shared root. Tests that want isolation override createWorktree per-case.
  createWorktree.mockReset()
  createWorktree.mockResolvedValue(null)
  finalizeWorktree.mockReset()
  finalizeWorktree.mockResolvedValue('')
  // Reset the diagnostics seam to its default: no checker installed → VERIFY runs
  // the project's `npm run …` scripts. Tests that want the structured route set
  // `checkersAvailable` and script `diagnostics` per-case.
  checkersAvailable = { typescript: false, eslint: false }
  diagnostics.mockReset()
  diagnostics.mockResolvedValue(CLEAN_REPORT)
  virtualFs.clear()
  virtualFs.set('package.json', PACKAGE_JSON)
  classifyIntent.mockResolvedValue({
    kind: 'edit',
    summary: 'Build the login feature',
    needsContext: true
  })
})

// ---- 1. The full hierarchy, executed for real --------------------------------

describe('E2E — a work turn runs the whole hierarchy', () => {
  it('plans, dispatches two real specialists in dependency order, verifies, reviews, responds', async () => {
    coordination({
      plan: planJson([
        {
          id: 't1',
          role: 'backend',
          description: 'build the login API endpoint',
          dependsOn: [],
          filesHint: ['src/api.ts']
        },
        {
          id: 't2',
          role: 'frontend',
          description: 'build the React login form',
          dependsOn: ['t1'],
          filesHint: ['src/ui.tsx']
        }
      ])
    })
    specialists([
      ['login API endpoint', 'src/api.ts', 'T1'],
      ['React login form', 'src/ui.tsx', 'T2']
    ])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-1'), emit, noTerminal)

    // ── PLAN: the router sized the team and the planner's graph was announced.
    const plan = events.find((e) => e.type === 'plan') as unknown as {
      complexity: string
      tasks: TaskNode[]
    }
    expect(plan.complexity).toBe('complex')
    expect(plan.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(plan.tasks.map((t) => t.role)).toEqual(['backend', 'frontend'])
    // Six provider completions were spent on coordination, once each: the router that
    // sizes the request, the one-time audit that records what the project IS, the spec
    // that turns a one-line request into PROJECT.md, the task graph, the phase plan,
    // and the verdict. Assignment, integration, the close and the roll-up are code.
    expect(coordinationCalls()).toEqual([
      'router',
      'audit',
      'spec',
      'plan',
      'phase-plan',
      'review'
    ])

    // ── ASSIGN: the phase plan was persisted through the normal write gate, scoped
    // to phase 1 of the nine-phase roadmap a complex build gets, with the REAL task
    // graph in it and the mandated sections present.
    const plans = planWrites()
    expect(plans[0]).toContain('# Plan — Phase 1 of 9: Discovery and foundation')
    expect(plans[0]).toContain('- [ ] **t1** (Backend Engineer) build the login API endpoint')
    expect(plans[0]).toContain('_(depends on: t1)_')
    expect(plans[0]).toContain('## Files that must NOT be modified')
    expect(plans[0]).toContain('package.json — the toolchain is already correct.')
    expect(plans[0]).toContain('`npm run typecheck` passes')

    // ── EXECUTE: two real subagents ran, in dependency order, each with its own
    // agentId — not one agent pretending to be a team.
    const starts = agentStarts(events)
    expect(starts.map((s) => s.role)).toEqual(['backend', 'frontend'])
    expect(new Set(starts.map((s) => s.agentId)).size).toBe(2)
    expect(starts[0].task).toContain('Likely files: src/api.ts')
    const ends = agentEnds(events)
    expect(ends.map((e) => e.ok)).toEqual([true, true])
    expect(ends[0].report).toContain('T1_REPORT')

    // Their writes actually landed on disk, in order.
    expect(filesWritten()).toEqual(['src/api.ts', 'src/ui.tsx'])
    expect(virtualFs.get('src/api.ts')).toBe('// T1\n')

    // ── CONTEXT SCOPING: t2's prompt was assembled from t1's real output — its
    // role directive, the living plan.md, and the upstream report.
    const t2System = systemPromptFor('React login form')
    expect(t2System).toContain('FRONTEND specialist')
    expect(t2System).toContain('## Current plan.md')
    expect(t2System).toContain('What the team has established so far')
    expect(t2System).toContain('T1_REPORT')
    // t1 ran first, so it could not have seen t2's work.
    expect(systemPromptFor('login API endpoint')).not.toContain('T2_REPORT')

    // ── VERIFY: the project's own check was detected from package.json and run
    // through the same gated pipeline.
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand.mock.calls[0][0]).toBe('npm run typecheck')

    // ── REVIEW: the reviewer was briefed with the integrated digest + the check.
    const reviewUser = coordinationPrompt('review')
    expect(reviewUser).toContain(COMPLEX_REQUEST)
    expect(reviewUser).toContain('npm run typecheck → passed')
    expect(reviewUser).toContain('T1_REPORT')

    // ── RESPOND: an honest roll-up of what actually happened.
    const text = textOf(events)
    expect(text).toContain(
      '✓ **Phase 1 of 9 — Discovery and foundation** complete — next: Design system and shell.'
    )

    // The turn answered before it did anything slow. Everything from here to the plan
    // is an internal document call — nothing streamed, minutes at high reasoning
    // effort — so this line is what stands between the user and an apparently hung app.
    // One plain sentence about the work: the scale label and the phase count that used
    // to lead it were ceremony, and the phases arrive with their objectives below.
    expect(text.startsWith('Planning this before I write anything')).toBe(true)

    // §3/§33 — the repo was read before anything was written, and said so in the
    // reply (not just flashed in the status row). Two files are in the fake tree, so
    // this is a real count, and it has to land ahead of the plan it informed.
    expect(text).toContain('**Scanned the project before writing anything** — 2 files mapped')
    expect(text).toContain('All set —')
    expect(text.indexOf('**Scanned the project')).toBeLessThan(text.indexOf('**Plan ready'))

    // §33 — the plan was read back BEFORE the work, not just filed as plan.md: how
    // many phases, what each is for, and what this phase breaks down into. A user
    // who never opens a file still learns the shape of what they asked for.
    expect(text).toContain('**Plan ready — 9 phases.**')
    expect(text).toContain('1. **Discovery and foundation** — ')
    expect(text).toContain('← starting here')
    expect(text).toContain('9. **Final polish and audit** — ')
    expect(text).toContain('This phase breaks down into 2 tasks:')
    expect(text.indexOf('**Plan ready — 9 phases.**')).toBeLessThan(
      text.indexOf('- ✓ **Backend Engineer**')
    )

    // …and it landed before the phase plan was authored, not after. That document is
    // the single longest call in the turn; read back afterwards, the user waits it out
    // with an empty reply under a frozen phase chip. The authoring call announces
    // itself on the status row, so the two are orderable within one event stream.
    const PLAN_LABEL = 'Writing the plan for phase 1 — Discovery and foundation…'
    const planReadyAt = events.findIndex(
      (e) => e.type === 'delta' && (e as { text: string }).text.includes('**Plan ready — 9 phases.**')
    )
    const authoringAt = events.findIndex(
      (e) => e.type === 'status' && (e as { message: string }).message === PLAN_LABEL
    )
    expect(planReadyAt).toBeGreaterThan(-1)
    expect(authoringAt).toBeGreaterThan(-1)
    expect(planReadyAt).toBeLessThan(authoringAt)

    // Every internal document call names itself on the status row while it runs, so a
    // long generation is distinguishable from a dead one.
    expect(statusMessages(events)).toEqual(
      expect.arrayContaining([
        'Reading the project — its architecture and conventions…',
        'Writing the project specification…',
        PLAN_LABEL
      ])
    )

    // The closing roll-up is a plain list of who did what — no "Team result (complex,
    // 2 tasks)" header labelling Sylor's own routing, and no `t1`/`t2`, which are
    // internal ids the user meets nowhere else in the app.
    expect(text).toContain('- ✓ **Backend Engineer** — build the login API endpoint')
    expect(text).toContain('- ✓ **Frontend Engineer** — build the React login form')
    expect(text).not.toContain('Team result')
    expect(text).not.toContain('**t1**')
    expect(text).toContain('Files changed: src/api.ts, src/ui.tsx')
    expect(text).toContain('Verified with `npm run typecheck`')
    expect(text).not.toContain('⚠')

    // The typed message protocol carried the coordination end to end.
    expect(messageTypes(events)).toEqual(
      expect.arrayContaining([
        'TASK_ASSIGNED',
        'STARTED',
        'TASK_COMPLETED',
        'FINDING',
        'REQUEST_REVIEW'
      ])
    )
    expect(stagesOf(events)).toEqual(
      expect.arrayContaining(['planning', 'generating', 'verifying'])
    )

    // The context meter reads the LEAD's conversation and nothing else. Two
    // specialists each ran their own agent loop with their own private history, so if
    // that gate ever came off there would be one `context` event per agent step and
    // the footer would flicker between unrelated conversations. Fewer events than
    // agent-loop steps is what proves the subagents stayed out of it.
    const contexts = events.filter((e) => e.type === 'context')
    expect(contexts.length).toBeGreaterThan(0)
    expect(contexts.length).toBeLessThan(streamCompletion.mock.calls.length)

    expect(events.at(-1)?.type).toBe('done')
  })

  it('leaves the project understood: spec, state, tasks, archive, checkpoint', async () => {
    // The anti-rediscovery half of the turn. A run that finishes a phase has to leave
    // the project's memory describing reality — otherwise the next turn re-audits,
    // which is the exact failure the staged workflow exists to kill.
    coordination({
      plan: planJson([
        { id: 't1', role: 'backend', description: 'build the login API endpoint', dependsOn: [] }
      ])
    })
    specialists([['login API endpoint', 'src/api.ts', 'T1']])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-memory'), emit, noTerminal)

    // §2 — the one-line request became a real specification, written once.
    expect(virtualFs.get('.sylor/PROJECT.md')).toContain('## Completion criteria')
    expect(coordinationPrompt('spec')).toContain(COMPLEX_REQUEST)
    // The assumptions it had to make were logged, because nobody was asked (§11).
    expect(virtualFs.get('.sylor/DECISIONS.md')).toContain(
      'Inferred the production specification from a short request'
    )

    // §9 — STATE.md answers "where does the work stand?" in machine-readable form,
    // including the complexity the roadmap is sized to, so it can't resize next turn.
    const state = virtualFs.get('.sylor/STATE.md') ?? ''
    expect(state).toContain('Phase: 2 — Design system and shell')
    expect(state).toContain('Status: in progress')
    expect(state).toContain('Build: PASSING')
    expect(state).toContain('Complexity: complex')
    // The scaffold marker is gone, so the doc is now injected rather than listed.
    expect(state).not.toContain('sylor:scaffold')

    // §10 — TASKS.md is the phase checklist: this phase ticked, the rest pending.
    const tasks = virtualFs.get('.sylor/TASKS.md') ?? ''
    expect(tasks).toContain('## Phase 1 — Discovery and foundation\n\n- [x]')
    expect(tasks).toContain('  - [x] **t1** build the login API endpoint')
    expect(tasks).toContain('## Phase 9 — Final polish and audit\n\n- [ ]')

    // §13/§36 — the finished plan was archived, and the live plan.md now describes
    // the NEXT phase rather than completed work.
    expect(virtualFs.get('.sylor/plans/phase-01-discovery-and-foundation.md')).toContain(
      '- [x] **t1**'
    )
    expect(virtualFs.get('plan.md')).toContain('# Plan — Phase 2 of 9: Design system and shell')
    expect(virtualFs.get('plan.md')).toContain('Just finished: build the login API endpoint.')
    expect(virtualFs.get('plan.md')).not.toContain('# Plan — Phase 1')

    // §27 — a checkpoint a fresh session resumes from, at a stable path.
    const checkpoint = virtualFs.get('.sylor/sessions/latest.md') ?? ''
    expect(checkpoint).toContain('Phase 1 of 9 — Discovery and foundation')
    expect(checkpoint).toContain('- t1: build the login API endpoint')
    expect(checkpoint).toContain('Start phase 2')
    expect(checkpoint).toContain('instead of re-auditing the project')

    // §3/§7 — the project was audited ONCE and the result persisted, so no later turn
    // opens a file to find out what it is for. The map is free (derived from the files
    // themselves); the architecture and conventions cost the single audit call.
    const filemap = virtualFs.get('.sylor/FILEMAP.md') ?? ''
    expect(filemap).toContain('- `src/index.ts` — Entry point for src.')
    expect(filemap).toContain('- `package.json` — Package manifest')
    expect(virtualFs.get('.sylor/ARCHITECTURE.md')).toContain('## Structure')
    expect(virtualFs.get('.sylor/CONVENTIONS.md')).toContain('## Naming')
    // The analyst judged the audited inventory, not a fresh exploration.
    expect(coordinationPrompt('audit')).toContain('- src/index.ts — Entry point for src.')

    // Closing the phase cost no extra model call: only the six coordination calls.
    expect(coordinationCalls()).toEqual([
      'router',
      'audit',
      'spec',
      'plan',
      'phase-plan',
      'review'
    ])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('resumes a project already in phase 3 without re-deriving its specification', async () => {
    // The second turn on a known project. STATE.md already says where the work
    // stands, so the run picks that phase up, spends NO spec call, and the plan it
    // writes is scoped to phase 3 — no re-audit, no roadmap resize.
    virtualFs.set('.sylor/PROJECT.md', SPEC_DOC)
    virtualFs.set('.sylor/ARCHITECTURE.md', '# Architecture\n\nElectron main plus a React renderer.\n')
    virtualFs.set('.sylor/CONVENTIONS.md', '# Conventions\n\nPascalCase components, colocated tests.\n')
    virtualFs.set(
      '.sylor/STATE.md',
      '# Current state\n\nPhase: 3 — Core pages\nStatus: in progress\nBuild: PASSING\nPreview: RUNNING\nComplexity: complex\n'
    )
    coordination({
      plan: planJson([
        { id: 't1', role: 'frontend', description: 'build the dashboard page', dependsOn: [] }
      ])
    })
    specialists([['dashboard page', 'src/Dashboard.tsx', 'T1']])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-resume'), emit, noTerminal)

    // §3/§36 — an audited project is never audited again, and a recorded spec is never
    // re-derived: past the sizing call, three calls, none of them about what the
    // project already is.
    expect(coordinationCalls()).toEqual(['router', 'plan', 'phase-plan', 'review'])
    expect(virtualFs.get('.sylor/ARCHITECTURE.md')).toContain('Electron main plus a React renderer.')
    // The planner was told which phase it is planning, and told not to stray.
    const planPrompt = coordinationPrompt('plan')
    expect(planPrompt).toContain('Phase 3 of 9 — Core pages')
    expect(planPrompt).toContain('Plan ONLY the work that belongs to this phase')
    // …and it split the work FROM the recorded specification rather than inferring the
    // product a second time from the request: the sections that decide how the work
    // divides — pages, data, the API boundary — are in the planner's own prompt.
    expect(planPrompt).toContain('### From the recorded specification')
    expect(planPrompt).toContain('#### Pages and screens')
    expect(planPrompt).toContain('#### Data requirements')
    expect(planPrompt).toContain('#### Backend, API and authentication')
    // The plan-writing call was handed recorded memory instead of a fresh audit.
    expect(coordinationPrompt('phase-plan')).toContain('## What the project already knows')
    expect(coordinationPrompt('phase-plan')).toContain('Specification (recorded)')

    expect(planWrites()[0]).toContain('# Plan — Phase 3 of 9: Core pages')
    expect(virtualFs.get('.sylor/STATE.md')).toContain('Phase: 4 — Data and backend')
    expect(textOf(events)).toContain('✓ **Phase 3 of 9 — Core pages** complete — next: Data and backend.')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('audits the whole project when the last phase of the roadmap closes', async () => {
    // §35 — the roadmap's final phase is the end of the build, so the last thing that
    // happens is a report on the whole project, written once and left on disk. There
    // is no tenth phase to plan and no next-phase plan to write.
    virtualFs.set('.sylor/PROJECT.md', SPEC_DOC)
    virtualFs.set('.sylor/ARCHITECTURE.md', '# Architecture\n\nOne module, one entry point.\n')
    virtualFs.set('.sylor/CONVENTIONS.md', '# Conventions\n\nColocated tests.\n')
    virtualFs.set(
      '.sylor/STATE.md',
      '# Current state\n\nPhase: 3 — Verification\nStatus: in progress\nBuild: PASSING\nPreview: RUNNING\nComplexity: simple\n'
    )
    coordination()
    streamCompletion.mockImplementation((async (_model, _messages, onChunk) => {
      if (!virtualFs.has('src/fix.ts')) {
        onChunk({
          delta: 'On it.\n\n' + writeBlock('src/fix.ts', 'const x = 1\n')
        } as Omit<CompletionChunk, 'streamId'>)
      } else {
        onChunk({ delta: 'Verified the last of it.' } as Omit<CompletionChunk, 'streamId'>)
      }
    }) as Provider['streamCompletion'])

    const { events, emit } = collector()
    await runWorkflow(
      req('e2e-final-audit', { messages: [{ role: 'user', content: 'fix the typo' }] }),
      emit,
      noTerminal
    )

    // The audit is the LAST coordination call, and it happens exactly once.
    expect(coordinationCalls().at(-1)).toBe('final-audit')
    expect(coordinationCalls().filter((k) => k === 'final-audit')).toHaveLength(1)
    expect(virtualFs.get('.sylor/AUDIT.md')).toContain('## Against the completion criteria')
    // It judged the record, including the criteria the specification set.
    expect(coordinationPrompt('final-audit')).toContain('all 3 phases')
    expect(coordinationPrompt('final-audit')).toContain('Completion criteria (from the specification)')

    // §34 — the checks passed, so the project may be called complete. No phase 4.
    const state = virtualFs.get('.sylor/STATE.md') ?? ''
    expect(state).toContain('Status: complete')
    expect(state).toContain('Phase: 3 — Verification')
    expect(planWrites().some((p) => p.includes('Phase 4'))).toBe(false)
    const statuses = events
      .filter((e) => e.type === 'status')
      .map((e) => (e as { message?: string }).message)
    expect(statuses).toContain('Final phase complete — wrote the project audit.')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('keeps a small edit on the single-agent path — no plan.md, no team roll-up', async () => {
    // A SIMPLE request on a project with no roadmap spends NOTHING on staging: no
    // specification, no phase plan, no phase number — a one-file fix is a request to
    // edit something, not to design a product. The reviewer's verdict is the only
    // completion. The node runs as the lead over the real conversation history: it
    // writes on its first step, then reports — a genuine edit, not a team.
    coordination()
    streamCompletion.mockImplementation((async (_model, _messages, onChunk) => {
      if (!virtualFs.has('src/fix.ts')) {
        onChunk({
          delta: 'On it.\n\n' + writeBlock('src/fix.ts', 'const x = 1\n')
        } as Omit<CompletionChunk, 'streamId'>)
      } else {
        onChunk({ delta: 'Fixed the typo.' } as Omit<CompletionChunk, 'streamId'>)
      }
    }) as Provider['streamCompletion'])

    const { events, emit } = collector()
    await runWorkflow(
      req('e2e-simple', { messages: [{ role: 'user', content: 'fix the typo' }] }),
      emit,
      noTerminal
    )

    expect(coordinationCalls()).toEqual(['router', 'review']) // sizing, then the review gate
    expect(virtualFs.has('plan.md')).toBe(false)
    expect(virtualFs.has('.sylor/sessions/latest.md')).toBe(false)
    expect(agentStarts(events)).toHaveLength(0) // the lead IS the node
    // The lead ran over the real history, exactly as before orchestration existed.
    // (`mock.calls[0][1]` is the engine's live `outbound` array, which the loop may
    // append feedback turns to, so we assert the request is present, not that it's last.)
    const lead = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(lead[0].role).toBe('system')
    expect(lead.some((m) => m.role === 'user' && m.content === 'fix the typo')).toBe(true)
    // The lead's own write landed — the single node did real work.
    expect(filesWritten()).toEqual(['src/fix.ts'])
    // A clean single-node turn ends on the agent's own prose: no team roll-up, and no
    // phase line — "phase 1 of 3" would be noise on a project with no roadmap.
    // (The roll-up is now unheaded, so the bullet itself is what must be absent.)
    const text = textOf(events)
    expect(text).toContain('Fixed the typo.')
    expect(text).not.toMatch(/^- [✓·✗] /m)
    expect(text).not.toContain('Phase 1 of 3')
    expect(events.at(-1)?.type).toBe('done')
  })
})

// ---- 2. Per-agent tool scoping, enforced at execution time -------------------

describe('E2E — capability scoping is enforced, not just described', () => {
  it('refuses a reviewer’s file write while the builder’s write lands', async () => {
    coordination({
      plan: planJson([
        { id: 't1', role: 'reviewer', description: 'audit the auth wiring', dependsOn: [] },
        { id: 't2', role: 'builder', description: 'apply the auth fix', dependsOn: ['t1'] }
      ])
    })
    specialists([
      ['audit the auth wiring', 'src/sneaky.ts', 'AUDIT'],
      ['apply the auth fix', 'src/legit.ts', 'FIX']
    ])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-cap'), emit, noTerminal)

    // The reviewer's write was refused by the capability gate — before any prompt.
    const refusals = events
      .filter((e) => e.type === 'tool-result')
      .map((e) => (e as { result: { ok?: boolean; error?: string } }).result)
      .filter((r) => r.ok === false)
    expect(refusals).toHaveLength(1)
    expect(refusals[0].error).toBe(
      "Not permitted for this agent's role (missing capability for write_file)."
    )

    // The refusal is real: nothing reached the disk from the reviewer, while the
    // builder — which holds `filesystem` — wrote normally.
    expect(virtualFs.has('src/sneaky.ts')).toBe(false)
    expect(virtualFs.get('src/legit.ts')).toBe('// FIX\n')
    expect(filesWritten()).toEqual(['src/legit.ts'])

    // And the refusal was fed back to the reviewer instead of aborting the run.
    expect(agentEnds(events).map((e) => e.ok)).toEqual([true, true])
    expect(events.at(-1)?.type).toBe('done')
  })
})

// ---- 3. The review gate really routes rework back into execution -------------

describe('E2E — a failing review dispatches real rework', () => {
  it('re-runs only the reviewer’s target role, then passes', async () => {
    coordination({
      plan: planJson([
        {
          id: 't1',
          role: 'backend',
          description: 'build the login API endpoint',
          dependsOn: [],
          filesHint: ['src/api.ts']
        },
        {
          id: 't2',
          role: 'frontend',
          description: 'build the React login form',
          dependsOn: ['t1'],
          filesHint: ['src/ui.tsx']
        }
      ]),
      verdicts: [verdict('fail', 'the login form never calls the endpoint', 'frontend'), verdict('pass')]
    })
    specialists([
      ['login API endpoint', 'src/api.ts', 'T1'],
      ['React login form', 'src/ui.tsx', 'T2']
    ])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-rework'), emit, noTerminal)

    // A THIRD agent ran — the rework node — with the reviewer's target role and
    // the rejection reason in its brief. Nothing else was re-dispatched.
    const starts = agentStarts(events)
    expect(starts.map((s) => s.role)).toEqual(['backend', 'frontend', 'frontend'])
    expect(starts[2].task).toContain(
      'Fix what the review rejected: the login form never calls the endpoint'
    )
    expect(starts[2].task).toContain(COMPLEX_REQUEST)

    // The rework round was announced as a retry and re-verified.
    expect(messageTypes(events)).toContain('RETRY_REQUIRED')
    const retry = events
      .filter((e) => e.type === 'agent-message')
      .map(
        (e) => (e as { message: { type: string; nextAction?: string; recipient?: string } }).message
      )
      .find((m) => m.type === 'RETRY_REQUIRED')
    expect(retry?.nextAction).toBe('the login form never calls the endpoint')
    expect(retry?.recipient).toBe('frontend')
    expect(runCommand).toHaveBeenCalledTimes(2) // verify, then re-verify

    // Two review calls: the FAIL and the final PASS, around one sizing, one audit, one
    // spec and one plan.
    expect(coordinationCalls()).toEqual([
      'router',
      'audit',
      'spec',
      'plan',
      'phase-plan',
      'review',
      'review'
    ])
    // The second review judged the UPDATED blackboard — the rework node's own
    // report is in its digest, so the verdict is about the fixed state.
    const secondReview = coordinationPrompt('review', 1)
    expect(secondReview).toContain('rework-1')
    expect(secondReview).toContain('### Work completed')

    // It ultimately passed, so no failure warning is shown. The rework line reads as
    // the specialist and the fix it was given, not as `rework-1`.
    const text = textOf(events)
    expect(text).toContain('- ✓ **Frontend Engineer** — Fix what the review rejected:')
    expect(text).not.toContain('**rework-1**')
    expect(text).not.toContain('Review did not pass')
    expect(text).not.toContain('needs your input')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('reports honestly when the project’s own checks fail', async () => {
    // A lenient reviewer cannot override the deterministic evidence of a red check.
    runCommand.mockResolvedValue({
      exitCode: 1,
      output: 'src/api.ts(3,7): error TS2322: Type mismatch.',
      truncated: false
    })
    coordination({
      plan: planJson([
        {
          id: 't1',
          role: 'backend',
          description: 'build the login API endpoint',
          dependsOn: [],
          filesHint: ['src/api.ts']
        },
        {
          id: 't2',
          role: 'frontend',
          description: 'build the React login form',
          dependsOn: ['t1'],
          filesHint: ['src/ui.tsx']
        }
      ])
      // No verdicts given: the reviewer keeps saying it's fine.
    })
    specialists([
      ['login API endpoint', 'src/api.ts', 'T1'],
      ['React login form', 'src/ui.tsx', 'T2']
    ])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-red'), emit, noTerminal)

    // The reviewer was shown the actual compiler output, not a summary of it.
    expect(coordinationPrompt('review')).toContain('error TS2322')
    expect(coordinationPrompt('review')).toContain("The project's checks failed")

    // Rework was attempted to the bound, then the failure was surfaced.
    expect(agentStarts(events).map((s) => s.role)).toEqual([
      'backend',
      'frontend',
      'builder',
      'builder'
    ])
    const text = textOf(events)
    expect(text).toContain('⚠ `npm run typecheck` failed')
    expect(text).toContain('Review still failing after 2 rework attempts')
    expect(text).toContain('this needs your input')

    // §9/§25 — the phase did NOT close, and memory records the red check instead of
    // claiming progress: no archive, and STATE.md says the build is failing.
    const state = virtualFs.get('.sylor/STATE.md') ?? ''
    expect(state).toContain('Phase: 1 — Discovery and foundation')
    expect(state).toContain('Build: FAILING')
    expect(virtualFs.has('.sylor/plans/phase-01-discovery-and-foundation.md')).toBe(false)
    expect(text).toContain('**Phase 1 of 9 — Discovery and foundation** — still in progress.')
    expect(events.at(-1)?.type).toBe('done')
  })
})

// ---- 4. Sub-agent power-up: background + worktree isolation (Phase 3) ---------

describe('E2E — the lead can fire a background agent and keep working', () => {
  it('runs a background spawn non-blocking, then integrates its report before done', async () => {
    // The single-agent (SIMPLE) path: the lead runs over the real history and may
    // delegate. Here it fires ONE background agent, is told to move on, keeps
    // going, and the report is woven back in before the turn concludes.
    coordination() // a SIMPLE turn: the review gate is the only coordination call

    let leadSpawned = false
    streamCompletion.mockImplementation((async (_model, messages, onChunk) => {
      const brief = String((messages as ChatMessage[])[1]?.content ?? '')
      if (brief.includes('the background slice')) {
        // The delegated subagent — a prose-only report ends its loop at once.
        onChunk({
          delta: 'BG_REPORT: finished the background slice.'
        } as Omit<CompletionChunk, 'streamId'>)
        return
      }
      // The lead. Spawn once (non-blocking) on its first step, then wrap up.
      if (!leadSpawned) {
        leadSpawned = true
        onChunk({
          delta:
            'Kicking off the slow part.\n\n' +
            spawnBlock({ role: 'builder', task: 'the background slice', background: true })
        } as Omit<CompletionChunk, 'streamId'>)
        return
      }
      onChunk({ delta: 'Lead is done.' } as Omit<CompletionChunk, 'streamId'>)
    }) as Provider['streamCompletion'])

    const { events, emit } = collector()
    await runWorkflow(
      req('e2e-bg', { messages: [{ role: 'user', content: 'fix the typo' }] }),
      emit,
      noTerminal
    )

    // The spawn was flagged `background` on the wire so the renderer can badge it.
    const start = events.find(
      (e): e is Extract<WorkflowEvent, { type: 'agent-start' }> => e.type === 'agent-start'
    )
    expect(start?.background).toBe(true)
    expect(start?.isolation).toBeUndefined()

    // Non-blocking is real: the lead was NOT handed the report synchronously — it
    // got a "keep working" note first…
    const toldToMoveOn = streamCompletion.mock.calls.some((c) =>
      (c[1] as ChatMessage[]).some(
        (m) => typeof m.content === 'string' && m.content.includes('in the BACKGROUND')
      )
    )
    expect(toldToMoveOn).toBe(true)
    // …and the subagent's report came back later, reaching the lead in a subsequent
    // step (fed as a normal turn), not at spawn time.
    const integratedLater = streamCompletion.mock.calls.some((c) =>
      (c[1] as ChatMessage[]).some(
        (m) => typeof m.content === 'string' && m.content.includes('BG_REPORT')
      )
    )
    expect(integratedLater).toBe(true)

    // The subagent finished with its report, and the run ended only AFTER it did —
    // the background join gates `done`, so the fan-out can't be left pending.
    const ends = agentEnds(events)
    expect(ends).toHaveLength(1)
    expect(ends[0].report).toContain('BG_REPORT')
    expect(ends[0].ok).toBe(true)
    const endIdx = events.findIndex((e) => e.type === 'agent-end')
    const doneIdx = events.findIndex((e) => e.type === 'done')
    expect(endIdx).toBeGreaterThanOrEqual(0)
    expect(doneIdx).toBeGreaterThan(endIdx)
    expect(events.at(-1)?.type).toBe('done')
  })
})

describe('E2E — an isolated agent runs inside a private worktree', () => {
  it('carves a worktree, confines the loop to it, and finalizes on the way out', async () => {
    coordination() // a SIMPLE turn: the review gate is the only coordination call
    // Script the isolation seam: a fake handle stands in for a real git worktree,
    // and finalize returns the sync-back note that should ride home on the report.
    const handle = { dir: '/wt', branch: 'sylor/agent-iso', base: '/test' }
    createWorktree.mockResolvedValue(handle)
    finalizeWorktree.mockResolvedValue(
      'Isolated worktree changes merged back into the project (1 files synced).'
    )

    let leadSpawned = false
    streamCompletion.mockImplementation((async (_model, messages, onChunk) => {
      const brief = String((messages as ChatMessage[])[1]?.content ?? '')
      if (brief.includes('the isolated slice')) {
        // The delegated subagent, running confined to the worktree: it does a real
        // write on its first step, then reports.
        if (!virtualFs.has('src/iso.ts')) {
          onChunk({
            delta: 'Working isolated.\n\n' + writeBlock('src/iso.ts', '// ISO\n')
          } as Omit<CompletionChunk, 'streamId'>)
        } else {
          onChunk({ delta: 'ISO_REPORT: done in the worktree.' } as Omit<
            CompletionChunk,
            'streamId'
          >)
        }
        return
      }
      if (!leadSpawned) {
        leadSpawned = true
        onChunk({
          delta:
            'Delegating in isolation.\n\n' +
            spawnBlock({ role: 'builder', task: 'the isolated slice', isolation: 'worktree' })
        } as Omit<CompletionChunk, 'streamId'>)
        return
      }
      onChunk({ delta: 'Lead wrapped up.' } as Omit<CompletionChunk, 'streamId'>)
    }) as Provider['streamCompletion'])

    const { events, emit } = collector()
    await runWorkflow(
      req('e2e-iso', { messages: [{ role: 'user', content: 'fix the typo' }] }),
      emit,
      noTerminal
    )

    // A worktree was carved for the spawned agent, and its ENTIRE loop ran wrapped
    // in `runWithRoot(handle.dir, …)` — the confinement wiring, proven by the root
    // the override was handed.
    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(runWithRoot).toHaveBeenCalledWith('/wt', expect.any(Function))
    // The subagent still did real work while confined.
    expect(filesWritten()).toEqual(['src/iso.ts'])

    // On the way out it was finalized (synced back + torn down) with the very
    // handle it was created with, and the sync-back note rode home on the report.
    expect(finalizeWorktree).toHaveBeenCalledTimes(1)
    expect(finalizeWorktree.mock.calls[0][0]).toBe(handle)
    const ends = agentEnds(events)
    expect(ends).toHaveLength(1)
    expect(ends[0].report).toContain('merged back into the project')

    // The isolation flag was surfaced on the wire for the renderer badge.
    const start = events.find(
      (e): e is Extract<WorkflowEvent, { type: 'agent-start' }> => e.type === 'agent-start'
    )
    expect(start?.isolation).toBe('worktree')
    expect(start?.background).toBeUndefined()
    expect(events.at(-1)?.type).toBe('done')
  })
})

// ---- 5. VERIFY reads the checkers as structured data (Phase 8) ----------------

/**
 * The VERIFY stage prefers the `diagnostics` tool over `npm run typecheck` /
 * `npm run lint` when the project's own checkers are installed: the same check,
 * but the reviewer is briefed with sorted, file-grouped entries instead of a wall
 * of pty-wrapped terminal text.
 *
 * These tests are about the SWITCH, not about parsing (that lives in
 * `diagnostics/run.test.ts`): which route was taken, what the reviewer was shown,
 * and — the part that could silently lie — that a checker which didn't actually run
 * never counts as coverage.
 */
describe('E2E — VERIFY reads type/lint problems as structured diagnostics', () => {
  /** The two-specialist complex build every test here verifies the tail of. */
  const build = (): void => {
    coordination({
      plan: planJson([
        {
          id: 't1',
          role: 'backend',
          description: 'build the login API endpoint',
          dependsOn: [],
          filesHint: ['src/api.ts']
        },
        {
          id: 't2',
          role: 'frontend',
          description: 'build the React login form',
          dependsOn: ['t1'],
          filesHint: ['src/ui.tsx']
        }
      ])
    })
    specialists([
      ['login API endpoint', 'src/api.ts', 'T1'],
      ['React login form', 'src/ui.tsx', 'T2']
    ])
  }

  it('runs diagnostics instead of the scripts it covers, and briefs the reviewer with the report', async () => {
    checkersAvailable = { typescript: true, eslint: true }
    build()

    const { events, emit } = collector()
    await runWorkflow(req('e2e-diag-ok'), emit, noTerminal)

    // One diagnostics pass over both checkers — not one per checker.
    expect(diagnostics).toHaveBeenCalledTimes(1)
    expect(diagnostics.mock.calls[0][0].scope).toBe('all')
    // `npm run typecheck` is what diagnostics just did, so it was NOT also run.
    expect(runCommand).not.toHaveBeenCalled()

    // It went through the normal gate: a real tool card, in the verifying phase.
    const proposal = events.find(
      (e): e is Extract<WorkflowEvent, { type: 'tool-request' }> =>
        e.type === 'tool-request' && e.proposal.kind === 'diagnostics'
    )
    expect(proposal?.auto).toBe(true)
    const result = events.find(
      (e): e is Extract<WorkflowEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.result.kind === 'diagnostics'
    )
    expect(result).toBeDefined()

    // The reviewer and the user are both told which check actually passed.
    expect(coordinationPrompt('review')).toContain('diagnostics (all) → passed')
    expect(textOf(events)).toContain('Verified with `diagnostics (all)`')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('fails verification on a diagnostics error and hands the reviewer the entries', async () => {
    checkersAvailable = { typescript: true, eslint: true }
    diagnostics.mockResolvedValue({
      ok: true,
      entries: [
        {
          file: 'src/api.ts',
          line: 3,
          column: 7,
          severity: 'error',
          code: 'TS2322',
          message: 'Type mismatch.',
          source: 'typescript'
        }
      ],
      errors: 1,
      warnings: 0,
      truncated: false,
      ran: ['typescript (tsconfig.json)', 'eslint'],
      skipped: [],
      output: 'CHECKED: typescript (tsconfig.json), eslint\n\nsrc/api.ts\n  3:7  error  TS2322  Type mismatch.',
      summary: '1 error'
    })
    build() // a lenient reviewer — the red check must decide this on its own

    const { events, emit } = collector()
    await runWorkflow(req('e2e-diag-red'), emit, noTerminal)

    // The reviewer saw the real entry, and the deterministic failure outranked it.
    expect(coordinationPrompt('review')).toContain('src/api.ts')
    expect(coordinationPrompt('review')).toContain('TS2322')
    expect(coordinationPrompt('review')).toContain("The project's checks failed")

    const text = textOf(events)
    expect(text).toContain('⚠ `diagnostics (all)` failed')
    expect(text).toContain('this needs your input')
    // §25 — a red check is recorded as failing, and the phase does not close.
    expect(virtualFs.get('.sylor/STATE.md') ?? '').toContain('Build: FAILING')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not count a diagnostics run that checked nothing as verification', async () => {
    // The honesty case: the checkers were installed a moment ago but the run came
    // back with nothing checked. That is UNVERIFIED — so the npm script must still
    // run rather than the turn claiming a pass it never earned.
    checkersAvailable = { typescript: true, eslint: true }
    diagnostics.mockResolvedValue({
      ok: false,
      entries: [],
      errors: 0,
      warnings: 0,
      truncated: false,
      ran: [],
      skipped: ['typescript (no tsconfig.json found)', 'eslint (no eslint config in this project)'],
      output: 'NOTHING WAS CHECKED — typescript (no tsconfig.json found); eslint (…).',
      summary: 'nothing was checked',
      error: 'No checker could be run: typescript (no tsconfig.json found)'
    })
    runCommand.mockResolvedValue({ exitCode: 0, output: 'no errors', truncated: false })
    build()

    const { events, emit } = collector()
    await runWorkflow(req('e2e-diag-empty'), emit, noTerminal)

    expect(diagnostics).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand.mock.calls[0][0]).toBe('npm run typecheck')
    expect(coordinationPrompt('review')).toContain('npm run typecheck → passed')
    expect(textOf(events)).toContain('Verified with `npm run typecheck`')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('keeps the scripts diagnostics could not cover', async () => {
    // ESLint only: `npm run lint` is covered, `npm run typecheck` is not.
    checkersAvailable = { typescript: false, eslint: true }
    virtualFs.set(
      'package.json',
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' } })
    )
    runCommand.mockResolvedValue({ exitCode: 0, output: 'no errors', truncated: false })
    build()

    const { events, emit } = collector()
    await runWorkflow(req('e2e-diag-partial'), emit, noTerminal)

    expect(diagnostics.mock.calls[0][0].scope).toBe('eslint')
    expect(runCommand.mock.calls.map((c) => c[0])).toEqual(['npm run typecheck'])
    expect(coordinationPrompt('review')).toContain('diagnostics (eslint) && npm run typecheck')
    expect(events.at(-1)?.type).toBe('done')
  })
})

// ---- 6. Stopping one lane, not the run (Phase 3) ------------------------------

/**
 * Per-subagent cancel. The requirement is precise: stopping one lane must leave the
 * run and its siblings running, and the lead must be TOLD the slice was cancelled
 * rather than handed a truncated report it would read as a conclusion.
 *
 * Both lanes are parked mid-completion here (each hangs until its own signal aborts,
 * or until the test releases it) because that is the state a user actually reaches
 * for the stop button in — not a tidy gap between steps.
 */
describe('E2E — one subagent can be stopped without ending the run', () => {
  /** Resolves when `signal` aborts (or immediately if it already has). */
  const aborted = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (!signal) return
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })

  it('aborts only the cancelled lane, reports it as cancelled, and lets the run finish', async () => {
    coordination() // a SIMPLE turn: the review gate is the only coordination call

    let releaseGood: () => void = () => {}
    const goodParked = new Promise<void>((resolve) => {
      releaseGood = resolve
    })
    let spawns = 0
    streamCompletion.mockImplementation((async (_model, messages, onChunk, signal) => {
      const brief = String((messages as ChatMessage[])[1]?.content ?? '')
      // The doomed lane: it starts work, then never returns on its own. Only its own
      // abort ends this — which is the whole point of the test.
      if (brief.includes('the doomed slice')) {
        onChunk({ delta: 'Started the doomed slice.' } as Omit<CompletionChunk, 'streamId'>)
        await aborted(signal)
        return
      }
      // The sibling lane: parked too, so "still running after the cancel" is a real
      // observation about it rather than a race with its own completion.
      if (brief.includes('the good slice')) {
        await Promise.race([goodParked, aborted(signal)])
        onChunk({ delta: 'GOOD_REPORT: finished the good slice.' } as Omit<
          CompletionChunk,
          'streamId'
        >)
        return
      }
      // The lead: fire the two background lanes on separate steps (one action per
      // message is the parser's guarantee), then wrap up.
      if (spawns === 0) {
        spawns++
        onChunk({
          delta:
            'Kicking both off.\n\n' +
            spawnBlock({ role: 'builder', task: 'the doomed slice', background: true })
        } as Omit<CompletionChunk, 'streamId'>)
        return
      }
      if (spawns === 1) {
        spawns++
        onChunk({
          delta:
            'And the other one.\n\n' +
            spawnBlock({ role: 'reviewer', task: 'the good slice', background: true })
        } as Omit<CompletionChunk, 'streamId'>)
        return
      }
      onChunk({ delta: 'Lead is done.' } as Omit<CompletionChunk, 'streamId'>)
    }) as Provider['streamCompletion'])

    const { events, emit } = collector()
    const p = runWorkflow(
      req('e2e-cancel-lane', { messages: [{ role: 'user', content: 'fix the typo' }] }),
      emit,
      noTerminal
    )

    // Both lanes are up and parked before anything is cancelled.
    await vi.waitFor(() => expect(agentStarts(events)).toHaveLength(2))
    const doomed = agentStarts(events).find((a) => a.task.includes('the doomed slice'))!
    const good = agentStarts(events).find((a) => a.task.includes('the good slice'))!
    expect(agentEnds(events)).toHaveLength(0)

    cancelAgent('e2e-cancel-lane', doomed.agentId)

    // Exactly one lane closes, and it is the one that was stopped.
    await vi.waitFor(() => expect(agentEnds(events)).toHaveLength(1))
    const closed = events.find(
      (e): e is Extract<WorkflowEvent, { type: 'agent-end' }> => e.type === 'agent-end'
    )!
    expect(closed.agentId).toBe(doomed.agentId)
    expect(closed.ok).toBe(false)
    // Said plainly, including that nothing was rolled back — the honest version of
    // "stopped", not a half-report the lead would build on.
    expect(closed.report).toContain('Cancelled by you')
    expect(closed.report).toContain('still there')

    // The sibling is untouched and the run is still going: no `done`, no error.
    expect(events.some((e) => e.type === 'done')).toBe(false)
    expect(events.some((e) => e.type === 'error')).toBe(false)

    releaseGood()
    await p

    // Both lanes are accounted for, with opposite outcomes.
    const ends = agentEnds(events)
    expect(ends).toHaveLength(2)
    const goodEnd = events.find(
      (e): e is Extract<WorkflowEvent, { type: 'agent-end' }> =>
        e.type === 'agent-end' && e.agentId === good.agentId
    )!
    expect(goodEnd.ok).toBe(true)
    expect(goodEnd.report).toContain('GOOD_REPORT')

    // The lead was TOLD the slice was cancelled — it decides what to do without it,
    // which it can only do if the cancellation reached its context.
    const leadHeard = streamCompletion.mock.calls.some((c) =>
      (c[1] as ChatMessage[]).some(
        (m) => typeof m.content === 'string' && m.content.includes('Cancelled by you')
      )
    )
    expect(leadHeard).toBe(true)

    // And the turn concluded normally: one lane stopping is not the run stopping.
    expect(textOf(events)).toContain('Lead is done.')
    expect(events.at(-1)?.type).toBe('done')
  })
})

