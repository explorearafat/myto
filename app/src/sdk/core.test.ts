import { describe, expect, it, vi } from 'vitest'
import type { ToolDecision, ToolProposal, WorkflowEvent, WorkflowRunRequest } from '../shared/types'
import {
  AsyncQueue,
  answerText,
  createSylor,
  defaultDecision,
  type SdkDeps
} from './core'

const ROOT = '/workspace'

/** A tool-request event for a write, the common thing a host has to decide. */
function writeProposal(id = 'tool-1'): ToolProposal {
  return { id, kind: 'write_file', path: 'src/a.ts', content: 'export const a = 1' }
}

/**
 * A fake engine. `script` receives the emit sink and drives whatever event
 * sequence a test needs; nothing is spawned and no model is called. Approval
 * resolutions are recorded so tests can assert the handshake actually happened.
 */
function makeDeps(
  script: (
    emit: (event: WorkflowEvent) => void,
    runId: string,
    onTerminal: (data: string) => void
  ) => void | Promise<void>
): {
  deps: SdkDeps
  requests: WorkflowRunRequest[]
  decisions: { toolId: string; decision: ToolDecision }[]
  cancelled: string[]
  env: string[]
  closed: () => number
} {
  const requests: WorkflowRunRequest[] = []
  const decisions: { toolId: string; decision: ToolDecision }[] = []
  const cancelled: string[] = []
  const env: string[] = []
  let closes = 0
  let n = 0

  return {
    requests,
    decisions,
    cancelled,
    env,
    closed: () => closes,
    deps: {
      engine: {
        runWorkflow: async (request, emit, onTerminal) => {
          requests.push(request)
          await script(emit, request.runId, onTerminal)
        },
        resolveToolDecision: (_runId, toolId, decision) => void decisions.push({ toolId, decision }),
        cancelWorkflow: (runId) => void cancelled.push(runId)
      },
      env: {
        setUserDataDir: (dir) => void env.push(`userData:${dir}`),
        setDbPath: (path) => void env.push(`db:${path}`),
        setRoot: (dir) => void env.push(`root:${dir}`),
        setMcpRoot: (dir) => void env.push(`mcpRoot:${dir}`),
        closeDb: () => void closes++
      },
      newRunId: () => `run-${++n}`,
      root: ROOT,
      userDataDir: '/userdata',
      dbPath: '/userdata/sylor.db'
    }
  }
}

/** The happy path: two lead deltas and a done. */
const simpleRun = (emit: (event: WorkflowEvent) => void, runId: string): void => {
  emit({ type: 'delta', runId, text: 'Hello ' })
  emit({ type: 'delta', runId, text: 'world' })
  emit({ type: 'done', runId })
}

describe('AsyncQueue', () => {
  it('delivers values pushed before iteration starts', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    const seen: number[] = []
    for await (const v of q) seen.push(v)
    expect(seen).toEqual([1, 2])
  })

  it('delivers a value pushed while the consumer is waiting', async () => {
    const q = new AsyncQueue<string>()
    const consumed = (async () => {
      const seen: string[] = []
      for await (const v of q) seen.push(v)
      return seen
    })()
    await Promise.resolve()
    q.push('late')
    q.close()
    await expect(consumed).resolves.toEqual(['late'])
  })

  it('drains what is buffered before finishing, and ignores a push after close', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.close()
    q.push(2)
    const seen: number[] = []
    for await (const v of q) seen.push(v)
    expect(seen).toEqual([1])
  })

  it('ends a waiting consumer when closed with nothing queued', async () => {
    const q = new AsyncQueue<number>()
    const consumed = (async () => {
      const seen: number[] = []
      for await (const v of q) seen.push(v)
      return seen
    })()
    await Promise.resolve()
    q.close()
    await expect(consumed).resolves.toEqual([])
  })
})

describe('answerText / defaultDecision', () => {
  it('counts a lead delta as the answer and a subagent delta as progress', () => {
    expect(answerText({ type: 'delta', runId: 'r', text: 'hi' })).toBe('hi')
    expect(answerText({ type: 'delta', runId: 'r', text: 'hi', agentId: 'a1' })).toBeNull()
    expect(answerText({ type: 'done', runId: 'r' })).toBeNull()
  })

  it('rejects unless the embedder chose hands-free', () => {
    expect(defaultDecision('ask')).toBe('reject')
    expect(defaultDecision('auto-edit')).toBe('reject')
    expect(defaultDecision('autonomous')).toBe('approve')
  })
})

describe('createSylor — wiring', () => {
  it('injects the storage paths and root before anything runs', () => {
    const { deps, env } = makeDeps(simpleRun)
    createSylor({}, deps)
    expect(env).toEqual([
      'userData:/userdata',
      'db:/userdata/sylor.db',
      'root:/workspace',
      'mcpRoot:/workspace'
    ])
  })

  it('builds a run request from the options and pins it to the root', async () => {
    const { deps, requests } = makeDeps(simpleRun)
    const sylor = createSylor(
      { permissionMode: 'auto-edit', mode: 'code', effort: 'high', projectId: 'p1' },
      deps
    )
    await sylor.run('do the thing')
    expect(requests[0]).toEqual({
      runId: 'run-1',
      messages: [{ role: 'user', content: 'do the thing' }],
      permissionMode: 'auto-edit',
      projectId: 'p1',
      effort: 'high',
      planFirst: false,
      mode: 'code',
      root: ROOT
    })
  })

  it('defaults to the timid posture: ask, no project, no plan-first', async () => {
    const { deps, requests } = makeDeps(simpleRun)
    await createSylor({}, deps).run('hi')
    expect(requests[0]).toMatchObject({ permissionMode: 'ask', projectId: null, planFirst: false })
  })

  it('lets a per-run option override an sdk-wide default', async () => {
    const { deps, requests } = makeDeps(simpleRun)
    const sylor = createSylor({ permissionMode: 'ask', effort: 'low' }, deps)
    await sylor.run('hi', { permissionMode: 'autonomous' })
    expect(requests[0]).toMatchObject({ permissionMode: 'autonomous', effort: 'low' })
  })

  it('accepts a full message list, so a host can supply its own history', async () => {
    const { deps, requests } = makeDeps(simpleRun)
    await createSylor({}, deps).run([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }
    ])
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }
    ])
  })

  it('forwards live command output to the host', async () => {
    const onTerminal = vi.fn()
    const { deps } = makeDeps((emit, runId, terminal) => {
      terminal('$ npm test\r\n')
      emit({ type: 'done', runId })
    })
    await createSylor({ onTerminal }, deps).run('run the tests')
    expect(onTerminal).toHaveBeenCalledWith('$ npm test\r\n')
  })

  it('swallows terminal output when the host wants none', async () => {
    const { deps } = makeDeps((emit, runId, terminal) => {
      terminal('noise')
      emit({ type: 'done', runId })
    })
    await expect(createSylor({}, deps).run('hi')).resolves.toMatchObject({ ok: true })
  })

  it('releases the db handle on close, and survives a close that throws', () => {
    const { deps, closed } = makeDeps(simpleRun)
    const sylor = createSylor({}, deps)
    sylor.close()
    expect(closed()).toBe(1)

    const thrower = makeDeps(simpleRun)
    thrower.deps.env.closeDb = (): void => {
      throw new Error('already closed')
    }
    expect(() => createSylor({}, thrower.deps).close()).not.toThrow()
  })
})

describe('createSylor — results', () => {
  it('collects the lead answer, ignoring subagent chatter', async () => {
    const { deps } = makeDeps((emit, runId) => {
      emit({ type: 'delta', runId, text: 'The ' })
      emit({ type: 'delta', runId, text: 'noise', agentId: 'a1' })
      emit({ type: 'delta', runId, text: 'answer.' })
      emit({ type: 'done', runId })
    })
    const result = await createSylor({}, deps).run('hi')
    expect(result.text).toBe('The answer.')
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.runId).toBe('run-1')
    expect(result.events).toHaveLength(4)
  })

  it('is not ok when the run reported an error, keeping the first message', async () => {
    const { deps } = makeDeps((emit, runId) => {
      emit({ type: 'error', runId, message: 'model unreachable' })
      emit({ type: 'error', runId, message: 'and again' })
      emit({ type: 'done', runId })
    })
    const result = await createSylor({}, deps).run('hi')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('model unreachable')
  })

  it('turns a thrown engine failure into an error event rather than a rejection', async () => {
    const { deps } = makeDeps(() => {
      throw new Error('boom')
    })
    const result = await createSylor({}, deps).run('hi')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
  })

  it('streams events to a consumer as they are emitted', async () => {
    const { deps } = makeDeps(simpleRun)
    const types: string[] = []
    for await (const event of createSylor({}, deps).stream('hi')) types.push(event.type)
    expect(types).toEqual(['delta', 'delta', 'done'])
  })
})

describe('createSylor — approvals', () => {
  /** Emit a request, wait for the SDK's deferred verdict, then finish. */
  const asksToWrite = async (
    emit: (event: WorkflowEvent) => void,
    runId: string
  ): Promise<void> => {
    emit({ type: 'tool-request', runId, proposal: writeProposal(), auto: false })
    // The SDK defers its decision by a microtask (the real engine registers the
    // pending entry after emitting); give that a turn plus one for an async policy.
    await new Promise((r) => setTimeout(r, 0))
    emit({ type: 'done', runId })
  }

  it('rejects a proposal when the host supplied no policy', async () => {
    const { deps, decisions } = makeDeps(asksToWrite)
    await createSylor({}, deps).run('write it')
    expect(decisions).toEqual([{ toolId: 'tool-1', decision: 'reject' }])
  })

  it('approves under autonomous with no policy', async () => {
    const { deps, decisions } = makeDeps(asksToWrite)
    await createSylor({ permissionMode: 'autonomous' }, deps).run('write it')
    expect(decisions).toEqual([{ toolId: 'tool-1', decision: 'approve' }])
  })

  it('asks the host policy, passing the proposal and who asked', async () => {
    const canUseTool = vi.fn(async () => 'approve' as ToolDecision)
    const { deps, decisions } = makeDeps(async (emit, runId) => {
      emit({
        type: 'tool-request',
        runId,
        proposal: writeProposal('t9'),
        auto: false,
        agentId: 'editor-1'
      })
      await new Promise((r) => setTimeout(r, 0))
      emit({ type: 'done', runId })
    })
    await createSylor({ canUseTool }, deps).run('write it')

    expect(canUseTool).toHaveBeenCalledWith({
      runId: 'run-1',
      proposal: writeProposal('t9'),
      auto: false,
      agentId: 'editor-1'
    })
    expect(decisions).toEqual([{ toolId: 't9', decision: 'approve' }])
  })

  it('never consults the policy for a pre-approved proposal', async () => {
    const canUseTool = vi.fn(() => 'approve' as ToolDecision)
    const { deps, decisions } = makeDeps((emit, runId) => {
      // `auto: true` means the engine already decided and is NOT waiting; answering
      // would resolve a decision nobody asked for.
      emit({ type: 'tool-request', runId, proposal: writeProposal(), auto: true })
      emit({ type: 'done', runId })
    })
    await createSylor({ canUseTool, permissionMode: 'autonomous' }, deps).run('go')
    expect(canUseTool).not.toHaveBeenCalled()
    expect(decisions).toEqual([])
  })

  it('treats a policy that throws as a rejection', async () => {
    const { deps, decisions } = makeDeps(asksToWrite)
    await createSylor(
      {
        permissionMode: 'autonomous',
        canUseTool: () => {
          throw new Error('policy service down')
        }
      },
      deps
    ).run('write it')
    // A broken policy must never be read as consent — not even in autonomous.
    expect(decisions).toEqual([{ toolId: 'tool-1', decision: 'reject' }])
  })
})

describe('createSylor — cancellation', () => {
  it('cancels the run when the consumer stops iterating early', async () => {
    const { deps, cancelled } = makeDeps(async (emit, runId) => {
      emit({ type: 'delta', runId, text: 'one' })
      emit({ type: 'delta', runId, text: 'two' })
      await new Promise((r) => setTimeout(r, 0))
      emit({ type: 'done', runId })
    })
    for await (const event of createSylor({}, deps).stream('hi')) {
      if (event.type === 'delta') break
    }
    expect(cancelled).toEqual(['run-1'])
  })

  it('cancels on an abort signal', async () => {
    const controller = new AbortController()
    const { deps, cancelled } = makeDeps(async (emit, runId) => {
      emit({ type: 'delta', runId, text: 'working' })
      controller.abort()
      await new Promise((r) => setTimeout(r, 0))
      emit({ type: 'done', runId })
    })
    await createSylor({ signal: controller.signal }, deps).run('hi')
    expect(cancelled).toContain('run-1')
  })

  it('cancels immediately when handed an already-aborted signal', async () => {
    const { deps, cancelled } = makeDeps(simpleRun)
    await createSylor({ signal: AbortSignal.abort() }, deps).run('hi')
    expect(cancelled).toContain('run-1')
  })

  it('cancels a named run on request', () => {
    const { deps, cancelled } = makeDeps(simpleRun)
    createSylor({}, deps).cancel('run-42')
    expect(cancelled).toEqual(['run-42'])
  })
})

describe('createSylor — sessions', () => {
  const echo = (emit: (event: WorkflowEvent) => void, runId: string): void => {
    emit({ type: 'delta', runId, text: `reply ${runId}` })
    emit({ type: 'done', runId })
  }

  it('carries the transcript across turns', async () => {
    const { deps, requests } = makeDeps(echo)
    const session = createSylor({}, deps).session()

    await session.send('first')
    await session.send('second')

    expect(requests[0].messages).toEqual([{ role: 'user', content: 'first' }])
    expect(requests[1].messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply run-1' },
      { role: 'user', content: 'second' }
    ])
    expect(session.messages).toHaveLength(4)
  })

  it('seeds from a supplied history and forgets it on reset', async () => {
    const { deps, requests } = makeDeps(echo)
    const session = createSylor({}, deps).session([{ role: 'system', content: 'be brief' }])
    await session.send('hi')
    expect(requests[0].messages[0]).toEqual({ role: 'system', content: 'be brief' })

    session.reset()
    expect(session.messages).toEqual([])
    await session.send('again')
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'again' }])
  })

  it('does not record an empty reply from an interrupted turn', async () => {
    const { deps } = makeDeps((emit, runId) => {
      emit({ type: 'error', runId, message: 'aborted' })
    })
    const session = createSylor({}, deps).session()
    const result = await session.send('hi')
    expect(result.ok).toBe(false)
    // The user turn is kept (it happened); a blank assistant turn is not.
    expect(session.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('records the reply after a streamed turn too', async () => {
    const { deps } = makeDeps(echo)
    const session = createSylor({}, deps).session()
    for await (const event of session.stream('hi')) void event
    expect(session.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply run-1' }
    ])
  })
})
