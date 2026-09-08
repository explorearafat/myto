import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from './useChatStore'
import { useAppStore } from './useAppStore'
import type {
  AgentRole,
  CheckpointInfo,
  ContextUsage,
  PersistedSession,
  TaskNode,
  TaskState,
  WorkflowEvent
} from '@shared/types'

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

  it('puts what a file is FOR in the live status row', () => {
    // "Creating Button.tsx" says what is happening; the purpose says why. When the
    // block carries one, the row it drives says both.
    const emit = startRunIn('sess-prog-6')
    const runId = useChatStore.getState().runId!
    const write = {
      id: 'tool-purpose-1',
      kind: 'write_file' as const,
      path: 'src/components/Button.tsx',
      oldContent: '',
      newContent: 'x',
      exists: false
    }

    emit({ type: 'tool-request', runId, proposal: write, auto: true })
    expect(useChatStore.getState().status?.message).toBe('Creating Button.tsx')

    emit({
      type: 'tool-request',
      runId,
      proposal: { ...write, id: 'tool-purpose-2', purpose: 'the shared button every page uses' },
      auto: true
    })
    expect(useChatStore.getState().status?.message).toBe(
      'Creating Button.tsx · the shared button every page uses'
    )
  })

  it('says it is waiting on the user while a gated op sits unanswered', () => {
    // The sticky row is the only line always on screen. An op that needs approval
    // is not happening yet, so the row must not read as work in flight — otherwise
    // a run blocked on a dialog looks identical to a run that is busy.
    const emit = startRunIn('sess-prog-7')
    const runId = useChatStore.getState().runId!
    const write = {
      id: 'tool-gate-1',
      kind: 'write_file' as const,
      path: 'plan.md',
      oldContent: '',
      newContent: 'x',
      exists: false
    }

    emit({ type: 'tool-request', runId, proposal: write, auto: false })
    expect(useChatStore.getState().status?.message).toBe('Waiting for your go-ahead · Creating plan.md')
    // The trace keeps the plain description — the waiting is a live state, not a
    // step worth a line in the history of what was done.
    expect(useChatStore.getState().activity.at(-1)?.message).toBe('Creating plan.md')

    // Answered: the op is under way, so the row stops asking.
    useChatStore.getState().decideTool('tool-gate-1', 'approve')
    expect(useChatStore.getState().status?.message).toBe('Creating plan.md')
  })

  it('drops the waiting line when the op is refused, not just when it is approved', () => {
    const emit = startRunIn('sess-prog-8')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'tool-request',
      runId,
      proposal: { id: 'tool-gate-2', kind: 'run_command', command: 'rm -rf build' },
      auto: false
    })
    expect(useChatStore.getState().status?.message).toBe(
      'Waiting for your go-ahead · Running rm -rf build'
    )

    useChatStore.getState().decideTool('tool-gate-2', 'reject')
    // Refused is not running — the row swings to what is actually happening (the
    // model being told no and picking another route), not to the opposite lie.
    expect(useChatStore.getState().status?.message).toBe('Skipped that — deciding what to do next')
  })

  it('answers the ops already waiting under an "Always" grant, and records a plain approve', () => {
    const emit = startRunIn('sess-prog-9')
    const runId = useChatStore.getState().runId!
    const w = (id: string, path: string) => ({
      id,
      kind: 'write_file' as const,
      path,
      oldContent: '',
      newContent: 'x',
      exists: false
    })
    emit({ type: 'tool-request', runId, proposal: w('t-a', 'a.ts'), auto: false })
    emit({ type: 'tool-request', runId, proposal: w('t-b', 'b.ts'), auto: false })
    emit({
      type: 'tool-request',
      runId,
      proposal: { id: 't-c', kind: 'run_command', command: 'npm test' },
      auto: false
    })

    const decide = window.sylor.workflow.toolDecision as unknown as ReturnType<typeof vi.fn>
    decide.mockClear()
    useChatStore.getState().decideTool('t-a', 'approve-always')

    // The escalation rides the clicked op; the write already waiting is answered as a
    // plain approval, because leaving it in the bar would keep asking about exactly
    // what the user just said to stop asking about. The command is a different grant,
    // so it stays waiting. The clicked op carries the (here absent) decision detail;
    // the siblings deliberately carry none — an edited body belongs to one proposal.
    expect(decide.mock.calls).toEqual([
      [runId, 't-a', 'approve-always', undefined],
      [runId, 't-b', 'approve']
    ])
    const byId = (id: string) => useChatStore.getState().tools.find((t) => t.id === id)!
    // 'approve-always' is a run-scoped policy, not a property of the op — what is
    // recorded (and later persisted) is the plain verb.
    expect(byId('t-a')).toMatchObject({ status: 'running', decision: 'approve' })
    expect(byId('t-b')).toMatchObject({ status: 'running', decision: 'approve' })
    expect(byId('t-c').status).toBe('awaiting')
    // …and the grant is now visible as a chip, which is the only thing standing
    // between "it stopped asking" and "it went quiet".
    expect(useChatStore.getState().standing).toEqual(['write_file'])
  })

  it('withdraws a standing grant, so the class starts being asked about again', () => {
    const emit = startRunIn('sess-prog-9b')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'tool-request',
      runId,
      proposal: { id: 't-cmd', kind: 'run_command', command: 'npm test' },
      auto: false
    })
    useChatStore.getState().decideTool('t-cmd', 'approve-always')
    expect(useChatStore.getState().standing).toEqual(['run_command:npm test'])

    const revoke = window.sylor.workflow.revokeApproval as unknown as ReturnType<typeof vi.fn>
    revoke.mockClear()
    useChatStore.getState().revokeStanding('run_command:npm test')
    expect(revoke).toHaveBeenCalledWith(runId, 'run_command:npm test')
    expect(useChatStore.getState().standing).toEqual([])
    // A key that isn't in force is not forwarded: the engine would ignore it anyway,
    // and sending it would imply the UI can revoke grants it never saw.
    revoke.mockClear()
    useChatStore.getState().revokeStanding('write_file')
    expect(revoke).not.toHaveBeenCalled()
  })

  it('sends the edited body with an approval and keeps THAT diff on the card', () => {
    const emit = startRunIn('sess-prog-9c')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'tool-request',
      runId,
      proposal: {
        id: 't-edit',
        kind: 'write_file',
        path: 'a.ts',
        oldContent: 'old',
        newContent: 'model version',
        exists: true
      },
      auto: false
    })

    const decide = window.sylor.workflow.toolDecision as unknown as ReturnType<typeof vi.fn>
    decide.mockClear()
    useChatStore
      .getState()
      .decideTool('t-edit', 'approve', { editedContent: 'my version' })
    expect(decide).toHaveBeenCalledWith(runId, 't-edit', 'approve', {
      editedContent: 'my version'
    })

    // The card now holds the bytes that are actually going to disk, flagged as the
    // user's — so the diff they scroll back to later is the one that happened.
    const card = useChatStore.getState().tools.find((t) => t.id === 't-edit')!
    expect(card.edited).toBe(true)
    expect(card.proposal).toMatchObject({ kind: 'write_file', newContent: 'my version' })
  })

  it('forwards a rejection reason and never marks an unchanged body as edited', () => {
    const emit = startRunIn('sess-prog-9d')
    const runId = useChatStore.getState().runId!
    emit({
      type: 'tool-request',
      runId,
      proposal: {
        id: 't-no',
        kind: 'write_file',
        path: 'b.ts',
        oldContent: '',
        newContent: 'same',
        exists: false
      },
      auto: false
    })

    const decide = window.sylor.workflow.toolDecision as unknown as ReturnType<typeof vi.fn>
    decide.mockClear()
    // The editor was opened and closed without a change, so no `editedContent` claim
    // is made — "the user edited this" has to mean they actually did.
    useChatStore
      .getState()
      .decideTool('t-no', 'reject', { editedContent: 'same', reason: 'wrong folder' })
    expect(decide).toHaveBeenCalledWith(runId, 't-no', 'reject', {
      editedContent: 'same',
      reason: 'wrong folder'
    })
    const card = useChatStore.getState().tools.find((t) => t.id === 't-no')!
    expect(card.edited).toBeUndefined()
    expect(card.proposal).toMatchObject({ newContent: 'same' })
  })

  it('marks one lane as stopping and leaves the others (and the run) alone', () => {
    const emit = startRunIn('sess-prog-9e')
    const runId = useChatStore.getState().runId!
    const spawn = (agentId: string, role: AgentRole): void =>
      emit({ type: 'agent-start', runId, agentId, role, task: `${role} work` })
    spawn('ag-1', 'builder')
    spawn('ag-2', 'reviewer')

    const cancel = window.sylor.workflow.cancelAgent as unknown as ReturnType<typeof vi.fn>
    cancel.mockClear()
    useChatStore.getState().cancelAgent('ag-1')
    expect(cancel).toHaveBeenCalledWith(runId, 'ag-1')

    const lane = (id: string) => useChatStore.getState().agents.find((a) => a.agentId === id)!
    // "Stopping…", not "stopped": the engine still owns the closing event, and the
    // gap while it unwinds is real.
    expect(lane('ag-1')).toMatchObject({ status: 'running', cancelling: true })
    expect(lane('ag-2').cancelling).toBeUndefined()
    expect(useChatStore.getState().running).toBe(true)

    // Asking twice sends once — the lane is already on its way out.
    cancel.mockClear()
    useChatStore.getState().cancelAgent('ag-1')
    expect(cancel).not.toHaveBeenCalled()

    // The engine's own `agent-end` is what actually closes it, and it clears the flag.
    emit({
      type: 'agent-end',
      runId,
      agentId: 'ag-1',
      role: 'builder',
      ok: false,
      report: 'Cancelled by you'
    })
    expect(lane('ag-1')).toMatchObject({ status: 'complete', cancelling: false, ok: false })
    expect(useChatStore.getState().running).toBe(true)
  })
})

describe('useChatStore live checklist (#4)', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('add a logout button')
    return captured!
  }

  it('mirrors an update_todos event into the view, then replaces it wholesale', () => {
    const emit = startRunIn('sess-todo-1')
    const runId = useChatStore.getState().runId!

    emit({
      type: 'todos',
      runId,
      todos: [
        { text: 'Add the route', status: 'in_progress' },
        { text: 'Wire the button', status: 'pending' }
      ]
    })
    expect(useChatStore.getState().todos).toEqual([
      { text: 'Add the route', status: 'in_progress' },
      { text: 'Wire the button', status: 'pending' }
    ])

    // The model always re-sends the WHOLE list, so a later event replaces — never
    // merges with — the previous one.
    emit({ type: 'todos', runId, todos: [{ text: 'Add the route', status: 'completed' }] })
    expect(useChatStore.getState().todos).toEqual([{ text: 'Add the route', status: 'completed' }])
  })

  it('clears the checklist when the run ends', () => {
    const emit = startRunIn('sess-todo-2')
    const runId = useChatStore.getState().runId!
    emit({ type: 'todos', runId, todos: [{ text: 'Do a thing', status: 'pending' }] })
    expect(useChatStore.getState().todos).toHaveLength(1)

    emit({ type: 'done', runId })
    expect(useChatStore.getState().todos).toEqual([])
  })
})

describe('useChatStore clarifying question (#1)', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('build a login page')
    return captured!
  }

  it('records a question event, then clears it when the run ends', () => {
    const emit = startRunIn('sess-q-1')
    const runId = useChatStore.getState().runId!

    emit({
      type: 'question',
      runId,
      question: {
        id: 'q-1',
        question: 'Which auth?',
        header: 'Auth method',
        options: ['Email', 'Google']
      }
    })
    expect(useChatStore.getState().question).toEqual({
      id: 'q-1',
      question: 'Which auth?',
      header: 'Auth method',
      options: ['Email', 'Google']
    })

    emit({ type: 'done', runId })
    expect(useChatStore.getState().question).toBeNull()
  })

  it('answerQuestion sends the answer over IPC and clears the pending question', () => {
    const emit = startRunIn('sess-q-2')
    const runId = useChatStore.getState().runId!
    const answerMock = window.sylor.workflow.answerQuestion as unknown as ReturnType<typeof vi.fn>
    answerMock.mockClear()

    emit({ type: 'question', runId, question: { id: 'q-42', question: 'Ship it?' } })
    expect(useChatStore.getState().question).not.toBeNull()

    useChatStore.getState().answerQuestion('yes, ship it')
    expect(answerMock).toHaveBeenCalledWith(runId, 'q-42', 'yes, ship it')
    // The run resumes: the pending question is gone from the view.
    expect(useChatStore.getState().question).toBeNull()
  })

  it('answerQuestion is a no-op when nothing is waiting', () => {
    startRunIn('sess-q-3')
    const answerMock = window.sylor.workflow.answerQuestion as unknown as ReturnType<typeof vi.fn>
    answerMock.mockClear()
    expect(useChatStore.getState().question).toBeNull()

    useChatStore.getState().answerQuestion('hello?')
    expect(answerMock).not.toHaveBeenCalled()
  })
})

/**
 * The "Plan first" approval checkpoint (#2).
 *
 * A plan is a proposed action like any other, so it is answered over the ordinary
 * tool-decision channel — no second answer-back path to keep in sync.
 */
describe('useChatStore plan approval (#2)', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('build a login page')
    return captured!
  }

  const APPROVAL = {
    id: 'plan-1',
    complexity: 'complex' as const,
    steps: ['Backend Engineer: the API', 'Frontend Engineer: the form'],
    planPath: 'plan.md'
  }

  it('records a plan-approval event, then clears it when the run ends', () => {
    const emit = startRunIn('sess-p-1')
    const runId = useChatStore.getState().runId!

    emit({ type: 'plan-approval', runId, approval: APPROVAL })
    expect(useChatStore.getState().planApproval).toEqual(APPROVAL)

    emit({ type: 'done', runId })
    expect(useChatStore.getState().planApproval).toBeNull()
  })

  it('an approve rides the tool-decision channel and the row says building', () => {
    const emit = startRunIn('sess-p-2')
    const runId = useChatStore.getState().runId!
    const decide = window.sylor.workflow.toolDecision as unknown as ReturnType<typeof vi.fn>
    decide.mockClear()

    emit({ type: 'plan-approval', runId, approval: APPROVAL })
    useChatStore.getState().decidePlan('approve')

    expect(decide).toHaveBeenCalledWith(runId, 'plan-1', 'approve')
    expect(useChatStore.getState().planApproval).toBeNull()
    expect(useChatStore.getState().status?.message).toBe('Building the plan…')
  })

  it('a reject says nothing was built', () => {
    const emit = startRunIn('sess-p-3')
    const runId = useChatStore.getState().runId!
    const decide = window.sylor.workflow.toolDecision as unknown as ReturnType<typeof vi.fn>
    decide.mockClear()

    emit({ type: 'plan-approval', runId, approval: APPROVAL })
    useChatStore.getState().decidePlan('reject')

    expect(decide).toHaveBeenCalledWith(runId, 'plan-1', 'reject')
    expect(useChatStore.getState().planApproval).toBeNull()
    expect(useChatStore.getState().status?.message).toBe('Plan not approved — nothing was built')
  })

  it('decidePlan is a no-op when no plan is waiting', () => {
    startRunIn('sess-p-4')
    const decide = window.sylor.workflow.toolDecision as unknown as ReturnType<typeof vi.fn>
    decide.mockClear()
    expect(useChatStore.getState().planApproval).toBeNull()

    useChatStore.getState().decidePlan('approve')
    expect(decide).not.toHaveBeenCalled()
  })

  it('keeps each session’s pending plan on its own run', () => {
    // Two runs alive at once: switching sessions must show the right one's plan,
    // and answering must never leak across.
    const emitA = startRunIn('sess-p-5')
    const runA = useChatStore.getState().runId!
    emitA({ type: 'plan-approval', runId: runA, approval: APPROVAL })

    const emitB = startRunIn('sess-p-6')
    const runB = useChatStore.getState().runId!
    expect(useChatStore.getState().planApproval).toBeNull()
    emitB({ type: 'plan-approval', runId: runB, approval: { ...APPROVAL, id: 'plan-2' } })
    expect(useChatStore.getState().planApproval?.id).toBe('plan-2')

    // Back to the first session: its own plan is still waiting.
    useChatStore.getState().applyLoaded(loadedSession('sess-p-5'))
    expect(useChatStore.getState().planApproval?.id).toBe('plan-1')
  })
})

/**
 * Flagged follow-ups (#5).
 *
 * These are the one piece of live run state that must OUTLIVE its turn: the user
 * reads the answer and only then decides whether to act on a deferred finding, so
 * `done` must not sweep the chips away. One rule governs the lifetime — cleared when
 * the conversation moves on (a send, a regenerate, a clear, a session switch), never
 * when a turn merely ends.
 */
describe('useChatStore flagged follow-ups (#5)', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('add a logout button')
    return captured!
  }

  const FLAG = {
    id: 'fu-1',
    title: 'Fix the stale README badge',
    note: 'It points at the old CI workflow name.',
    files: ['README.md'],
    recordedIn: '.sylor/FOLLOWUPS.md'
  }

  it('appends each flag rather than replacing the list', () => {
    const emit = startRunIn('sess-fu-1')
    const runId = useChatStore.getState().runId!

    emit({ type: 'followup', runId, followup: FLAG })
    emit({ type: 'followup', runId, followup: { id: 'fu-2', title: 'Drop the dead flag' } })

    expect(useChatStore.getState().followups.map((f) => f.id)).toEqual(['fu-1', 'fu-2'])
    expect(useChatStore.getState().followups[0]).toEqual(FLAG)
  })

  it('survives the end of the run — that is the whole point', () => {
    const emit = startRunIn('sess-fu-2')
    const runId = useChatStore.getState().runId!
    emit({ type: 'followup', runId, followup: FLAG })

    emit({ type: 'done', runId })
    expect(useChatStore.getState().running).toBe(false)
    // Unlike the checklist and the question, the chips are still there to act on.
    expect(useChatStore.getState().todos).toEqual([])
    expect(useChatStore.getState().followups).toHaveLength(1)
  })

  it('is cleared by the next send', () => {
    const emit = startRunIn('sess-fu-3')
    const runId = useChatStore.getState().runId!
    emit({ type: 'followup', runId, followup: FLAG })
    emit({ type: 'done', runId })

    useChatStore.getState().send('now do the next thing')
    expect(useChatStore.getState().followups).toEqual([])
  })

  it('is cleared by clear()', () => {
    const emit = startRunIn('sess-fu-4')
    const runId = useChatStore.getState().runId!
    emit({ type: 'followup', runId, followup: FLAG })
    useChatStore.getState().clear()
    expect(useChatStore.getState().followups).toEqual([])
  })

  it('dismisses one chip by id and leaves the rest', () => {
    const emit = startRunIn('sess-fu-5')
    const runId = useChatStore.getState().runId!
    emit({ type: 'followup', runId, followup: FLAG })
    emit({ type: 'followup', runId, followup: { id: 'fu-2', title: 'Drop the dead flag' } })

    useChatStore.getState().dismissFollowup('fu-1')
    expect(useChatStore.getState().followups.map((f) => f.id)).toEqual(['fu-2'])
    // A dismissal is dropped from the live run too, so re-opening the session while
    // the run is still going doesn't bring it back.
    useChatStore.getState().applyLoaded(loadedSession('sess-fu-5'))
    expect(useChatStore.getState().followups.map((f) => f.id)).toEqual(['fu-2'])

    // An unknown id changes nothing.
    useChatStore.getState().dismissFollowup('fu-nope')
    expect(useChatStore.getState().followups.map((f) => f.id)).toEqual(['fu-2'])
  })

  it('keeps each session’s flags on its own run', () => {
    const emitA = startRunIn('sess-fu-6')
    const runA = useChatStore.getState().runId!
    emitA({ type: 'followup', runId: runA, followup: FLAG })

    const emitB = startRunIn('sess-fu-7')
    const runB = useChatStore.getState().runId!
    expect(useChatStore.getState().followups).toEqual([])
    emitB({ type: 'followup', runId: runB, followup: { id: 'fu-9', title: 'Other finding' } })
    expect(useChatStore.getState().followups.map((f) => f.id)).toEqual(['fu-9'])

    useChatStore.getState().applyLoaded(loadedSession('sess-fu-6'))
    expect(useChatStore.getState().followups.map((f) => f.id)).toEqual(['fu-1'])
  })
})

/**
 * The typewriter.
 *
 * Prose reaches the store two ways. A model stream arrives as many small deltas
 * and already reads as typing. But the orchestrator's own narration (the opening
 * note, the roadmap summary, the closing report), a document written by a
 * collected completion, and a provider answering without server-sent events each
 * arrive as ONE delta — so a whole paragraph used to appear in a single frame,
 * which is what "the response doesn't type out any more" meant. The flush tick
 * now reveals part of what is queued (see `lib/reveal.ts`), except where a partial
 * reveal would be wrong: a card anchors at the current prose length, and the end
 * of a run must show the complete reply.
 */
describe('useChatStore streamed reveal (typewriter)', () => {
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

  /** The assistant turn's rendered prose. */
  const shown = (): string => useChatStore.getState().messages.at(-1)!.content

  it('types out a block that arrived as a single delta', () => {
    vi.useFakeTimers()
    try {
      const emit = startRunIn('sess-reveal-1')
      const runId = useChatStore.getState().runId!
      const block = 'A'.repeat(600)
      emit({ type: 'delta', runId, text: block })

      // One tick shows a slice, not the paragraph.
      vi.advanceTimersByTime(70)
      const first = shown().length
      expect(first).toBeGreaterThan(0)
      expect(first).toBeLessThan(block.length)

      // The next tick shows more — the reveal keeps itself going with no further
      // delta to trigger it.
      vi.advanceTimersByTime(70)
      expect(shown().length).toBeGreaterThan(first)

      // And it gets all the way there.
      vi.advanceTimersByTime(3000)
      expect(shown()).toBe(block)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a live token stream alone, adding no lag of its own', () => {
    vi.useFakeTimers()
    try {
      const emit = startRunIn('sess-reveal-2')
      const runId = useChatStore.getState().runId!
      // ~15 characters every ~100ms: the measured shape of the real stream.
      for (let i = 1; i <= 6; i++) {
        emit({ type: 'delta', runId, text: 'tokens of text.' })
        vi.advanceTimersByTime(100)
        expect(shown().length, `delta ${i}`).toBe(15 * i)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows every queued character before a tool card anchors to it', () => {
    const emit = startRunIn('sess-reveal-3')
    const runId = useChatStore.getState().runId!
    const block = 'B'.repeat(600)
    // The card's offset is a position in the prose. Anchoring while text is still
    // queued would put the card above narration that was written before it.
    emit({ type: 'delta', runId, text: block })
    emit({
      type: 'tool-request',
      runId,
      proposal: { id: 'tool-reveal-1', kind: 'run_command', command: 'npm run dev' },
      auto: true
    })

    expect(shown()).toBe(block)
    expect(useChatStore.getState().tools.at(-1)?.contentOffset).toBe(block.length)
  })

  it('never finishes a turn with prose still unrevealed', () => {
    const emit = startRunIn('sess-reveal-4')
    const runId = useChatStore.getState().runId!
    const block = 'C'.repeat(2000)
    emit({ type: 'delta', runId, text: block })
    emit({ type: 'done', runId })

    const message = useChatStore.getState().messages.at(-1)!
    expect(message.content).toBe(block)
    expect(message.pending).toBeFalsy()
  })
})

/**
 * The run log trace.
 *
 * `activity` is the single normalized event list the Run Log renders: flat,
 * append-ordered, timestamped from each event's OWN stamp, and attributed to the
 * subagent that caused the row. It is deliberately not a second copy of the tool
 * cards — a row links back by `toolId`/`agentId` — and it deliberately outlives
 * the turn, because the receipts are most useful once the work is done.
 */
describe('useChatStore run log trace', () => {
  /** Start a run in `sessionId` and hand back its event sink. */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('ship the dashboard')
    return captured!
  }

  const trace = (): ReturnType<typeof useChatStore.getState>['activity'] =>
    useChatStore.getState().activity

  const WRITE = {
    id: 'tool-log-1',
    kind: 'write_file' as const,
    path: 'src/App.tsx',
    oldContent: '',
    newContent: 'x',
    exists: false
  }

  it("stamps each row from the event's own clock, not the renderer's", () => {
    const emit = startRunIn('sess-log-1')
    const runId = useChatStore.getState().runId!

    // The engine stamps every event in one sink (workflow-ipc), so a row restored
    // later reports the same instant the live one did. Trusting `Date.now()` here
    // instead would drift by the IPC latency and diverge on reload.
    emit({ type: 'status', runId, stage: 'reading', message: 'Reading files…', at: 1_000 })
    emit({ type: 'tool-request', runId, proposal: WRITE, auto: true, at: 2_500 })

    expect(trace().map((s) => [s.kind, s.at])).toEqual([
      ['phase', 1_000],
      ['tool', 2_500]
    ])
  })

  it('opens a tool row and closes it when the result lands', () => {
    const emit = startRunIn('sess-log-2')
    const runId = useChatStore.getState().runId!

    emit({ type: 'tool-request', runId, proposal: WRITE, auto: true, at: 10 })
    expect(trace().at(-1)).toMatchObject({
      kind: 'tool',
      message: 'Creating App.tsx',
      toolId: 'tool-log-1',
      done: false
    })

    emit({
      type: 'tool-result',
      runId,
      result: { kind: 'write_file', id: 'tool-log-1', ok: true },
      at: 60
    })
    // Closed in place — a result is the SAME step finishing, not a second row.
    expect(trace().filter((s) => s.kind === 'tool')).toHaveLength(1)
    expect(trace().at(-1)?.done).toBe(true)
    // The card carries the timing; the row reads it from there rather than
    // duplicating it, so a restored card and a live one show the same duration.
    expect(useChatStore.getState().tools.at(-1)).toMatchObject({ startedAt: 10, endedAt: 60 })
  })

  it("attributes a subagent's rows to its lane, and closes the lane on its report", () => {
    const emit = startRunIn('sess-log-3')
    const runId = useChatStore.getState().runId!

    emit({
      type: 'agent-start',
      runId,
      agentId: 'ag-1',
      role: 'reviewer',
      task: 'check the diff',
      at: 100
    })
    emit({
      type: 'tool-request',
      runId,
      proposal: { ...WRITE, id: 'tool-log-2' },
      auto: true,
      agentId: 'ag-1',
      at: 120
    })

    // The lane is what makes parallel work readable: every row a subagent caused
    // carries its id AND its role, so the log can filter to one swimlane without
    // consulting the agent cards.
    expect(trace().map((s) => [s.kind, s.agentId, s.agentRole])).toEqual([
      ['agent', 'ag-1', 'reviewer'],
      ['tool', 'ag-1', 'reviewer']
    ])

    emit({
      type: 'agent-end',
      runId,
      agentId: 'ag-1',
      role: 'reviewer',
      ok: false,
      report: 'gave up',
      at: 200
    })
    const lane = trace().find((s) => s.kind === 'agent')!
    // Failure is recorded as `ok: false` — the log renders that calm-amber, and it
    // must not be confused with the row simply being unfinished.
    expect(lane).toMatchObject({ done: true, ok: false })
  })

  it('keeps the trace after the run ends, closing it with an honest last row', () => {
    const emit = startRunIn('sess-log-4')
    const runId = useChatStore.getState().runId!

    emit({ type: 'status', runId, stage: 'generating', message: 'Writing the page…', at: 5 })
    emit({ type: 'done', runId })

    // Clearing it on `done` was the old behaviour and it made the log useless:
    // the receipts vanished at exactly the moment the user went looking for them.
    expect(trace().length).toBeGreaterThan(1)
    expect(trace().at(-1)).toMatchObject({ kind: 'run-end', message: 'Finished', ok: true })
    // The phase it interrupted is closed too — nothing is left spinning forever.
    expect(trace().every((s) => s.done)).toBe(true)
  })

  it('says who stopped a run, and why, in the closing row', () => {
    const emitErr = startRunIn('sess-log-5')
    emitErr({
      type: 'error',
      runId: useChatStore.getState().runId!,
      message: 'provider refused the request'
    })
    expect(trace().at(-1)).toMatchObject({ kind: 'run-end', ok: false })
    expect(trace().at(-1)?.message).toContain('provider refused the request')

    startRunIn('sess-log-6')
    useChatStore.getState().cancel()
    // A cancel carries NO outcome — the user stopping the work makes it neither a
    // success nor a failure, and claiming either would be a guess.
    expect(trace().at(-1)).toMatchObject({
      kind: 'run-end',
      message: 'Stopped by you',
      done: true
    })
    expect(trace().at(-1)?.ok).toBeUndefined()
  })

  it('rebuilds the last run’s trace from disk, and never invents a time for it', () => {
    // Reopening a conversation has only the persisted ops to go on. Ops written
    // before the timing columns existed carry no stamp at all, and `at: 0` is the
    // sentinel the log renders as `--:--:--` rather than as the Unix epoch.
    useChatStore.getState().applyLoaded({
      ...loadedSession('sess-log-7'),
      messages: [{ id: 'm-1', role: 'assistant', content: 'done' }],
      tools: [
        {
          id: 'old-op',
          afterMessageId: 'm-1',
          runId: 'run-old',
          auto: true,
          proposal: { id: 'old-op', kind: 'run_command', command: 'npm ci' }
        },
        {
          id: 'new-op',
          afterMessageId: 'm-1',
          runId: 'run-new',
          auto: true,
          proposal: {
            id: 'new-op',
            kind: 'write_file',
            path: 'src/main.ts',
            oldContent: '',
            newContent: 'y',
            exists: false
          },
          agentId: 'ag-9',
          agentRole: 'builder',
          startedAt: 1_700,
          endedAt: 1_950
        }
      ]
    })

    // Only the most recent run is the trace — older runs are history the thread
    // already shows, and folding them in would make one "run log" of many runs.
    expect(trace()).toHaveLength(1)
    expect(trace()[0]).toMatchObject({
      kind: 'tool',
      toolId: 'new-op',
      at: 1_700,
      agentId: 'ag-9',
      agentRole: 'builder',
      done: true
    })
  })

  it('starts the next turn with a clean trace', () => {
    const emit = startRunIn('sess-log-8')
    emit({ type: 'status', runId: useChatStore.getState().runId!, stage: 'reading', message: 'a…' })
    expect(trace().length).toBeGreaterThan(0)

    startRunIn('sess-log-8')
    // A new send is what clears it: the log answers "what did THIS turn do".
    expect(trace().every((s) => s.kind === 'phase')).toBe(true)
    expect(trace().length).toBeLessThan(3)
  })
})

describe('useChatStore restore points and context meter', () => {
  /**
   * Start a run in `sessionId` and hand back its event sink.
   *
   * Two bits of hygiene the earlier suites don't need: `clear()`, because `send`
   * refuses while a run is live and the block above deliberately leaves one open; and
   * `mockReset()`, because a `send` that was refused leaves its queued
   * `mockImplementationOnce` unconsumed — the next call would take that stale one and
   * capture the sink into a closure nobody can reach, leaving `emit` undefined here.
   */
  function startRunIn(sessionId: string): (e: WorkflowEvent) => void {
    useChatStore.getState().clear()
    let captured: ((e: WorkflowEvent) => void) | null = null
    const runMock = window.sylor.workflow.run as unknown as ReturnType<typeof vi.fn>
    runMock.mockReset()
    runMock.mockImplementationOnce((_input: unknown, cb: unknown) => {
      captured = cb as (e: WorkflowEvent) => void
      return () => {}
    })
    useChatStore.getState().applyLoaded(loadedSession(sessionId))
    useChatStore.getState().send('ship the dashboard')
    return captured!
  }

  const point = (id: string, label: string): CheckpointInfo => ({
    id,
    at: 5_000,
    label,
    kind: 'git',
    sha: 'abc123'
  })

  const USAGE: ContextUsage = {
    chars: 120_000,
    budget: 240_000,
    systemChars: 20_000,
    historyChars: 40_000,
    assistantChars: 30_000,
    toolChars: 30_000,
    foldSteps: 0
  }

  it('records a restore point once, newest first, and says so in the trace', () => {
    const emit = startRunIn('sess-cp-1')
    const runId = useChatStore.getState().runId!

    emit({ type: 'checkpoint', runId, checkpoint: point('cp-a', 'Before writing src/a.ts'), at: 10 })
    emit({ type: 'checkpoint', runId, checkpoint: point('cp-b', 'Before running npm test'), at: 20 })
    // The engine can re-announce a point (a reconnected stream, a replayed event);
    // the timeline is keyed by id, so it must not grow a second identical row.
    emit({ type: 'checkpoint', runId, checkpoint: point('cp-a', 'Before writing src/a.ts'), at: 30 })

    expect(useChatStore.getState().checkpoints.map((c) => c.id)).toEqual(['cp-b', 'cp-a'])
    const rows = useChatStore.getState().activity.filter((s) => s.kind === 'checkpoint')
    expect(rows.map((s) => s.message)).toEqual([
      'Saved a restore point · Before writing src/a.ts',
      'Saved a restore point · Before running npm test',
      'Saved a restore point · Before writing src/a.ts'
    ])
    // A snapshot is over the instant it is reported, so its row is never left open.
    expect(rows.every((s) => s.done && s.ok)).toBe(true)
  })

  it('keeps the restore points when the run ends and when the chat is cleared', () => {
    const emit = startRunIn('sess-cp-2')
    const runId = useChatStore.getState().runId!
    emit({ type: 'checkpoint', runId, checkpoint: point('cp-c', 'Before writing src/c.ts'), at: 10 })

    emit({ type: 'done', runId })
    expect(useChatStore.getState().checkpoints.map((c) => c.id)).toContain('cp-c')

    // Restore points belong to the FOLDER, not the conversation: clearing the thread
    // must not tell the user their way back is gone when the snapshots are on disk.
    // (Points from the test above are still here for the same reason — nothing but a
    // folder switch re-reads this list.)
    useChatStore.getState().clear()
    expect(useChatStore.getState().checkpoints.map((c) => c.id)).toContain('cp-c')
  })

  it('re-reads the timeline after a restore, and passes the verdict straight through', async () => {
    const list = window.sylor.checkpoints.list as unknown as ReturnType<typeof vi.fn>
    const restore = window.sylor.checkpoints.restore as unknown as ReturnType<typeof vi.fn>
    list.mockResolvedValueOnce([point('cp-safety', 'Before restoring “x”')])
    restore.mockResolvedValueOnce({ ok: true, restored: ['src/a.ts'] })

    const outcome = await useChatStore.getState().restoreCheckpoint('cp-old')

    // Verbatim: the panel's honesty about what actually changed depends on the engine's
    // own `restored` list surviving the trip unedited.
    expect(outcome).toEqual({ ok: true, restored: ['src/a.ts'] })
    expect(restore).toHaveBeenCalledWith('cp-old')
    // The restore took its own safety point, so the list on disk has an entry this
    // store has never seen — hence a re-read rather than a local patch.
    expect(list).toHaveBeenCalled()
  })

  it('mirrors the measured context load without adding a row to the trace', () => {
    const emit = startRunIn('sess-cp-3')
    const runId = useChatStore.getState().runId!
    const before = useChatStore.getState().activity.length

    emit({ type: 'context', runId, usage: USAGE, at: 10 })

    expect(useChatStore.getState().usage).toEqual(USAGE)
    // Every step reports one of these; a row each would bury the trace in noise.
    expect(useChatStore.getState().activity).toHaveLength(before)
  })

  it('drops the reading when the run ends, so a stale bar never lingers', () => {
    const emit = startRunIn('sess-cp-4')
    const runId = useChatStore.getState().runId!
    emit({ type: 'context', runId, usage: USAGE, at: 10 })
    expect(useChatStore.getState().usage).not.toBeNull()

    emit({ type: 'done', runId })
    // Measured numbers are only true while the run they were measured in is live; the
    // footer falls back to its own estimate rather than showing a frozen measurement.
    expect(useChatStore.getState().usage).toBeNull()
  })
})

