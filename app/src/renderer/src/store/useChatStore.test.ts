import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from './useChatStore'
import { useAppStore } from './useAppStore'
import type { PersistedSession, TaskNode, TaskState, WorkflowEvent } from '@shared/types'

/** A freshly-loaded, empty session bound to `id` (sets the store's sessionId). */
function loadedSession(id: string): PersistedSession {
  return {
    session: {
      id,
      title: 'S',
      projectRoot: '/test',
      projectId: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0
    },
    messages: [],
    tools: [],
    terminal: [],
    attachments: []
  }
}

describe('useChatStore hydration', () => {
  it('mints ids that never collide with rehydrated ones (per-run salt)', () => {
    // Simulate loading a session that had msg-5, msg-8 and run-3.
    const loaded: PersistedSession = {
      session: {
        id: 'sess-test',
        title: 'Restored',
        projectRoot: '/test',
        projectId: null,
        createdAt: 0,
        updatedAt: 0,
        messageCount: 2
      },
      messages: [
        { id: 'msg-5', role: 'user', content: 'first' },
        { id: 'msg-8', role: 'assistant', content: 'second' }
      ],
      tools: [
        {
          id: 'tool-1',
          afterMessageId: 'msg-8',
          runId: 'run-3',
          auto: false,
          proposal: { id: 'tool-1', kind: 'run_command', command: 'ls' }
        }
      ],
      terminal: [],
      attachments: []
    }

    // Each read re-fetches getState() — the snapshot is replaced on every mutation.
    useChatStore.getState().applyLoaded(loaded)

    // The store should have 2 messages.
    expect(useChatStore.getState().messages).toHaveLength(2)
    expect(useChatStore.getState().messages[0].id).toBe('msg-5')
    expect(useChatStore.getState().messages[1].id).toBe('msg-8')

    // Now send a new message (which internally mints a new user + assistant id).
    // The whole point of the per-run salt: these ids must never reuse a restored
    // one — a bare `msg-<n>` counter resets each launch and would remint msg-5/
    // msg-8, whose DB rows (the primary key) belong to an already-saved turn, so
    // the new write would overwrite that row instead of inserting a new one.
    useChatStore.getState().send('test')
    const after = useChatStore.getState().messages
    expect(after).toHaveLength(4) // 2 old + 2 new
    const newUserMsg = after[2]
    const newAssistantMsg = after[3]

    // Salted shape (`msg-<salt>-<n>`), not the bare collision-prone `msg-<n>`.
    expect(newUserMsg.id).toMatch(/^msg-.+-\d+$/)
    expect(newUserMsg.id).not.toMatch(/^msg-\d+$/)
    expect(newAssistantMsg.id).toMatch(/^msg-.+-\d+$/)

    // Collide with neither the restored ids nor each other.
    const restored = ['msg-5', 'msg-8']
    expect(restored).not.toContain(newUserMsg.id)
    expect(restored).not.toContain(newAssistantMsg.id)
    expect(newUserMsg.id).not.toBe(newAssistantMsg.id)

    // The runId is salted the same way, so it can't reuse the restored run-3.
    const newRunId = useChatStore.getState().runId
    expect(newRunId).toMatch(/^run-.+-\d+$/)
    expect(newRunId).not.toBe('run-3')
  })
})

/**
 * Durability of the assistant turn (regression for "all data lost on reopen").
 *
 * Tool ops were always saved the instant each completed, but the assistant's
 * prose was written only once, on `done`. A run interrupted before it finished —
 * app reopened, new session started, crash — therefore lost the entire reply
 * while its tool ops survived, so the reloaded session looked wiped. The fix
 * persists the assistant row up-front and checkpoints the streaming prose.
 */
describe('useChatStore assistant persistence', () => {
  it('persists the assistant row up-front, not only on done', () => {
    useChatStore.getState().applyLoaded(loadedSession('sess-persist-1'))

    const appendMessage = window.sylor.sessions.appendMessage as unknown as ReturnType<typeof vi.fn>
    appendMessage.mockClear()

    useChatStore.getState().send('hi')

    // Both the user turn AND an assistant turn are persisted immediately — before
    // any streaming or `done` — so an interruption can't orphan the reply.
    const persisted = appendMessage.mock.calls.map((c) => c[1] as { id: string; role: string })
    const assistantId = useChatStore.getState().messages.at(-1)!.id
    expect(persisted.some((m) => m.role === 'user')).toBe(true)
    expect(persisted.some((m) => m.role === 'assistant' && m.id === assistantId)).toBe(true)
  })

  it('checkpoints streamed prose before done, so an interrupted run keeps its reply', () => {
    vi.useFakeTimers()
    try {
      let capturedOnEvent: ((e: WorkflowEvent) => void) | null = null
      const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
      runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
        capturedOnEvent = cb as (e: WorkflowEvent) => void
        return () => {}
      })

      useChatStore.getState().applyLoaded(loadedSession('sess-persist-2'))
      useChatStore.getState().send('question')
      const assistantId = useChatStore.getState().messages.at(-1)!.id

      const appendMessage = window.sylor.sessions.appendMessage as unknown as ReturnType<
        typeof vi.fn
      >
      appendMessage.mockClear()

      // Stream prose, then let the flush timer fire — with NO `done` event, i.e.
      // the run is interrupted. The prose must already be on disk by then.
      capturedOnEvent!({ type: 'delta', runId: 'run-x', text: 'streamed answer' })
      vi.advanceTimersByTime(DELTA_FLUSH_INTERVAL_MS)

      const call = appendMessage.mock.calls.find((c) => (c[1] as { id: string }).id === assistantId)
      expect(call).toBeDefined()
      expect((call?.[1] as { content: string }).content).toBe('streamed answer')
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists the partial reply when the run is cancelled (Stop)', () => {
    let capturedOnEvent: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      capturedOnEvent = cb as (e: WorkflowEvent) => void
      return () => {}
    })

    useChatStore.getState().applyLoaded(loadedSession('sess-persist-3'))
    useChatStore.getState().send('question')
    const assistantId = useChatStore.getState().messages.at(-1)!.id

    const appendMessage = window.sylor.sessions.appendMessage as unknown as ReturnType<typeof vi.fn>
    appendMessage.mockClear()

    // A delta arrives but is still buffered (its flush timer hasn't fired) when the
    // user hits Stop. The engine emits no `done` for a cancel, so disposeRun must
    // fold the buffer in and save the partial reply itself.
    capturedOnEvent!({ type: 'delta', runId: 'run-x', text: 'half-written' })
    useChatStore.getState().cancel()

    const call = appendMessage.mock.calls.find((c) => (c[1] as { id: string }).id === assistantId)
    expect(call).toBeDefined()
    expect((call?.[1] as { content: string }).content).toBe('half-written')
  })
})

/**
 * Background runs must stay *visible* while they work.
 *
 * A run started in one chat keeps going when the user opens another (the store
 * tracks runs by owner session, not by what's on screen) — but nothing in the UI
 * said so, so opening a New Chat mid-task looked exactly like the old task had
 * been paused or thrown away. `liveSessionIds` is the reactive mirror the rail
 * reads to badge those chats.
 */
describe('useChatStore background run visibility', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string, prompt = 'long task'): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send(prompt)
    return captured!
  }

  it('still lists a run as live after a New Chat, and clears it on done', () => {
    const emit = startRunIn('sess-bg-1')
    const runId = useChatStore.getState().runId!
    expect(useChatStore.getState().liveSessionIds).toContain('sess-bg-1')

    // New Chat. The run must survive the switch and stay listed, while the fresh
    // conversation itself reports idle.
    useChatStore.getState().resetTo('sess-bg-2')
    expect(useChatStore.getState().running).toBe(false)
    expect(useChatStore.getState().liveSessionIds).toContain('sess-bg-1')

    // It finishes in the background — the badge clears without the user going back.
    emit({ type: 'done', runId })
    expect(useChatStore.getState().liveSessionIds).not.toContain('sess-bg-1')
  })

  it('cancelSession stops only the named chat, leaving the on-screen run alone', () => {
    // Two live runs: one in the chat about to be deleted, one currently visible.
    startRunIn('sess-doomed')
    startRunIn('sess-visible')
    expect(useChatStore.getState().liveSessionIds).toEqual(
      expect.arrayContaining(['sess-doomed', 'sess-visible'])
    )
    expect(useChatStore.getState().running).toBe(true)

    useChatStore.getState().cancelSession('sess-doomed')

    expect(useChatStore.getState().liveSessionIds).not.toContain('sess-doomed')
    // The visible run is untouched — disposeRun's fallback must not have fired.
    expect(useChatStore.getState().liveSessionIds).toContain('sess-visible')
    expect(useChatStore.getState().running).toBe(true)
  })

  it('cancelSession is a no-op for a chat with no run', () => {
    startRunIn('sess-solo')
    expect(useChatStore.getState().running).toBe(true)

    // The dangerous case: an id that owns nothing must not fall through to the
    // visible run's disposer and kill the task the user is watching.
    useChatStore.getState().cancelSession('sess-never-ran')

    expect(useChatStore.getState().liveSessionIds).toContain('sess-solo')
    expect(useChatStore.getState().running).toBe(true)
  })
})

/** Comfortably exceeds useChatStore's DELTA_FLUSH_MS (66) so the flush timer fires. */
const DELTA_FLUSH_INTERVAL_MS = 200

/**
 * Folder pinning (Problem 2, run side). `loadInto` re-points the active root to
 * the open chat's folder before a send is possible; `startRun` snapshots that
 * root into the run request so the engine can wrap the whole run in
 * `runWithRoot(root)` — keeping reads/writes on this chat's folder even if the
 * user opens a different conversation (and root) while the run is in flight.
 */
describe('useChatStore run payload — folder pinning (Problem 2)', () => {
  /** Capture the WorkflowRunRequest the store hands the main process on the next run. */
  function captureRunInput(): () => Record<string, unknown> | null {
    let input: Record<string, unknown> | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((i: unknown) => {
      input = i as Record<string, unknown>
      return () => {}
    })
    return () => input
  }

  afterEach(() => {
    // Don't leak the active folder into unrelated tests in this file.
    useAppStore.setState({ workspaceRoot: null })
  })

  it('pins the run to the active folder (root travels in the payload)', () => {
    useAppStore.setState({ workspaceRoot: '/training' })
    const input = captureRunInput()

    useChatStore.getState().applyLoaded(loadedSession('sess-root-1'))
    useChatStore.getState().send('build a sign up page')

    expect(input()?.root).toBe('/training')
  })

  it('omits root when no folder is active (Cowork / unset)', () => {
    useAppStore.setState({ workspaceRoot: null })
    const input = captureRunInput()

    useChatStore.getState().applyLoaded(loadedSession('sess-root-2'))
    useChatStore.getState().send('just chatting')

    const payload = input()
    expect(payload && 'root' in payload).toBe(false)
  })
})

/**
 * §33 — the status row has to be able to say where the WHOLE build stands: which
 * phase of how many, how far through that phase's tasks, whether the project's
 * checks passed, and what the preview is really showing.
 *
 * The engine sends `progress` only when it changes, so the store keeps it sticky
 * in a field of its own. That placement is the point of these tests: `status` is
 * replaced wholesale several times a second (every status, tool-request and
 * agent-start), so anything living inside it would be wiped within a step or two.
 */
describe('useChatStore build progress (§33)', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('build the dashboard')
    return captured!
  }

  const node = (id: string, state: TaskState): TaskNode => ({
    id,
    role: 'builder',
    description: `task ${id}`,
    dependsOn: [],
    state,
    attempts: 0
  })

  it('merges each progress over the last, so the checks never erase the phase', () => {
    const emit = startRunIn('sess-prog-1')
    const runId = useChatStore.getState().runId!

    emit({
      type: 'status',
      runId,
      stage: 'planning',
      message: 'Phase 3 of 9 — Core flow.',
      progress: { phase: { n: 3, total: 9, name: 'Core flow' }, preview: 'RUNNING' }
    })
    expect(useChatStore.getState().progress).toEqual({
      phase: { n: 3, total: 9, name: 'Core flow' },
      preview: 'RUNNING'
    })

    // The verify emit reports the checks. It must not blank the phase.
    emit({
      type: 'status',
      runId,
      stage: 'verifying',
      message: 'Recording progress…',
      progress: { checks: 'FAILING', preview: 'COMPILE_ERROR' }
    })
    expect(useChatStore.getState().progress).toEqual({
      phase: { n: 3, total: 9, name: 'Core flow' },
      checks: 'FAILING',
      preview: 'COMPILE_ERROR'
    })
  })

  it('holds the progress through the events that carry none', () => {
    const emit = startRunIn('sess-prog-2')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'status',
      runId,
      stage: 'planning',
      message: 'Phase 1 of 3 — Foundation.',
      progress: { phase: { n: 1, total: 3, name: 'Foundation' }, checks: 'PASSING' }
    })

    // Exactly the events that overwrite `status`: a plain status line, a file op,
    // and a subagent starting. Each used to be the end of the progress chips.
    emit({ type: 'status', runId, stage: 'generating', message: 'Writing the layout…' })
    emit({
      type: 'tool-request',
      runId,
      proposal: { id: 'tool-prog-1', kind: 'run_command', command: 'ls' },
      auto: true
    })
    emit({ type: 'agent-start', runId, agentId: 'a1', role: 'builder', task: 'the layout' })

    expect(useChatStore.getState().status?.message).toBe('Working…')
    expect(useChatStore.getState().progress).toEqual({
      phase: { n: 1, total: 3, name: 'Foundation' },
      checks: 'PASSING'
    })
  })

  it('counts the phase’s tasks from the plan and its updates', () => {
    const emit = startRunIn('sess-prog-3')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'status',
      runId,
      stage: 'planning',
      message: 'Phase 2 of 5 — Core.',
      progress: { phase: { n: 2, total: 5, name: 'Core' } }
    })
    emit({
      type: 'plan',
      runId,
      complexity: 'medium',
      tasks: [node('t1', 'ready'), node('t2', 'pending'), node('t3', 'pending')]
    })
    expect(useChatStore.getState().progress?.tasks).toEqual({ done: 0, total: 3 })

    emit({ type: 'task-update', runId, task: node('t1', 'completed') })
    emit({ type: 'task-update', runId, task: node('t2', 'running') })
    expect(useChatStore.getState().progress?.tasks).toEqual({ done: 1, total: 3 })

    // A node that failed is not a node that's done — the counter stays short, so
    // the row can't read as finished when it isn't (§34).
    emit({ type: 'task-update', runId, task: node('t2', 'failed') })
    expect(useChatStore.getState().progress).toMatchObject({
      phase: { n: 2, total: 5, name: 'Core' },
      tasks: { done: 1, total: 3 }
    })
  })

  it('reports no counter for a one-node turn, and nothing at all for a one-off', () => {
    const emit = startRunIn('sess-prog-4')
    const runId = useChatStore.getState().runId!
    // A SIMPLE turn: one synthesized node, no roadmap behind it. "1/1 tasks" is
    // noise on a one-file edit, and a plain edit must keep the plain status row.
    emit({ type: 'plan', runId, complexity: 'simple', tasks: [node('t1', 'ready')] })
    emit({ type: 'status', runId, stage: 'generating', message: 'Editing App.tsx…' })
    expect(useChatStore.getState().progress).toBeNull()
  })

  it('clears the progress when the run ends', () => {
    const emit = startRunIn('sess-prog-5')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'status',
      runId,
      stage: 'verifying',
      message: 'Final phase complete.',
      progress: { phase: { n: 3, total: 3, name: 'Verification' }, checks: 'PASSING' }
    })
    expect(useChatStore.getState().progress).not.toBeNull()

    emit({ type: 'done', runId })
    expect(useChatStore.getState().progress).toBeNull()
  })
})

