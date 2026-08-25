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
    ({ streamCompletion, getCompletion, listModels: vi.fn(), testConnection: vi.fn() }) as unknown as Provider
}))

const settings = { ...DEFAULT_PROVIDER_SETTINGS, modelId: 'test-model', modelName: 'Test Model' }
vi.mock('@main/settings', () => ({
  getSettings: () => settings,
  isSkillEnabled: () => true
}))

vi.mock('@main/context/manager', () => ({
  contextManager: {
    listFiles: () => ['package.json', 'src/index.ts'],
    buildOverview: () => 'PROJECT OVERVIEW',
    getRoot: () => '/test'
  }
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

const { runWorkflow } = await import('@main/workflow/engine')

// ---- Fixtures ---------------------------------------------------------------

/**
 * A request the complexity heuristic routes to `complex` with no LLM call — three
 * distinct domain markers and three deliverables. Pinned (not mocked) so the
 * router genuinely runs and the completion budget below is an exact assertion.
 */
const COMPLEX_REQUEST =
  'add a login API endpoint and a React component and a database migration'

const planJson = (tasks: unknown[]): string => JSON.stringify({ tasks })
const verdict = (v: 'pass' | 'fail', reason = '', targetRole = 'builder'): string =>
  JSON.stringify({ verdict: v, reason, targetRole })

/** A `sylor-tool` write block exactly as a model would stream it. */
const writeBlock = (path: string, content: string): string =>
  '```sylor-tool\n' + JSON.stringify({ tool: 'write_file', path, content }) + '\n```\n'

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

const messageTypes = (events: WorkflowEvent[]): string[] =>
  events
    .filter((e) => e.type === 'agent-message')
    .map((e) => (e as { message: { type: string } }).message.type)

const agentStarts = (
  events: WorkflowEvent[]
): { agentId: string; role: string; task: string }[] =>
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

/** Paths written, in order (excluding plan.md, which the orchestrator owns). */
const filesWritten = (): string[] =>
  writeProjectFile.mock.calls.map((c) => c[0]).filter((p) => p !== 'plan.md')

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
    getCompletion
      .mockResolvedValueOnce(
        planJson([
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
      )
      .mockResolvedValueOnce(verdict('pass'))
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
    // Exactly two provider completions were spent on coordination: the plan and
    // the verdict. Routing, assignment, integration and the roll-up are code.
    expect(getCompletion).toHaveBeenCalledTimes(2)

    // ── ASSIGN: plan.md was persisted through the normal write gate.
    expect(virtualFs.get('plan.md')).toContain('- [ ] **t1** (backend) build the login API endpoint')
    expect(virtualFs.get('plan.md')).toContain('_(depends on: t1)_')

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
    const reviewUser = (getCompletion.mock.calls[1][1] as ChatMessage[])[1].content
    expect(reviewUser).toContain(COMPLEX_REQUEST)
    expect(reviewUser).toContain('npm run typecheck → passed')
    expect(reviewUser).toContain('T1_REPORT')

    // ── RESPOND: an honest roll-up of what actually happened.
    const text = textOf(events)
    expect(text).toContain('**Team result** (complex, 2 tasks)')
    expect(text).toContain('✓ **t1** (Backend Engineer)')
    expect(text).toContain('✓ **t2** (Frontend Engineer)')
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
    expect(stagesOf(events)).toEqual(expect.arrayContaining(['planning', 'generating', 'verifying']))
    expect(events.at(-1)?.type).toBe('done')
  })

  it('keeps a small edit on the single-agent path — no plan.md, no team roll-up', async () => {
    // A SIMPLE request spends NO planning completion, so the reviewer's verdict is
    // the only one. The node runs as the lead over the real conversation history:
    // it writes on its first step, then reports — a genuine edit, not a team.
    getCompletion.mockResolvedValueOnce(verdict('pass'))
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

    expect(getCompletion).toHaveBeenCalledTimes(1) // the review gate only
    expect(virtualFs.has('plan.md')).toBe(false)
    expect(agentStarts(events)).toHaveLength(0) // the lead IS the node
    // The lead ran over the real history, exactly as before orchestration existed.
    // (`mock.calls[0][1]` is the engine's live `outbound` array, which the loop may
    // append feedback turns to, so we assert the request is present, not that it's last.)
    const lead = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(lead[0].role).toBe('system')
    expect(lead.some((m) => m.role === 'user' && m.content === 'fix the typo')).toBe(true)
    // The lead's own write landed — the single node did real work.
    expect(filesWritten()).toEqual(['src/fix.ts'])
    // A clean single-node turn ends on the agent's own prose: no team roll-up.
    const text = textOf(events)
    expect(text).toContain('Fixed the typo.')
    expect(text).not.toContain('Team result')
    expect(events.at(-1)?.type).toBe('done')
  })
})

// ---- 2. Per-agent tool scoping, enforced at execution time -------------------

describe('E2E — capability scoping is enforced, not just described', () => {
  it('refuses a reviewer’s file write while the builder’s write lands', async () => {
    getCompletion
      .mockResolvedValueOnce(
        planJson([
          { id: 't1', role: 'reviewer', description: 'audit the auth wiring', dependsOn: [] },
          { id: 't2', role: 'builder', description: 'apply the auth fix', dependsOn: ['t1'] }
        ])
      )
      .mockResolvedValueOnce(verdict('pass'))
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
    getCompletion
      .mockResolvedValueOnce(
        planJson([
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
      )
      .mockResolvedValueOnce(verdict('fail', 'the login form never calls the endpoint', 'frontend'))
      .mockResolvedValueOnce(verdict('pass'))
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
    expect(starts[2].task).toContain('Fix what the review rejected: the login form never calls the endpoint')
    expect(starts[2].task).toContain(COMPLEX_REQUEST)

    // The rework round was announced as a retry and re-verified.
    expect(messageTypes(events)).toContain('RETRY_REQUIRED')
    const retry = events
      .filter((e) => e.type === 'agent-message')
      .map((e) => (e as { message: { type: string; nextAction?: string; recipient?: string } }).message)
      .find((m) => m.type === 'RETRY_REQUIRED')
    expect(retry?.nextAction).toBe('the login form never calls the endpoint')
    expect(retry?.recipient).toBe('frontend')
    expect(runCommand).toHaveBeenCalledTimes(2) // verify, then re-verify

    // Three judge calls: the plan, the FAIL, and the final PASS.
    expect(getCompletion).toHaveBeenCalledTimes(3)
    // The second review judged the UPDATED blackboard — the rework node's own
    // report is in its digest, so the verdict is about the fixed state.
    const secondReview = (getCompletion.mock.calls[2][1] as ChatMessage[])[1].content
    expect(secondReview).toContain('rework-1')
    expect(secondReview).toContain('### Work completed')

    // It ultimately passed, so no failure warning is shown.
    const text = textOf(events)
    expect(text).toContain('**Team result** (complex, 3 tasks)')
    expect(text).toContain('✓ **rework-1** (Frontend Engineer)')
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
    getCompletion
      .mockResolvedValueOnce(
        planJson([
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
      )
      .mockResolvedValue(verdict('pass')) // the reviewer keeps saying it's fine
    specialists([
      ['login API endpoint', 'src/api.ts', 'T1'],
      ['React login form', 'src/ui.tsx', 'T2']
    ])

    const { events, emit } = collector()
    await runWorkflow(req('e2e-red'), emit, noTerminal)

    // The reviewer was shown the actual compiler output, not a summary of it.
    expect((getCompletion.mock.calls[1][1] as ChatMessage[])[1].content).toContain('error TS2322')
    expect((getCompletion.mock.calls[1][1] as ChatMessage[])[1].content).toContain(
      "The project's checks failed"
    )

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
    expect(events.at(-1)?.type).toBe('done')
  })
})
