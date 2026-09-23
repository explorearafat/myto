import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, type ChatMessageUI } from './useChatStore'
import type { CompletionChunk, PersistedMessage, PersistedSession } from '@shared/types'

/** A freshly-loaded session bound to `id`, carrying `messages` (empty by default). */
function loadedSession(id: string, messages: PersistedMessage[] = []): PersistedSession {
  return {
    session: {
      id,
      title: 'S',
      projectRoot: '/test',
      projectId: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: messages.length
    },
    messages,
    attachments: []
  }
}

/** The jsdom setup stubs every window.myto method as a vi.fn; narrow to that. */
const asMock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>

/** The mocked streaming entrypoint the lean chat store drives replies through. */
const streamMock = (): ReturnType<typeof vi.fn> =>
  asMock(window.myto.providers.streamCompletion)

/** Drives a captured run's stream, filling in the CompletionChunk defaults. */
type Emit = (chunk: { delta?: string; done?: boolean; error?: string; status?: string }) => void

/**
 * Flush the microtask that `send` defers `startRun` onto. `send` reads any image
 * bytes first (an `await`), so the stream kickoff — and thus the chunk handler
 * capture below — lands a microtask later, not synchronously.
 */
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Load `sessionId`, send `prompt`, and hand back an emitter for the run's stream.
 * `streamCompletion` is stubbed to capture the chunk handler instead of
 * auto-completing, so a test can drive deltas / done / error by hand.
 */
async function startRunIn(sessionId: string, prompt = 'hi'): Promise<Emit> {
  // Held on an object so TS doesn't collapse the closure-assigned handler to
  // `never` after the guard below (CFA can't see the mock callback run).
  const captured: { onChunk: ((c: CompletionChunk) => void) | null } = { onChunk: null }
  streamMock().mockImplementationOnce((_req: unknown, cb: (c: CompletionChunk) => void) => {
    captured.onChunk = cb
    return Promise.resolve(() => {})
  })
  useChatStore.getState().applyLoaded(loadedSession(sessionId))
  useChatStore.getState().send(prompt)
  await flushMicrotasks()
  if (!captured.onChunk) throw new Error('stream did not start')
  const handler = captured.onChunk
  return (chunk: { delta?: string; done?: boolean; error?: string; status?: string }) =>
    handler({
      streamId: 'test',
      delta: chunk.delta ?? '',
      done: chunk.done ?? false,
      ...(chunk.error != null ? { error: chunk.error } : {}),
      ...(chunk.status != null ? { status: chunk.status } : {})
    })
}

/** Comfortably exceeds the store's DELTA_FLUSH_MS (66) so the flush timer fires. */
const DELTA_FLUSH_INTERVAL_MS = 200

afterEach(() => {
  vi.useRealTimers()
})

describe('useChatStore hydration', () => {
  it('mints ids that never collide with rehydrated ones (per-run salt)', async () => {
    // Load a session that had msg-5 / msg-8 persisted.
    useChatStore.getState().applyLoaded(
      loadedSession('sess-hydrate-1', [
        { id: 'msg-5', role: 'user', content: 'first' },
        { id: 'msg-8', role: 'assistant', content: 'second' }
      ])
    )
    expect(useChatStore.getState().messages).toHaveLength(2)
    expect(useChatStore.getState().messages[0].id).toBe('msg-5')
    expect(useChatStore.getState().messages[1].id).toBe('msg-8')

    // A new send mints a user + assistant id. The per-run salt keeps them from
    // reusing a restored id — a bare `msg-<n>` counter resets each launch and would
    // remint msg-5 / msg-8, whose DB rows (the primary key) belong to an
    // already-saved turn, so the write would overwrite that row via ON CONFLICT.
    streamMock().mockImplementationOnce(() => Promise.resolve(() => {}))
    useChatStore.getState().send('test')
    await flushMicrotasks()

    const after = useChatStore.getState().messages
    expect(after).toHaveLength(4) // 2 old + 2 new
    const newUserMsg = after[2]
    const newAssistantMsg = after[3]

    // Salted shape (`msg-<salt>-<n>`), not the bare collision-prone `msg-<n>`.
    expect(newUserMsg.id).toMatch(/^msg-.+-\d+$/)
    expect(newUserMsg.id).not.toMatch(/^msg-\d+$/)
    expect(newAssistantMsg.id).toMatch(/^msg-.+-\d+$/)

    // Collide with neither the restored ids nor each other.
    expect(['msg-5', 'msg-8']).not.toContain(newUserMsg.id)
    expect(['msg-5', 'msg-8']).not.toContain(newAssistantMsg.id)
    expect(newUserMsg.id).not.toBe(newAssistantMsg.id)

    // The runId is salted the same way, so it can't reuse a restored run id.
    expect(useChatStore.getState().runId).toMatch(/^run-.+-\d+$/)
  })
})

/**
 * Durability of the assistant turn (regression for "all data lost on reopen").
 *
 * The assistant's prose used to be written only once, on completion. A run
 * interrupted before it finished — app reopened, new session started, crash —
 * therefore lost the entire reply, so the reloaded session looked wiped. The fix
 * persists the assistant row up-front and checkpoints the streaming prose.
 */
describe('useChatStore assistant persistence', () => {
  it('persists the assistant row up-front, not only on done', async () => {
    const append = asMock(window.myto.sessions.appendMessage)
    append.mockClear()

    await startRunIn('sess-persist-1', 'hi')

    // Both the user turn AND an assistant turn are persisted immediately — before
    // any streaming or `done` — so an interruption can't orphan the reply.
    const persisted = append.mock.calls.map((c) => c[1] as { id: string; role: string })
    const assistantId = useChatStore.getState().messages.at(-1)!.id
    expect(persisted.some((m) => m.role === 'user')).toBe(true)
    expect(persisted.some((m) => m.role === 'assistant' && m.id === assistantId)).toBe(true)
  })

  it('checkpoints streamed prose before done, so an interrupted run keeps its reply', async () => {
    const emit = await startRunIn('sess-persist-2', 'question')
    const assistantId = useChatStore.getState().messages.at(-1)!.id
    const append = asMock(window.myto.sessions.appendMessage)
    append.mockClear()

    vi.useFakeTimers()
    try {
      // Stream prose, then let the flush timer fire with NO `done` event, i.e. the
      // run is interrupted. The prose must already be on disk by then.
      emit({ delta: 'streamed answer' })
      vi.advanceTimersByTime(DELTA_FLUSH_INTERVAL_MS)
    } finally {
      vi.useRealTimers()
    }

    const call = append.mock.calls.find((c) => (c[1] as { id: string }).id === assistantId)
    expect(call).toBeDefined()
    expect((call?.[1] as { content: string }).content).toBe('streamed answer')
  })

  it('persists the partial reply when the run is cancelled (Stop)', async () => {
    const emit = await startRunIn('sess-persist-3', 'question')
    const assistantId = useChatStore.getState().messages.at(-1)!.id
    const append = asMock(window.myto.sessions.appendMessage)
    append.mockClear()

    // A delta arrives but is still buffered (its flush timer hasn't fired) when the
    // user hits Stop. There is no `done` for a cancel, so disposeRun must fold the
    // buffer in and save the partial reply itself.
    emit({ delta: 'half-written' })
    useChatStore.getState().cancel()

    const call = append.mock.calls.find((c) => (c[1] as { id: string }).id === assistantId)
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
  it('still lists a run as live after a New Chat, and clears it on done', async () => {
    const emit = await startRunIn('sess-bg-1', 'long task')
    expect(useChatStore.getState().liveSessionIds).toContain('sess-bg-1')

    // New Chat. The run must survive the switch and stay listed, while the fresh
    // conversation itself reports idle.
    useChatStore.getState().resetTo('sess-bg-2')
    expect(useChatStore.getState().running).toBe(false)
    expect(useChatStore.getState().liveSessionIds).toContain('sess-bg-1')

    // It finishes in the background — the badge clears without the user going back.
    emit({ done: true })
    expect(useChatStore.getState().liveSessionIds).not.toContain('sess-bg-1')
  })

  it('cancelSession stops only the named chat, leaving the on-screen run alone', async () => {
    // Two live runs: one in the chat about to be deleted, one currently visible.
    await startRunIn('sess-doomed', 'a')
    await startRunIn('sess-visible', 'b')
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

  it('cancelSession is a no-op for a chat with no run', async () => {
    await startRunIn('sess-solo', 'a')
    expect(useChatStore.getState().running).toBe(true)

    // The dangerous case: an id that owns nothing must not fall through to the
    // visible run's disposer and kill the task the user is watching.
    useChatStore.getState().cancelSession('sess-never-ran')

    expect(useChatStore.getState().liveSessionIds).toContain('sess-solo')
    expect(useChatStore.getState().running).toBe(true)
  })
})

/**
 * The typewriter.
 *
 * A model stream arrives as many small deltas and already reads as typing, but a
 * provider answering without server-sent events delivers a whole paragraph in one
 * delta — which used to pop onto the screen in a single frame. The flush tick now
 * reveals part of what is queued (see `lib/reveal.ts`), except where a partial
 * reveal would be wrong: the end of a run must show the complete reply.
 */
describe('useChatStore streamed reveal (typewriter)', () => {
  /** The assistant turn's rendered prose. */
  const shown = (): string => useChatStore.getState().messages.at(-1)!.content

  it('types out a block that arrived as a single delta', async () => {
    const emit = await startRunIn('sess-reveal-1', 'go')
    vi.useFakeTimers()
    try {
      const block = 'A'.repeat(600)
      emit({ delta: block })

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

  it('leaves a live token stream alone, adding no lag of its own', async () => {
    const emit = await startRunIn('sess-reveal-2', 'go')
    vi.useFakeTimers()
    try {
      // ~15 characters every ~100ms: the measured shape of the real stream.
      for (let i = 1; i <= 6; i++) {
        emit({ delta: 'tokens of text.' })
        vi.advanceTimersByTime(100)
        expect(shown().length, `delta ${i}`).toBe(15 * i)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('never finishes a turn with prose still unrevealed', async () => {
    const emit = await startRunIn('sess-reveal-4', 'go')
    const block = 'C'.repeat(2000)
    emit({ delta: block })
    emit({ done: true })

    const message = useChatStore.getState().messages.at(-1)!
    expect(message.content).toBe(block)
    expect(message.pending).toBeFalsy()
  })
})

/**
 * The live status line. The model narrates what it's doing via <status> tags,
 * which the main process parses out of the raw stream into a `status` chunk (see
 * main/status.ts). The store threads that caption onto the streaming assistant
 * turn — mirrored to the screen while visible, held on the run so switching back
 * to a background run re-attaches to its latest caption.
 */
describe('useChatStore live status', () => {
  const lastMessage = (): ChatMessageUI => useChatStore.getState().messages.at(-1)!

  it('mirrors a status chunk onto the on-screen reply, latest caption wins', async () => {
    const emit = await startRunIn('sess-status-1', 'go')
    expect(lastMessage().status).toBeUndefined()

    emit({ status: 'Reading the question' })
    expect(lastMessage().status).toBe('Reading the question')

    // A fresh caption replaces the previous one.
    emit({ status: 'Drafting the answer' })
    expect(lastMessage().status).toBe('Drafting the answer')

    // A status chunk carries no prose, so it never adds to the reply.
    expect(lastMessage().content).toBe('')
  })

  it('holds the caption on a backgrounded run and re-attaches to it on return', async () => {
    const emit = await startRunIn('sess-status-bg', 'go')

    // Switch away: the run keeps going but is no longer on screen.
    useChatStore.getState().resetTo('sess-other')
    emit({ status: 'Thinking in the background' })
    // The now-visible fresh chat shows nothing of the other run.
    expect(useChatStore.getState().messages).toHaveLength(0)

    // Coming back re-attaches to the live run — caption and all.
    useChatStore.getState().applyLoaded(loadedSession('sess-status-bg'))
    expect(lastMessage().pending).toBe(true)
    expect(lastMessage().status).toBe('Thinking in the background')
  })
})

/**
 * Message actions — the local, never-transmitted reactions a plain chatbot keeps,
 * and regenerating a reply in place.
 */
describe('useChatStore message actions', () => {
  it('toggles a like reaction on and off, persisting each change', () => {
    const setFeedback = asMock(window.myto.sessions.setFeedback)
    setFeedback.mockClear()
    useChatStore.getState().applyLoaded(
      loadedSession('sess-fb-1', [{ id: 'm1', role: 'assistant', content: 'hi' }])
    )

    useChatStore.getState().setFeedback('m1', 'like')
    expect(useChatStore.getState().messages[0].feedback).toBe('like')

    // Clicking the active reaction again clears it (toggle semantics).
    useChatStore.getState().setFeedback('m1', 'like')
    expect(useChatStore.getState().messages[0].feedback).toBeUndefined()

    expect(setFeedback).toHaveBeenNthCalledWith(1, 'sess-fb-1', 'm1', 'like', false)
    expect(setFeedback).toHaveBeenNthCalledWith(2, 'sess-fb-1', 'm1', null, false)
  })

  it('toggles the reported flag, persisting it alongside the reaction', () => {
    const setFeedback = asMock(window.myto.sessions.setFeedback)
    setFeedback.mockClear()
    useChatStore.getState().applyLoaded(
      loadedSession('sess-fb-2', [{ id: 'm1', role: 'assistant', content: 'hi' }])
    )

    useChatStore.getState().toggleFlag('m1')
    expect(useChatStore.getState().messages[0].flagged).toBe(true)
    expect(setFeedback).toHaveBeenCalledWith('sess-fb-2', 'm1', null, true)
  })

  it('regenerates an assistant reply in place, without appending a turn', () => {
    useChatStore.getState().applyLoaded(
      loadedSession('sess-regen', [
        { id: 'm1', role: 'user', content: 'hi' },
        { id: 'm2', role: 'assistant', content: 'old reply' }
      ])
    )
    const reset = asMock(window.myto.sessions.resetMessage)
    reset.mockClear()
    let onChunk: ((c: CompletionChunk) => void) | null = null
    streamMock().mockImplementationOnce((_req: unknown, cb: (c: CompletionChunk) => void) => {
      onChunk = cb
      return Promise.resolve(() => {})
    })

    // regenerate runs the stream synchronously (no image read to await first).
    useChatStore.getState().regenerate('m2')

    const msgs = useChatStore.getState().messages
    expect(msgs).toHaveLength(2) // no new user turn was appended
    expect(msgs[1].id).toBe('m2') // streams into the SAME slot
    expect(msgs[1].content).toBe('') // its prior content was cleared first
    expect(msgs[1].pending).toBe(true)
    expect(useChatStore.getState().running).toBe(true)
    // The persisted copy is reset so a reload shows only the regenerated result.
    expect(reset).toHaveBeenCalledWith('sess-regen', 'm2')
    expect(onChunk).not.toBeNull()
  })
})
