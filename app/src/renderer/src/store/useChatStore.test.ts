import { describe, expect, it, vi } from 'vitest'
import { useChatStore } from './useChatStore'
import type { PersistedSession, WorkflowEvent } from '@shared/types'

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
  it('reconciles id counters past the highest rehydrated msg/run id', () => {
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
    // The new ids must be msg-9, msg-10 (not collide with msg-5/msg-8).
    useChatStore.getState().send('test')
    const after = useChatStore.getState().messages
    expect(after).toHaveLength(4) // 2 old + 2 new
    const newUserMsg = after[2]
    const newAssistantMsg = after[3]
    expect(newUserMsg.id).toMatch(/^msg-\d+$/)
    expect(newAssistantMsg.id).toMatch(/^msg-\d+$/)

    // Parse the numeric suffix to confirm it's > 8.
    const userNum = Number(newUserMsg.id.replace('msg-', ''))
    const assistantNum = Number(newAssistantMsg.id.replace('msg-', ''))
    expect(userNum).toBeGreaterThan(8)
    expect(assistantNum).toBeGreaterThan(8)

    // The runId should be > 3.
    const newRunId = useChatStore.getState().runId
    expect(newRunId).toMatch(/^run-\d+$/)
    const runNum = Number(newRunId?.replace('run-', '') ?? '0')
    expect(runNum).toBeGreaterThan(3)
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

    const appendMessage = window.sylor.sessions.appendMessage as unknown as ReturnType<
      typeof vi.fn
    >
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

      const call = appendMessage.mock.calls.find(
        (c) => (c[1] as { id: string }).id === assistantId
      )
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
