import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Provider } from '@main/providers'
import type {
  ChatMessage,
  CompletionChunk,
  IntentAnalysis,
  McpToolInfo,
  SkillInfo,
  WorkflowEvent,
  WorkflowRunRequest
} from '@shared/types'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

// ---- Mocks for the engine's collaborators -----------------------------------

const streamCompletion = vi.fn<Provider['streamCompletion']>()
vi.mock('@main/providers', () => ({
  providerFromSettings: (): Provider =>
    ({
      streamCompletion,
      getCompletion: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn()
    }) as unknown as Provider
}))

// A mutable settings holder so a test can vary the configured model (e.g. to
// exercise the "no model selected" guard). Normal runs have a model configured.
let settings = { ...DEFAULT_PROVIDER_SETTINGS, modelId: 'test-model', modelName: 'Test Model' }
// Disabled-skill names, mutable so a test can exercise the "user turned this off"
// filter the engine applies before listing skills in the prompt. Reset per test.
let disabledSkills = new Set<string>()
vi.mock('@main/settings', () => ({
  getSettings: () => settings,
  // The engine now resolves each skill via isSkillEnabled(name, defaultOn); these
  // tests drive enablement purely through the disabled-name set (defaultOn is
  // irrelevant here since the catalog merge is stubbed to identity below).
  isSkillEnabled: (name: string) => !disabledSkills.has(name)
}))

const listFiles = vi.fn<() => string[]>(() => ['package.json', 'src/index.ts'])
const buildOverview = vi.fn<() => string>(() => 'PROJECT OVERVIEW')
vi.mock('@main/context/manager', () => ({
  contextManager: {
    listFiles: () => listFiles(),
    buildOverview: () => buildOverview(),
    getRoot: () => '/test'
  }
}))

const classifyIntent = vi.fn<() => Promise<IntentAnalysis>>()
vi.mock('@main/workflow/intent', () => ({
  classifyIntent: () => classifyIntent()
}))

// Tool sinks — the engine's exec collaborator is mocked so tests stay hermetic
// (no real pty). Writes DO land on disk, in a throwaway directory: the
// verify-after-write check (`fs/verify`) reads the file's current bytes back
// before deciding it is still broken, so a mock that wrote nowhere would make
// every written file look instantly fixed and the "don't finish on a broken file"
// loop untestable here.
const fsRoot = mkdtempSync(join(tmpdir(), 'sylor-engine-'))
const proposeWrite = vi.fn((_path: string, content: string) => ({
  exists: false,
  oldContent: '',
  newContent: content
}))
const writeProjectFile = vi.fn<(path: string, content: string) => void>((path, content) => {
  const abs = join(fsRoot, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
})
vi.mock('@main/fs/operations', () => ({
  proposeWrite: (path: string, content: string) => proposeWrite(path, content),
  writeProjectFile: (path: string, content: string) => writeProjectFile(path, content),
  resolveSafe: (path: string) => join(fsRoot, path)
}))

afterAll(() => {
  rmSync(fsRoot, { recursive: true, force: true })
})

const runCommand = vi.fn<
  (command: string, onData: (d: string) => void, signal?: AbortSignal) => Promise<{
    exitCode: number | null
    output: string
    truncated: boolean
  }>
>(async () => ({ exitCode: 0, output: 'ok', truncated: false }))
vi.mock('@main/terminal/runner', () => ({
  runCommand: (command: string, onData: (d: string) => void, signal?: AbortSignal) =>
    runCommand(command, onData, signal)
}))

// MCP manager — mocked so engine tests never read a real ~/.sylor/mcp.json or
// connect to a live server. `getTools` drives the prompt's MCP section (a test
// can push tools to exercise it); `callTool` is a controllable spy so an
// approved mcp_call resolves deterministically. Both are reset in beforeEach.
let mcpTools: McpToolInfo[] = []
const mcpCallTool = vi.fn<
  (
    server: string,
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; output: string; truncated: boolean; error?: string }>
>(async () => ({ ok: true, output: 'mcp-ok', truncated: false }))
vi.mock('@main/mcp/manager', () => ({
  mcpManager: {
    ensureConnected: vi.fn(async () => {}),
    getTools: () => mcpTools,
    // Used by capability scoping to classify each tool's server by category.
    listServers: () => [] as { name: string; category: 'development' }[],
    callTool: (server: string, name: string, args: Record<string, unknown>) =>
      mcpCallTool(server, name, args)
  }
}))

// Skills registry — mocked so engine tests never scan a real ~/.sylor/skills.
// `getSkills` drives both the prompt's `## Available skills` section and
// `use_skill` resolution; a test pushes skills to exercise them. The engine then
// filters out any name in `disabledSkills` (see the settings mock). Reset per test.
let skills: SkillInfo[] = []
vi.mock('@main/skills/registry', () => ({
  skillsRegistry: {
    getSkills: () => skills
  }
}))

// The built-in skills catalog is stubbed to identity so these engine tests see
// only the disk skills a test pushes — the catalog's default-on built-ins are
// covered elsewhere and would otherwise pollute the prompt-listing assertions.
vi.mock('@main/skills/catalog', () => ({
  mergeSkillCatalog: (disk: SkillInfo[]) => disk
}))

// Project persistence — mocked so the engine's memory/preamble reads are
// hermetic (no real SQLite). `getProject` returns a project carrying whatever
// `projectMemory`/`projectInstructions` the test sets; `appendProjectMemory`
// records calls so the `remember` tool can be asserted.
let projectMemory = ''
let projectInstructions = ''
const appendProjectMemory = vi.fn<(id: string, note: string, now: number) => string>(
  (_id, note) => {
    projectMemory = projectMemory ? `${projectMemory}\n- ${note}` : `- ${note}`
    return projectMemory
  }
)
vi.mock('@main/db/projects', () => ({
  getProject: (id: string) => ({
    id,
    name: 'Demo',
    instructions: projectInstructions,
    memory: projectMemory,
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 0
  }),
  listProjectKnowledge: () => [],
  appendProjectMemory: (id: string, note: string, now: number) =>
    appendProjectMemory(id, note, now)
}))

const { runWorkflow, cancelWorkflow, resolveToolDecision } = await import('@main/workflow/engine')

// ---- Helpers ----------------------------------------------------------------

const userTurn: ChatMessage[] = [{ role: 'user', content: 'Explain the project structure' }]

/** Build a run request with a default permission mode. */
function req(
  runId: string,
  overrides: Partial<WorkflowRunRequest> = {}
): WorkflowRunRequest {
  return { runId, messages: userTurn, permissionMode: 'ask', ...overrides }
}

/** No-op terminal sink for tests that don't assert on terminal output. */
const noTerminal = (): void => {}

/** Collect every emitted event into an array for assertions. */
function collector(): { events: WorkflowEvent[]; emit: (e: WorkflowEvent) => void } {
  const events: WorkflowEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const stages = (events: WorkflowEvent[]): string[] =>
  events.filter((e) => e.type === 'status').map((e) => (e as { stage: string }).stage)

const types = (events: WorkflowEvent[]): string[] => events.map((e) => e.type)

/** A stream implementation that emits `text` as a single delta. */
function emitsText(text: string): Provider['streamCompletion'] {
  return async (_model, _messages, onChunk) => {
    onChunk({ delta: text } as Omit<CompletionChunk, 'streamId'>)
  }
}

/** Builds a SkillInfo test fixture; only `name` is required, the rest default. */
function skill(overrides: Partial<SkillInfo> & { name: string }): SkillInfo {
  return {
    description: '',
    whenToUse: '',
    instructions: 'do the thing',
    source: 'global',
    path: `/test/.sylor/skills/${overrides.name}/SKILL.md`,
    ...overrides
  }
}

describe('runWorkflow', () => {
  beforeEach(() => {
    streamCompletion.mockClear()
    listFiles.mockClear()
    buildOverview.mockClear()
    classifyIntent.mockClear()
    proposeWrite.mockClear()
    writeProjectFile.mockClear()
    runCommand.mockClear()
    mcpCallTool.mockClear()
    mcpTools = []
    skills = []
    disabledSkills = new Set()
  })

  it('runs the full read-only pipeline for a context-needing intent', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'question',
      summary: 'Explain a feature',
      needsContext: true
    })
    streamCompletion.mockImplementation(async (_model, _messages, onChunk) => {
      onChunk({ delta: 'Hello ' } as Omit<CompletionChunk, 'streamId'>)
      onChunk({ delta: 'world' } as Omit<CompletionChunk, 'streamId'>)
    })

    const { events, emit } = collector()
    await runWorkflow(req('r1'), emit, noTerminal)

    // Intent is emitted, project is scanned + read, and deltas stream through.
    expect(types(events)).toContain('intent')
    expect(stages(events)).toEqual([
      'understanding',
      'scanning',
      'reading',
      'planning',
      'generating'
    ])
    expect(buildOverview).toHaveBeenCalledOnce()

    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('Hello world')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('skips scanning/reading when the intent needs no context', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'question',
      summary: 'General question',
      needsContext: false
    })
    streamCompletion.mockResolvedValue(undefined)

    const { events, emit } = collector()
    await runWorkflow(req('r2'), emit, noTerminal)

    const s = stages(events)
    expect(s).not.toContain('scanning')
    expect(s).not.toContain('reading')
    expect(buildOverview).not.toHaveBeenCalled()
    // System prompt should NOT include a project overview when context is skipped.
    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].role).toBe('system')
    expect(outbound[0].content).not.toContain('PROJECT OVERVIEW')
  })

  it('injects the project overview into the system prompt when context is gathered', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'edit',
      summary: 'Change something',
      needsContext: true
    })
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('r3'), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('PROJECT OVERVIEW')
    // History is preserved after the system message.
    expect(outbound.at(-1)).toEqual(userTurn[0])
  })

  it('treats a chat intent conversationally: no scan, no tool push', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'chat',
      summary: 'You want to chat with Sylor.',
      needsContext: false
    })
    streamCompletion.mockResolvedValue(undefined)

    const { events, emit } = collector()
    await runWorkflow(req('rc'), emit, noTerminal)

    const s = stages(events)
    expect(s).not.toContain('scanning')
    expect(s).not.toContain('reading')
    expect(buildOverview).not.toHaveBeenCalled()

    // The system prompt tells the model to stay conversational, not propose tools.
    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('conversational')
  })

  it('cowork mode is a pure chat turn: no intent classify, no scan, chat-only prompt', async () => {
    // Cowork bypasses the whole agent pipeline — it never classifies intent or
    // scans the project, and its system prompt teaches no tool protocol.
    streamCompletion.mockImplementation(emitsText('Here is how you do it.'))

    const { events, emit } = collector()
    await runWorkflow(req('rcw', { mode: 'cowork' }), emit, noTerminal)

    // No intent step and no project reads.
    expect(classifyIntent).not.toHaveBeenCalled()
    expect(buildOverview).not.toHaveBeenCalled()
    expect(types(events)).not.toContain('intent')
    const s = stages(events)
    expect(s).not.toContain('scanning')
    expect(s).not.toContain('reading')

    // Exactly one completion, driven by the chat-only system prompt.
    expect(streamCompletion).toHaveBeenCalledOnce()
    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].role).toBe('system')
    expect(outbound[0].content).toContain('Cowork')
    // The tool protocol is never taught in Cowork mode.
    expect(outbound[0].content).not.toContain('sylor-tool')
    expect(outbound[0].content).not.toContain('write_file')

    // Prose streamed through and the turn ended cleanly.
    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('Here is how you do it.')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('tells the model to act immediately and emit write_file on an edit intent', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'edit',
      summary: 'Build a thing',
      needsContext: false
    })
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('re'), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toMatch(/immediately emit/i)
  })

  it('injects the plan-first directive on an edit turn when planFirst is on', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'edit',
      summary: 'Build a thing',
      needsContext: false
    })
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('rp', { planFirst: true }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('PLAN-FIRST MODE')
    expect(outbound[0].content).toContain('plan.md')
  })

  it('omits the plan-first directive for a non-edit turn even when planFirst is on', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'question',
      summary: 'A question',
      needsContext: false
    })
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('rp2', { planFirst: true }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).not.toContain('PLAN-FIRST MODE')
  })

  it('errors with actionable guidance when no model is configured', async () => {
    // The engine refuses to run without a selected model, emitting one clear
    // error instead of firing a malformed request. Restore settings afterwards
    // (finally runs even on assertion failure) so sibling tests stay isolated.
    const prev = settings
    settings = { ...DEFAULT_PROVIDER_SETTINGS, modelId: '', modelName: '' }
    try {
      classifyIntent.mockResolvedValue({ kind: 'chat', summary: 'hi', needsContext: false })
      streamCompletion.mockResolvedValue(undefined)

      const { events, emit } = collector()
      await runWorkflow(req('rno'), emit, noTerminal)

      const errors = events.filter((e) => e.type === 'error')
      expect(errors).toHaveLength(1)
      expect((errors[0] as { message: string }).message).toMatch(/no model selected/i)
      // It bailed before touching the provider and without emitting `done`.
      expect(streamCompletion).not.toHaveBeenCalled()
      expect(types(events)).not.toContain('done')
    } finally {
      settings = prev
    }
  })

  it('cancelWorkflow on an unknown id is a no-op', () => {
    expect(() => cancelWorkflow('does-not-exist')).not.toThrow()
  })
})

// ---- Tool execution (Phase 4) -----------------------------------------------

/** Extracts the first tool-request event, or fails. */
function firstToolRequest(events: WorkflowEvent[]) {
  const e = events.find((ev) => ev.type === 'tool-request')
  if (!e || e.type !== 'tool-request') throw new Error('no tool-request emitted')
  return e
}

/** Extracts the first tool-result event, or fails. */
function firstToolResult(events: WorkflowEvent[]) {
  const e = events.find((ev) => ev.type === 'tool-result')
  if (!e || e.type !== 'tool-result') throw new Error('no tool-result emitted')
  return e
}

const WRITE_BLOCK =
  '```sylor-tool\n{ "tool": "write_file", "path": "src/new.ts", "content": "export const x = 1" }\n```\n'
const CMD_BLOCK = '```sylor-tool\n{ "tool": "run_command", "command": "npm test" }\n```\n'
const REMEMBER_BLOCK =
  '```sylor-tool\n{ "tool": "remember", "note": "This project uses pnpm" }\n```\n'
const MCP_BLOCK =
  '```sylor-tool\n{ "tool": "mcp_call", "server": "fs", "name": "read_file", "arguments": { "path": "a.txt" } }\n```\n'
const USE_SKILL_BLOCK = '```sylor-tool\n{ "tool": "use_skill", "name": "pdf-tools" }\n```\n'

describe('runWorkflow tool execution', () => {
  beforeEach(() => {
    streamCompletion.mockReset()
    classifyIntent.mockReset()
    proposeWrite.mockClear()
    writeProjectFile.mockClear()
    runCommand.mockClear()
    appendProjectMemory.mockClear()
    mcpCallTool.mockClear()
    mcpTools = []
    skills = []
    disabledSkills = new Set()
    projectMemory = ''
    projectInstructions = ''
    classifyIntent.mockResolvedValue({ kind: 'edit', summary: 'edit', needsContext: false })
  })

  it('auto-approves a write in auto-edit mode and applies it', async () => {
    streamCompletion.mockImplementationOnce(emitsText('I will create the file.\n' + WRITE_BLOCK))

    const { events, emit } = collector()
    await runWorkflow(req('t1', { permissionMode: 'auto-edit' }), emit, noTerminal)

    const request = firstToolRequest(events)
    expect(request.auto).toBe(true)
    expect(request.proposal.kind).toBe('write_file')
    expect(writeProjectFile).toHaveBeenCalledWith('src/new.ts', 'export const x = 1')

    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'write_file', ok: true })
    // In-block JSON must never leak into prose.
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).not.toContain('sylor-tool')
    expect(prose).toContain('I will create the file.')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('auto-edit applies a write without running any command', async () => {
    // With bypass-permission removed, no mode auto-runs commands. An auto-edit
    // turn that only writes a file must apply the write and run nothing else —
    // there is no auto-commit or other implicit command.
    streamCompletion.mockImplementationOnce(emitsText(WRITE_BLOCK))

    const { emit } = collector()
    await runWorkflow(req('tc3', { permissionMode: 'auto-edit' }), emit, noTerminal)

    expect(writeProjectFile).toHaveBeenCalledOnce()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('records a remember block to the active project memory (no approval card)', async () => {
    streamCompletion.mockImplementation(emitsText('Good to know.\n' + REMEMBER_BLOCK))

    const { events, emit } = collector()
    await runWorkflow(req('tm1', { projectId: 'proj-1' }), emit, noTerminal)

    // Memory is appended once, with the note; no tool-request/approval card is
    // emitted for it (it's not a side-effecting proposal).
    expect(appendProjectMemory).toHaveBeenCalledOnce()
    expect(appendProjectMemory.mock.calls[0][0]).toBe('proj-1')
    expect(appendProjectMemory.mock.calls[0][1]).toBe('This project uses pnpm')
    expect(events.some((e) => e.type === 'tool-request')).toBe(false)

    // The user sees a confirmation delta, and the raw JSON never leaks as prose.
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).toContain('Noted to project memory')
    expect(prose).toContain('This project uses pnpm')
    expect(prose).not.toContain('sylor-tool')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not persist a remember block when the chat has no project', async () => {
    streamCompletion.mockImplementation(emitsText(REMEMBER_BLOCK))

    const { events, emit } = collector()
    await runWorkflow(req('tm2'), emit, noTerminal)

    expect(appendProjectMemory).not.toHaveBeenCalled()
    // The user is told the note wasn't saved (needs a project).
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).toMatch(/under a project/i)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('injects existing project memory into the system prompt', async () => {
    projectMemory = '- Uses pnpm\n- Strict TypeScript'
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('tm3', { projectId: 'proj-9' }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('Project memory')
    expect(outbound[0].content).toContain('Uses pnpm')
  })

  it('auto-approves a write but NOT a command in auto-edit mode', async () => {
    // Command in auto-edit must ask; with no decision it would block, so we
    // resolve it after the request surfaces.
    streamCompletion.mockImplementationOnce(emitsText(CMD_BLOCK))

    const { events, emit } = collector()
    const p = runWorkflow(req('t2', { permissionMode: 'auto-edit' }), emit, noTerminal)

    await vi.waitFor(() => firstToolRequest(events))
    const request = firstToolRequest(events)
    expect(request.auto).toBe(false)
    resolveToolDecision('t2', request.proposal.id, 'reject')
    await p

    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'run_command', exitCode: null })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('applies a user-approved command (ask mode)', async () => {
    streamCompletion.mockImplementationOnce(emitsText(CMD_BLOCK))

    const { events, emit } = collector()
    const p = runWorkflow(req('t3', { permissionMode: 'ask' }), emit, noTerminal)

    await vi.waitFor(() => firstToolRequest(events))
    const request = firstToolRequest(events)
    expect(request.auto).toBe(false)
    resolveToolDecision('t3', request.proposal.id, 'approve')
    await p

    expect(runCommand).toHaveBeenCalledOnce()
    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'run_command', exitCode: 0, output: 'ok' })
  })

  it('skips a user-rejected write without touching disk', async () => {
    streamCompletion.mockImplementationOnce(emitsText(WRITE_BLOCK))

    const { events, emit } = collector()
    const p = runWorkflow(req('t4', { permissionMode: 'ask' }), emit, noTerminal)

    await vi.waitFor(() => firstToolRequest(events))
    const request = firstToolRequest(events)
    resolveToolDecision('t4', request.proposal.id, 'reject')
    await p

    expect(writeProjectFile).not.toHaveBeenCalled()
    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'write_file', ok: false })
  })

  it('cancelWorkflow unblocks a pending tool decision', async () => {
    streamCompletion.mockImplementationOnce(emitsText(WRITE_BLOCK))

    const { events, emit } = collector()
    const p = runWorkflow(req('t5', { permissionMode: 'ask' }), emit, noTerminal)

    await vi.waitFor(() => firstToolRequest(events))
    cancelWorkflow('t5')
    // The run unwinds without hanging and without a `done` event.
    await expect(p).resolves.toBeUndefined()
    expect(writeProjectFile).not.toHaveBeenCalled()
  })

  it('feeds a tool result back and continues on a second completion (agent loop)', async () => {
    // The heart of the loop: step 1 proposes a command; after its result is fed
    // back, step 2 concludes with plain prose and no more tools. Two completions.
    streamCompletion
      .mockImplementationOnce(emitsText('Let me run the tests.\n' + CMD_BLOCK))
      .mockImplementationOnce(emitsText('Tests passed — all good.'))

    const { events, emit } = collector()
    const p = runWorkflow(req('loop1', { permissionMode: 'ask' }), emit, noTerminal)

    // Approve the one command proposed on the first pass.
    await vi.waitFor(() => firstToolRequest(events))
    resolveToolDecision('loop1', firstToolRequest(events).proposal.id, 'approve')
    await p

    // Two completions ran: the initial proposal, then the follow-up conclusion.
    expect(streamCompletion).toHaveBeenCalledTimes(2)
    expect(runCommand).toHaveBeenCalledOnce()

    // The second completion's history carries the assistant's own proposal
    // (its tool block included) plus a synthesized user turn with the result.
    const secondOutbound = streamCompletion.mock.calls[1][1] as ChatMessage[]
    expect(secondOutbound.at(-2)?.role).toBe('assistant')
    expect(secondOutbound.at(-2)?.content).toContain('sylor-tool')
    expect(secondOutbound.at(-1)?.role).toBe('user')
    expect(secondOutbound.at(-1)?.content).toContain('run_command npm test → exit 0')

    // The final prose (from the 2nd completion) reached the user and we're done.
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).toContain('Tests passed')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not loop back after a plan-first pass', async () => {
    // Plan-first only writes plan.md and yields to the user. Even though the model
    // proposes a tool on EVERY completion (persistent mock), the engine must run
    // exactly one pass and never feed a result back.
    streamCompletion.mockImplementation(emitsText('Writing the plan.\n' + WRITE_BLOCK))

    const { events, emit } = collector()
    await runWorkflow(req('pf1', { permissionMode: 'auto-edit', planFirst: true }), emit, noTerminal)

    expect(streamCompletion).toHaveBeenCalledTimes(1)
    expect(writeProjectFile).toHaveBeenCalledOnce()
    expect(events.at(-1)?.type).toBe('done')
  })

  it('cowork mode never executes a tool block the model emits', async () => {
    // Even if the model emits a sylor-tool block in Cowork mode, the engine must
    // not execute it — no write, no approval card. The parser strips it so it
    // also never leaks into prose.
    streamCompletion.mockImplementation(emitsText('Sure, here you go.\n' + WRITE_BLOCK))

    const { events, emit } = collector()
    await runWorkflow(req('rcw2', { mode: 'cowork', permissionMode: 'auto-edit' }), emit, noTerminal)

    expect(writeProjectFile).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'tool-request')).toBe(false)
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).not.toContain('sylor-tool')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('gates an mcp_call behind approval even in auto-edit, then calls the server', async () => {
    // Only write_file is auto-approved (auto-edit). An MCP call — like a command —
    // always asks, so the model can't reach an external server without consent.
    streamCompletion.mockImplementationOnce(emitsText('Let me read that file.\n' + MCP_BLOCK))

    const { events, emit } = collector()
    const p = runWorkflow(req('mcp1', { permissionMode: 'auto-edit' }), emit, noTerminal)

    await vi.waitFor(() => firstToolRequest(events))
    const request = firstToolRequest(events)
    expect(request.auto).toBe(false)
    expect(request.proposal.kind).toBe('mcp_call')
    resolveToolDecision('mcp1', request.proposal.id, 'approve')
    await p

    // The approved call reached the manager with the parsed server/name/arguments.
    expect(mcpCallTool).toHaveBeenCalledWith('fs', 'read_file', { path: 'a.txt' })
    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'mcp_call', ok: true, output: 'mcp-ok' })

    // Its outcome is fed back into the loop so the model can react to it.
    const secondOutbound = streamCompletion.mock.calls[1][1] as ChatMessage[]
    expect(secondOutbound.at(-1)?.content).toContain('mcp_call fs/read_file → ok')
    expect(secondOutbound.at(-1)?.content).toContain('mcp-ok')
  })

  it('skips a user-rejected mcp_call without calling the server', async () => {
    streamCompletion.mockImplementationOnce(emitsText(MCP_BLOCK))

    const { events, emit } = collector()
    const p = runWorkflow(req('mcp2', { permissionMode: 'ask' }), emit, noTerminal)

    await vi.waitFor(() => firstToolRequest(events))
    resolveToolDecision('mcp2', firstToolRequest(events).proposal.id, 'reject')
    await p

    expect(mcpCallTool).not.toHaveBeenCalled()
    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'mcp_call', ok: false, error: 'Skipped by user' })
  })

  it('lists connected MCP tools in the Code-mode system prompt', async () => {
    mcpTools = [{ server: 'fs', name: 'read_file', description: 'Read a file' }]
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('mcp3', { permissionMode: 'ask' }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('## MCP tools')
    expect(outbound[0].content).toContain('fs/read_file — Read a file')
  })

  it('omits the MCP tools section when no servers are connected', async () => {
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('mcp4', { permissionMode: 'ask' }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).not.toContain('## MCP tools')
  })

  it('lists enabled skills in the Code-mode system prompt', async () => {
    skills = [
      skill({
        name: 'pdf-tools',
        description: 'Work with PDFs',
        whenToUse: 'When asked about PDFs',
        instructions: 'Step one: open the PDF.'
      })
    ]
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('sk1', { permissionMode: 'ask' }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('## Available skills')
    expect(outbound[0].content).toContain(
      'pdf-tools — Work with PDFs (use when: When asked about PDFs)'
    )
    // Only the one-line summary is listed; the full body is injected on use, not here.
    expect(outbound[0].content).not.toContain('Step one: open the PDF.')
  })

  it('omits the Available skills section when no skills are enabled', async () => {
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('sk2', { permissionMode: 'ask' }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).not.toContain('## Available skills')
  })

  it('drops a user-disabled skill from the prompt listing', async () => {
    skills = [
      skill({ name: 'pdf-tools', description: 'PDFs' }),
      skill({ name: 'sql-tools', description: 'SQL', source: 'project' })
    ]
    disabledSkills = new Set(['pdf-tools'])
    streamCompletion.mockResolvedValue(undefined)

    const { emit } = collector()
    await runWorkflow(req('sk3', { permissionMode: 'ask' }), emit, noTerminal)

    const outbound = streamCompletion.mock.calls[0][1] as ChatMessage[]
    expect(outbound[0].content).toContain('sql-tools')
    expect(outbound[0].content).not.toContain('pdf-tools')
  })

  it('activates a use_skill block: injects its instructions and keeps the loop going', async () => {
    // Skill activation is intent-agnostic; a question intent keeps this focused on
    // the loop-continuation mechanic and away from the edit-only start-build nudge
    // (which would otherwise fire on step 2's prose-only conclusion).
    classifyIntent.mockResolvedValue({ kind: 'question', summary: 'q', needsContext: false })
    skills = [
      skill({
        name: 'pdf-tools',
        description: 'Work with PDFs',
        instructions: 'Always use pdfjs. Never shell out.'
      })
    ]
    // Step 1 only activates the skill (no side effect); step 2 concludes in prose.
    streamCompletion
      .mockImplementationOnce(emitsText('Let me load the PDF skill.\n' + USE_SKILL_BLOCK))
      .mockImplementationOnce(emitsText('Using pdfjs as instructed.'))

    const { events, emit } = collector()
    await runWorkflow(req('sk4', { permissionMode: 'ask' }), emit, noTerminal)

    // A skill-only step keeps the loop alive so the injected instructions get a
    // following iteration to act on — two completions ran.
    expect(streamCompletion).toHaveBeenCalledTimes(2)
    // Skills are inline: no approval card is ever shown for use_skill.
    expect(events.some((e) => e.type === 'tool-request')).toBe(false)

    // The user sees the activation note; the raw block never leaks as prose.
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).toContain('📎 Using skill: pdf-tools')
    expect(prose).not.toContain('sylor-tool')

    // The second completion's history carries the assistant's own turn plus a
    // synthesized user turn injecting the skill's full instructions.
    const secondOutbound = streamCompletion.mock.calls[1][1] as ChatMessage[]
    expect(secondOutbound.at(-2)?.role).toBe('assistant')
    expect(secondOutbound.at(-1)?.role).toBe('user')
    expect(secondOutbound.at(-1)?.content).toContain('pdf-tools" is now active')
    expect(secondOutbound.at(-1)?.content).toContain('Always use pdfjs. Never shell out.')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('nudges a raw-code dump into a write_file block, then stages it (B1)', async () => {
    // On an edit turn the model first pastes file contents as a plain Markdown
    // code fence — so NOTHING is staged and the user gets un-actionable code. The
    // engine must nudge it to re-emit as a write_file block; the next completion
    // does, and the write applies. This is the "raw format" fix (B1) and is also
    // what makes the turn read as think → act → think.
    //
    // The engine reuses ONE `outbound` array across loop steps, so a captured
    // `mock.calls[n]` reference reflects its final (mutated) state. Snapshot the
    // history inside the 2nd completion to inspect the exact turn the nudge built.
    let nudgedHistory: ChatMessage[] = []
    streamCompletion
      .mockImplementationOnce(emitsText('Here is the file:\n\n```ts\nexport const x = 1\n```\n'))
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        nudgedHistory = (msgs as ChatMessage[]).map((m) => ({ ...m }))
        onChunk({ delta: 'Staging it now.\n' + WRITE_BLOCK } as Omit<CompletionChunk, 'streamId'>)
      })
      .mockImplementationOnce(emitsText('Done — created src/new.ts.'))

    const { events, emit } = collector()
    await runWorkflow(req('nudge1', { permissionMode: 'auto-edit' }), emit, noTerminal)

    // Three completions: the raw dump, the nudged write, then the conclusion the
    // applied write feeds back into.
    expect(streamCompletion).toHaveBeenCalledTimes(3)

    // The nudge fed back the assistant's raw dump plus a synthesized user turn
    // asking for write_file block(s).
    expect(nudgedHistory.at(-2)?.role).toBe('assistant')
    expect(nudgedHistory.at(-2)?.content).toContain('```ts')
    expect(nudgedHistory.at(-1)?.role).toBe('user')
    expect(nudgedHistory.at(-1)?.content).toContain('write_file')

    // The nudged write was actually applied to disk (via the mocked writer).
    expect(writeProjectFile).toHaveBeenCalledWith('src/new.ts', 'export const x = 1')
    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'write_file', ok: true })
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not nudge a code fence on a non-edit (question) intent', async () => {
    // Explaining with example code is legitimate on a question turn — the raw-code
    // nudge is edit-only. A single completion with a code fence just concludes;
    // it must not trigger a second "turn that into a write" pass.
    classifyIntent.mockResolvedValue({ kind: 'question', summary: 'q', needsContext: false })
    streamCompletion.mockImplementation(emitsText('Example:\n\n```ts\nconst y = 2\n```\n'))

    const { events, emit } = collector()
    await runWorkflow(req('nudge2'), emit, noTerminal)

    expect(streamCompletion).toHaveBeenCalledTimes(1)
    expect(writeProjectFile).not.toHaveBeenCalled()
    expect(events.at(-1)?.type).toBe('done')
  })

  it('nudges a build promise with no tool block into an actual write_file (start-build)', async () => {
    // The model opens an edit turn by *describing* what it will do — "I'll build
    // the signup page…" — but emits NO write_file block and no plan, so nothing is
    // created and the user is left with an empty result (the exact stall the user
    // hit on the BookME page). The engine must nudge it to start building; the next
    // completion emits the write_file block and the write applies. This is the
    // general start-build fix (4d‴), distinct from the raw-code nudge — there the
    // model at least pasted a code fence; here there is no code at all, just talk.
    //
    // One `outbound` array is reused across steps, so snapshot the history inside
    // the 2nd completion to inspect the exact turn the nudge built.
    let nudgedHistory: ChatMessage[] = []
    streamCompletion
      .mockImplementationOnce(emitsText("I'll build the BookME signup page for you now."))
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        nudgedHistory = (msgs as ChatMessage[]).map((m) => ({ ...m }))
        onChunk({ delta: 'Creating it.\n' + WRITE_BLOCK } as Omit<CompletionChunk, 'streamId'>)
      })
      .mockImplementationOnce(emitsText('Done — created src/new.ts.'))

    const { events, emit } = collector()
    await runWorkflow(req('start1', { permissionMode: 'auto-edit' }), emit, noTerminal)

    // Three completions: the empty promise, the nudged write, then the conclusion
    // the applied write feeds back into.
    expect(streamCompletion).toHaveBeenCalledTimes(3)

    // The nudge fed back the assistant's promise plus a synthesized user turn
    // demanding an actual write_file block this turn.
    expect(nudgedHistory.at(-2)?.role).toBe('assistant')
    expect(nudgedHistory.at(-2)?.content).toContain("I'll build")
    expect(nudgedHistory.at(-1)?.role).toBe('user')
    expect(nudgedHistory.at(-1)?.content).toContain('write_file')

    // The nudged write was actually applied to disk (via the mocked writer).
    expect(writeProjectFile).toHaveBeenCalledWith('src/new.ts', 'export const x = 1')
    expect(events.at(-1)?.type).toBe('done')
  })
})

// Kept in a separate describe with no mock-clearing hook: vitest 4.1.10
// re-surfaces a mock's recorded rejection/throw as a spurious failure when a
// beforeEach clears that same mock. These tests configure throwing mocks.
describe('runWorkflow error handling', () => {
  it('emits an error event (never throws) when the provider fails', async () => {
    classifyIntent.mockResolvedValue({
      kind: 'question',
      summary: 'q',
      needsContext: false
    })
    streamCompletion.mockImplementationOnce(() => {
      throw new Error('model exploded')
    })

    const { events, emit } = collector()
    await expect(runWorkflow(req('r4'), emit, noTerminal)).resolves.toBeUndefined()

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { message: string }).message).toMatch(/model exploded/)
    expect(types(events)).not.toContain('done')
  })

  it('surfaces a sandbox violation as a failed tool-result (never throws)', async () => {
    classifyIntent.mockResolvedValue({ kind: 'edit', summary: 'edit', needsContext: false })
    proposeWrite.mockImplementationOnce(() => {
      throw new Error('Path escapes the project root: ../evil.ts')
    })
    // First completion proposes the out-of-sandbox write; once its failed result
    // is fed back, the second completion concludes with no tools, ending the loop.
    streamCompletion.mockImplementation(() => Promise.resolve(undefined))
    streamCompletion.mockImplementationOnce(
      emitsText('```sylor-tool\n{ "tool": "write_file", "path": "../evil.ts", "content": "x" }\n```\n')
    )

    const { events, emit } = collector()
    await expect(
      runWorkflow(req('r5', { permissionMode: 'auto-edit' }), emit, noTerminal)
    ).resolves.toBeUndefined()

    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'write_file', ok: false })
    expect((result.result as { error?: string }).error).toMatch(/escapes the project root/)
    expect(events.at(-1)?.type).toBe('done')
  })
})

/**
 * Verify-after-write (task 4). A write that lands is immediately checked against
 * the bytes that landed, and what's wrong goes back into the loop. This is the
 * difference between "Sylor wrote a file" and "Sylor wrote a file that works":
 * before this, a broken `package.json` or a truncated component surfaced to the
 * user as a dead command or a blank page, with the model insisting it was done.
 */
describe('runWorkflow verify-after-write', () => {
  // package.json with a trailing comma: invalid JSON, and the check for it is
  // pure — no filesystem involved — so these cases are fully deterministic.
  const BROKEN_JSON =
    '```sylor-tool\n{ "tool": "write_file", "path": "package.json", "content": "{ \\"name\\": \\"app\\", }" }\n```\n'
  const FIXED_JSON =
    '```sylor-tool\n{ "tool": "write_file", "path": "package.json", "content": "{ \\"name\\": \\"app\\" }" }\n```\n'

  beforeEach(() => {
    streamCompletion.mockReset()
    classifyIntent.mockReset()
    proposeWrite.mockClear()
    writeProjectFile.mockClear()
    mcpTools = []
    skills = []
    disabledSkills = new Set()
    classifyIntent.mockResolvedValue({ kind: 'edit', summary: 'edit', needsContext: false })
  })

  it('carries what is broken on the write result and feeds it back', async () => {
    let feedback: ChatMessage[] = []
    streamCompletion
      .mockImplementationOnce(emitsText('Creating the manifest.\n' + BROKEN_JSON))
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        feedback = (msgs as ChatMessage[]).map((m) => ({ ...m }))
        onChunk({ delta: 'Fixing that.\n' + FIXED_JSON } as Omit<CompletionChunk, 'streamId'>)
      })
      .mockImplementationOnce(emitsText('Done — package.json is valid now.'))

    const { events, emit } = collector()
    await runWorkflow(req('v1', { permissionMode: 'auto-edit' }), emit, noTerminal)

    // The write succeeded — the bytes are on disk — and still reports the defect.
    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'write_file', ok: true })
    expect((result.result as { issues?: string[] }).issues?.[0]).toMatch(/not valid JSON/)

    // ...and the model was told, in the synthesized turn it acts on next.
    expect(feedback.at(-1)?.role).toBe('user')
    expect(feedback.at(-1)?.content).toMatch(/not valid JSON/)
    expect(feedback.at(-1)?.content).toMatch(/broken as written/)
    // The normal "you may finish now" ending is withheld while something is broken.
    expect(feedback.at(-1)?.content).not.toMatch(/give your final answer to the user now/)

    expect(writeProjectFile).toHaveBeenLastCalledWith('package.json', '{ "name": "app" }')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('says nothing at all about a file it cannot fault', async () => {
    // The check must be invisible when there is nothing to report: a false alarm
    // would send the model off rewriting code that already worked.
    let feedback: ChatMessage[] = []
    streamCompletion
      .mockImplementationOnce(emitsText('Creating it.\n' + WRITE_BLOCK))
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        feedback = (msgs as ChatMessage[]).map((m) => ({ ...m }))
        onChunk({ delta: 'Done — created src/new.ts.' } as Omit<CompletionChunk, 'streamId'>)
      })

    const { events, emit } = collector()
    await runWorkflow(req('v2', { permissionMode: 'auto-edit' }), emit, noTerminal)

    const result = firstToolResult(events)
    expect(result.result).toMatchObject({ kind: 'write_file', ok: true })
    expect(result.result).not.toHaveProperty('issues')
    expect(feedback.at(-1)?.content).not.toMatch(/detected in what you just wrote/)
    expect(feedback.at(-1)?.content).toMatch(/give your final answer to the user now/)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('refuses to end the turn while a file it wrote is still broken', async () => {
    // The stall this exists for: the model writes something broken, then declares
    // success in prose with no further tool block. Left alone the turn ends there
    // and the user gets the broken file with a confident "done" over it.
    let nudge: ChatMessage[] = []
    streamCompletion
      .mockImplementationOnce(emitsText('Creating the manifest.\n' + BROKEN_JSON))
      .mockImplementationOnce(emitsText('All set — package.json is created.'))
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        nudge = (msgs as ChatMessage[]).map((m) => ({ ...m }))
        onChunk({ delta: 'You are right.\n' + FIXED_JSON } as Omit<CompletionChunk, 'streamId'>)
      })
      .mockImplementationOnce(emitsText('Fixed — package.json parses now.'))

    const { events, emit } = collector()
    await runWorkflow(req('v3', { permissionMode: 'auto-edit' }), emit, noTerminal)

    // Four completions: the broken write, the premature "done", the nudge that
    // sent it back, and the conclusion after the fix actually applied.
    expect(streamCompletion).toHaveBeenCalledTimes(4)
    expect(nudge.at(-1)?.role).toBe('user')
    expect(nudge.at(-1)?.content).toMatch(/still broken/)
    expect(nudge.at(-1)?.content).toMatch(/package\.json/)

    expect(writeProjectFile).toHaveBeenLastCalledWith('package.json', '{ "name": "app" }')
    // Fixed before the end, so the user is never warned about it.
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).not.toMatch(/still look broken/)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('warns the user outright when it cannot get the file clean', async () => {
    // Bounded: after two attempts the turn ends anyway, but it must not end on a
    // silent lie. The model's own prose claims success, so the truth is appended
    // next to it — the user finding out from a dead command instead is the whole
    // failure this check exists to prevent.
    streamCompletion
      .mockImplementation(emitsText('All good — package.json is ready.'))
      .mockImplementationOnce(emitsText('Creating the manifest.\n' + BROKEN_JSON))

    const { events, emit } = collector()
    await runWorkflow(req('v4', { permissionMode: 'auto-edit' }), emit, noTerminal)

    // The write, then two nudged retries, then the give-up turn.
    expect(streamCompletion).toHaveBeenCalledTimes(4)
    const prose = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(prose).toMatch(/still look broken/)
    expect(prose).toMatch(/package\.json/)
    expect(prose).toMatch(/not valid JSON/)
    expect(events.at(-1)?.type).toBe('done')
  })
})

/**
 * Step narration (task 5). Sylor used to do a whole build in one silent burst: the
 * user watched a spinner, got no word on what was happening, and gave up. Each step
 * now opens with one short line — and since every step is a separate completion
 * appended to the SAME assistant message, those lines have to be kept apart without
 * ever rewriting what the model actually said.
 */
describe('runWorkflow step narration', () => {
  const SECOND_BLOCK =
    '```sylor-tool\n{ "tool": "write_file", "path": "src/two.ts", "content": "export const y = 2" }\n```\n'

  beforeEach(() => {
    streamCompletion.mockReset()
    classifyIntent.mockReset()
    proposeWrite.mockClear()
    writeProjectFile.mockClear()
    mcpTools = []
    skills = []
    disabledSkills = new Set()
    classifyIntent.mockResolvedValue({ kind: 'edit', summary: 'edit', needsContext: false })
  })

  const prose = (events: WorkflowEvent[]): string =>
    events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('')

  it('keeps a paragraph break between one step line and the next', async () => {
    // The block comes last, so this step's prose ends mid-paragraph — exactly when
    // the next step's opening line would otherwise be glued onto it.
    streamCompletion
      .mockImplementationOnce(emitsText('Writing the config.' + WRITE_BLOCK))
      .mockImplementationOnce(emitsText('Config is in — adding the second file.' + SECOND_BLOCK))
      .mockImplementationOnce(emitsText('Both files are in place.'))

    const { events, emit } = collector()
    await runWorkflow(req('n1', { permissionMode: 'auto-edit' }), emit, noTerminal)

    const text = prose(events)
    expect(text).not.toMatch(/config\.Config is in/)
    expect(text).toMatch(/Writing the config\.\n\n+Config is in — adding the second file\./)
    expect(text).toMatch(/second file\.\n\n+Both files are in place\./)
  })

  it('separates steps even when the prose ends flush against the block', async () => {
    // Prose *after* the block, with no trailing newline at all: nothing in the
    // stream can be relied on to end a step cleanly.
    streamCompletion
      .mockImplementationOnce(emitsText(WRITE_BLOCK + 'Config written.'))
      .mockImplementationOnce(emitsText('Now the router.'))

    const { events, emit } = collector()
    await runWorkflow(req('n2', { permissionMode: 'auto-edit' }), emit, noTerminal)

    expect(prose(events)).toMatch(/Config written\.\n\nNow the router\./)
  })

  it('never reflows prose inside a single step', async () => {
    // The separator is added only at a step boundary. Within a step the model's own
    // spacing is untouched — reflowing it would corrupt lists, code and Markdown.
    const written = 'Line one.\nLine two.\n- a\n- b'
    streamCompletion.mockImplementationOnce(emitsText(written))

    const { events, emit } = collector()
    await runWorkflow(req('n3'), emit, noTerminal)

    expect(prose(events)).toBe(written)
  })

  it('tells the model to narrate, both up front and at every step', async () => {
    let system = ''
    let feedback: ChatMessage[] = []
    streamCompletion
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        system = (msgs as ChatMessage[])[0].content
        onChunk({ delta: 'Creating it.\n' + WRITE_BLOCK } as Omit<CompletionChunk, 'streamId'>)
      })
      .mockImplementationOnce(async (_model, msgs, onChunk) => {
        feedback = (msgs as ChatMessage[]).map((m) => ({ ...m }))
        onChunk({ delta: 'Done.' } as Omit<CompletionChunk, 'streamId'>)
      })

    const { events, emit } = collector()
    await runWorkflow(req('n4', { permissionMode: 'auto-edit' }), emit, noTerminal)

    // The standing rule…
    expect(system).toMatch(/narrate the WORK/i)
    expect(system).toMatch(/at least one short line of prose/)
    // …restated where it actually bites: the turn the model reads after each round.
    expect(feedback.at(-1)?.content).toMatch(/ONE short line/)
    expect(feedback.at(-1)?.content).toMatch(/Never reply with blocks alone/)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('still forbids narrating deliberation', async () => {
    // The line restored here is "what I am doing", never "how I am deciding" — the
    // distinction that keeps this from re-opening the reasoning leak.
    let system = ''
    streamCompletion.mockImplementationOnce(async (_model, msgs, onChunk) => {
      system = (msgs as ChatMessage[])[0].content
      onChunk({ delta: 'Hi.' } as Omit<CompletionChunk, 'streamId'>)
    })

    const { events, emit } = collector()
    await runWorkflow(req('n5'), emit, noTerminal)

    expect(system).toMatch(/never\s+narrate DELIBERATION/i)
    expect(system).toMatch(/show the decision, never the debate/)
    expect(events.at(-1)?.type).toBe('done')
  })
})
