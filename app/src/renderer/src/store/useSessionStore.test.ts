import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/types'
import { deriveTitle, useSessionStore } from './useSessionStore'
import { useChatStore } from './useChatStore'

// A SessionSummary with the fields the store touches; overridable per test.
function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    title: 'New session',
    projectRoot: '/proj',
    projectId: null,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    mode: 'chat',
    ...overrides
  }
}

/** Seed the store with a single active session on the given title. */
function seedActive(title = 'New session'): void {
  useSessionStore.setState({
    activeSessionId: 'sess-1',
    sessions: [summary({ title })],
    activeProjectId: null
  })
}

/**
 * Wire the sessions IPC so `rename` updates a local title and `list` (called by
 * the store's refresh after every rename) reflects it — modelling the real
 * round-trip so `autoName`'s "did the title change under me?" guard is exercised
 * honestly rather than stubbed away.
 */
function wireRenameRoundTrip(): { current: () => string } {
  let title = 'New session'
  window.myto.sessions.rename = vi.fn(async (_id: string, t: string) => {
    title = t
  })
  window.myto.sessions.list = vi.fn(async () => [summary({ title })])
  return { current: () => title }
}

beforeEach(() => {
  // Benign defaults; individual tests override the ones they assert on.
  useSessionStore.setState({ sessions: [], activeSessionId: null, activeProjectId: null })
  window.myto.sessions.rename = vi.fn().mockResolvedValue(undefined)
  window.myto.sessions.list = vi.fn().mockResolvedValue([])
  window.myto.providers.getCompletion = vi.fn().mockResolvedValue({ ok: true, content: '' })
})

describe('deriveTitle (instant heuristic)', () => {
  it('uses the first non-empty line, whitespace collapsed', () => {
    expect(deriveTitle('  build   a  todo app  ')).toBe('Build A Todo App')
    expect(deriveTitle('\n\n  Fix the login bug\nmore detail')).toBe('Fix the login bug')
  })

  it('returns empty for a prompt with no usable text (attachment-only turn)', () => {
    expect(deriveTitle('')).toBe('')
    expect(deriveTitle('   \n\t  ')).toBe('')
  })

  it('clips an over-long line at a word boundary with an ellipsis', () => {
    const long = 'please build me a really elaborate dashboard with charts and tables and filters'
    const out = deriveTitle(long)
    expect(out.length).toBeLessThanOrEqual(49) // 48 + the ellipsis
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('Please Build Me')).toBe(true)
  })
})

describe('autoName (fixed title from the first message)', () => {
  it('titles the session from the first message and never calls the model', async () => {
    wireRenameRoundTrip()
    seedActive('New session')

    await useSessionStore.getState().autoName('build a todo app in react')

    const rename = vi.mocked(window.myto.sessions.rename)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('sess-1', 'Build a Todo App in React')
    // No AI re-title pass — the name is set once from the first message and left fixed.
    expect(vi.mocked(window.myto.providers.getCompletion)).not.toHaveBeenCalled()
  })

  it('uses only the first line of a multi-line prompt', async () => {
    wireRenameRoundTrip()
    seedActive('New session')

    await useSessionStore.getState().autoName('Fix the login bug\nmore detail here')

    expect(vi.mocked(window.myto.sessions.rename)).toHaveBeenCalledWith('sess-1', 'Fix The Login Bug')
  })

  it('never touches a session that already carries a real title', async () => {
    seedActive('User Named This')

    await useSessionStore.getState().autoName('build a todo app')

    expect(vi.mocked(window.myto.sessions.rename)).not.toHaveBeenCalled()
    expect(vi.mocked(window.myto.providers.getCompletion)).not.toHaveBeenCalled()
  })

  it('is a no-op for an attachment-only turn (no usable prompt text)', async () => {
    wireRenameRoundTrip()
    seedActive('New session')

    await useSessionStore.getState().autoName('   \n  ')

    expect(vi.mocked(window.myto.sessions.rename)).not.toHaveBeenCalled()
  })
})

describe('boot (reopens where you left off)', () => {
  it('restores the most recent session that has messages', async () => {
    useSessionStore.setState({ activeProjectId: 'proj-old', activeSessionId: 'sess-old' })
    window.myto.sessions.mostRecent = vi.fn().mockResolvedValue('sess-recent')
    window.myto.sessions.list = vi.fn().mockResolvedValue([])
    window.myto.sessions.load = vi.fn().mockResolvedValue({
      session: { id: 'sess-recent', title: 'Recent', projectRoot: '', projectId: null, createdAt: 0, updatedAt: 0, messageCount: 2, mode: 'chat' },
      messages: [
        { id: 'm1', role: 'user', content: 'hello' },
        { id: 'm2', role: 'assistant', content: 'hi' }
      ],
      attachments: []
    })

    await useSessionStore.getState().boot()

    // The project scope is reset to "All chats" and the last real conversation
    // is reopened (the app resumes where the user left off).
    expect(useSessionStore.getState().activeProjectId).toBeNull()
    expect(useSessionStore.getState().activeSessionId).toBe('sess-recent')
    expect(window.myto.sessions.mostRecent).toHaveBeenCalled()
    expect(window.myto.sessions.load).toHaveBeenCalledWith('sess-recent')
  })

  it('falls back to a fresh draft when history is empty', async () => {
    useSessionStore.setState({ activeProjectId: null, activeSessionId: null })
    window.myto.sessions.mostRecent = vi.fn().mockResolvedValue(null)
    window.myto.sessions.list = vi.fn().mockResolvedValue([])

    await useSessionStore.getState().boot()

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    expect(useChatStore.getState().sessionId).toBeNull()
  })
})

describe('newDraft (Claude-Desktop "New chat": no row until the first send)', () => {
  it('drops to an unsaved draft, keeps the project scope, and refreshes the list', async () => {
    useSessionStore.setState({ activeSessionId: 'sess-old', activeProjectId: 'proj-x' })
    window.myto.sessions.list = vi.fn().mockResolvedValue([summary({ id: 'sess-x' })])

    await useSessionStore.getState().newDraft()

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    // Only boot clears the scope; a plain New chat stays within the active project.
    expect(useSessionStore.getState().activeProjectId).toBe('proj-x')
    expect(useChatStore.getState().sessionId).toBeNull()
    // The (global) recents list is reloaded so the rail stays current.
    expect(window.myto.sessions.list).toHaveBeenCalledWith('proj-x')
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['sess-x'])
  })
})

