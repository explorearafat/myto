import { describe, it, expect } from 'vitest'
import type { RunCommandProposal, WorkflowEvent, WorkflowRunRequest } from '../shared/types'
import { runHeadless, type HeadlessDeps } from './run'
import type { CliOptions } from './args'

const BASE_OPTIONS: CliOptions = {
  prompt: 'hi',
  permissionMode: 'auto-edit',
  mode: 'code',
  effort: 'medium',
  root: null,
  userDataDir: null,
  json: false
}

interface Harness {
  deps: HeadlessDeps
  stdout: () => string
  stderr: () => string
  decisions: Array<{ runId: string; toolId: string; decision: string }>
  injected: { userData: string[]; db: string[]; root: string[]; mcpRoot: string[] }
  lastRequest: () => WorkflowRunRequest | null
}

/**
 * Build a fully faked {@link HeadlessDeps}. `emitScript` is the sequence of events
 * the fake engine emits synchronously before resolving — standing in for a real
 * run without a model, DB, or Electron.
 */
function harness(emitScript: WorkflowEvent[] = []): Harness {
  const out: string[] = []
  const err: string[] = []
  const decisions: Harness['decisions'] = []
  const injected = { userData: [] as string[], db: [] as string[], root: [] as string[], mcpRoot: [] as string[] }
  let captured: WorkflowRunRequest | null = null

  const deps: HeadlessDeps = {
    runWorkflow: async (request, emit) => {
      captured = request
      for (const event of emitScript) emit(event)
    },
    resolveToolDecision: (runId, toolId, decision) => decisions.push({ runId, toolId, decision }),
    setUserDataDir: (d) => injected.userData.push(d),
    setDbPath: (d) => injected.db.push(d),
    setRoot: (d) => injected.root.push(d),
    setMcpRoot: (d) => injected.mcpRoot.push(d),
    writeStdout: (t) => out.push(t),
    writeStderr: (t) => err.push(t),
    newRunId: () => 'run-1',
    userDataDir: '/ud',
    dbPath: '/ud/sylor.db',
    root: '/root'
  }

  return {
    deps,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    decisions,
    injected,
    lastRequest: () => captured
  }
}

const delta = (text: string, agentId?: string): WorkflowEvent => ({
  type: 'delta',
  runId: 'run-1',
  text,
  ...(agentId ? { agentId } : {})
})

describe('runHeadless — setup', () => {
  it('injects the Electron-free paths before running', async () => {
    const h = harness()
    await runHeadless(BASE_OPTIONS, h.deps)
    expect(h.injected.userData).toEqual(['/ud'])
    expect(h.injected.db).toEqual(['/ud/sylor.db'])
    expect(h.injected.root).toEqual(['/root'])
    expect(h.injected.mcpRoot).toEqual(['/root'])
  })

  it('builds a single-user-turn request from the options', async () => {
    const h = harness()
    await runHeadless(
      { ...BASE_OPTIONS, prompt: 'do it', permissionMode: 'autonomous', mode: 'cowork', effort: 'high' },
      h.deps
    )
    const req = h.lastRequest()
    expect(req).toMatchObject({
      runId: 'run-1',
      messages: [{ role: 'user', content: 'do it' }],
      permissionMode: 'autonomous',
      projectId: null,
      effort: 'high',
      planFirst: false,
      mode: 'cowork'
    })
  })
})

describe('runHeadless — streamed answer', () => {
  it('writes lead deltas to stdout and terminates with a newline; exit 0', async () => {
    const h = harness([delta('Hel'), delta('lo'), { type: 'done', runId: 'run-1' }])
    const code = await runHeadless(BASE_OPTIONS, h.deps)
    expect(h.stdout()).toBe('Hello\n')
    expect(code).toBe(0)
  })

  it('keeps subagent deltas out of stdout (progress, not answer)', async () => {
    const h = harness([delta('lead only'), delta('subagent noise', 'a1')])
    await runHeadless(BASE_OPTIONS, h.deps)
    expect(h.stdout()).toBe('lead only\n')
  })

  it('maps an error event to exit code 1 and a stderr note', async () => {
    const h = harness([{ type: 'error', runId: 'run-1', message: 'boom' }])
    const code = await runHeadless(BASE_OPTIONS, h.deps)
    expect(code).toBe(1)
    expect(h.stderr()).toContain('error: boom')
  })
})

describe('runHeadless — headless approvals', () => {
  const gated: WorkflowEvent = {
    type: 'tool-request',
    runId: 'run-1',
    proposal: { id: 'p1', kind: 'run_command', command: 'npm i' } satisfies RunCommandProposal,
    auto: false
  }

  it('rejects a gated proposal by default and explains how to allow it', async () => {
    const h = harness([gated])
    await runHeadless(BASE_OPTIONS, h.deps)
    expect(h.decisions).toEqual([{ runId: 'run-1', toolId: 'p1', decision: 'reject' }])
    expect(h.stderr()).toContain('skipped')
    expect(h.stderr()).toContain('autonomous')
  })

  it('approves a gated proposal in autonomous mode', async () => {
    const h = harness([gated])
    await runHeadless({ ...BASE_OPTIONS, permissionMode: 'autonomous' }, h.deps)
    expect(h.decisions).toEqual([{ runId: 'run-1', toolId: 'p1', decision: 'approve' }])
    expect(h.stderr()).toContain('approved')
  })

  it('does not decide an already auto-approved proposal', async () => {
    const h = harness([{ ...gated, auto: true }])
    await runHeadless(BASE_OPTIONS, h.deps)
    expect(h.decisions).toEqual([])
  })
})

describe('runHeadless — json mode', () => {
  it('emits each event as JSONL to stdout, nothing to stderr', async () => {
    const events: WorkflowEvent[] = [delta('hi'), { type: 'done', runId: 'run-1' }]
    const h = harness(events)
    await runHeadless({ ...BASE_OPTIONS, json: true }, h.deps)
    const lines = h.stdout().trimEnd().split('\n')
    expect(lines.map((l) => JSON.parse(l))).toEqual(events)
    expect(h.stderr()).toBe('')
  })

  it('still resolves gated proposals but writes no human note', async () => {
    const h = harness([
      {
        type: 'tool-request',
        runId: 'run-1',
        proposal: { id: 'p1', kind: 'run_command', command: 'ls' } satisfies RunCommandProposal,
        auto: false
      }
    ])
    await runHeadless({ ...BASE_OPTIONS, json: true }, h.deps)
    expect(h.decisions).toEqual([{ runId: 'run-1', toolId: 'p1', decision: 'reject' }])
    expect(h.stderr()).toBe('')
  })
})
