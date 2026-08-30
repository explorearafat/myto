import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/types'
import { cleanModelTitle, deriveTitle, useSessionStore } from './useSessionStore'
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
  window.sylor.sessions.rename = vi.fn(async (_id: string, t: string) => {
    title = t
  })
  window.sylor.sessions.list = vi.fn(async () => [summary({ title })])
  return { current: () => title }
}

beforeEach(() => {
  // Benign defaults; individual tests override the ones they assert on.
  useSessionStore.setState({ sessions: [], activeSessionId: null, activeProjectId: null })
  window.sylor.sessions.rename = vi.fn().mockResolvedValue(undefined)
  window.sylor.sessions.list = vi.fn().mockResolvedValue([])
  window.sylor.providers.getCompletion = vi.fn().mockResolvedValue({ ok: true, content: '' })
})

describe('deriveTitle (instant heuristic)', () => {
  it('uses the first non-empty line, whitespace collapsed', () => {
    expect(deriveTitle('  build   a  todo app  ')).toBe('build a todo app')
    expect(deriveTitle('\n\n  Fix the login bug\nmore detail')).toBe('Fix the login bug')
  })

  it('returns empty for a prompt with no usable text (attachment-only turn)', () => {
    expect(deriveTitle('')).toBe('')
    expect(deriveTitle('   \n\t  ')).toBe('')
  })

  it('clips an over-long line at a word boundary with an ellipsis', () => {
    const long =
      'please build me a really elaborate dashboard with charts and tables and filters'
    const out = deriveTitle(long)
    expect(out.length).toBeLessThanOrEqual(49) // 48 + the ellipsis
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('please build me')).toBe(true)
  })
})

describe('cleanModelTitle (sanitize a model reply)', () => {
  it('strips surrounding straight and curly quotes', () => {
    expect(cleanModelTitle('"Todo App Builder"')).toBe('Todo App Builder')
    expect(cleanModelTitle('“Fancy Quotes”')).toBe('Fancy Quotes')
    expect(cleanModelTitle("'Single Quoted'")).toBe('Single Quoted')
  })

  it('strips a leading "Title:"/"Session:" label', () => {
    expect(cleanModelTitle('Title: Todo App')).toBe('Todo App')
    expect(cleanModelTitle('Session - Auth Flow')).toBe('Auth Flow')
  })

  it('drops trailing punctuation', () => {
    expect(cleanModelTitle('Todo App.')).toBe('Todo App')
    expect(cleanModelTitle('Build the Dashboard!')).toBe('Build the Dashboard')
  })

  it('keeps only the first non-empty line', () => {
    expect(cleanModelTitle('Todo App\n\nHere is why...')).toBe('Todo App')
  })

  it('returns empty for an empty or whitespace-only reply (keep the heuristic)', () => {
    expect(cleanModelTitle('')).toBe('')
    expect(cleanModelTitle('   \n ')).toBe('')
  })

  it('clips an over-long AI title like the heuristic', () => {
    const out = cleanModelTitle('A Ridiculously Long Title That No Sensible Model Would Ever Emit Here')
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(49)
  })
})

describe('autoName (heuristic first, AI refinement)', () => {
  it('sets the heuristic immediately, then refines with the AI title', async () => {
    wireRenameRoundTrip()
    window.sylor.providers.getCompletion = vi
      .fn()
      .mockResolvedValue({ ok: true, content: 'Build A Todo App' })
    seedActive('New session')

    await useSessionStore.getState().autoName('build a todo app in react')

    const rename = vi.mocked(window.sylor.sessions.rename)
    expect(rename).toHaveBeenNthCalledWith(1, 'sess-1', 'build a todo app in react')
    expect(rename).toHaveBeenNthCalledWith(2, 'sess-1', 'Build A Todo App')
  })

  it('keeps the heuristic when the provider is unreachable (empty reply)', async () => {
    wireRenameRoundTrip()
    window.sylor.providers.getCompletion = vi.fn().mockResolvedValue({ ok: false, content: '' })
    seedActive('New session')

    await useSessionStore.getState().autoName('build a todo app')

    const rename = vi.mocked(window.sylor.sessions.rename)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('sess-1', 'build a todo app')
  })

  it('keeps the heuristic when the AI title equals it (no redundant rename)', async () => {
    wireRenameRoundTrip()
    window.sylor.providers.getCompletion = vi
      .fn()
      .mockResolvedValue({ ok: true, content: 'build a todo app' })
    seedActive('New session')

    await useSessionStore.getState().autoName('build a todo app')

    expect(vi.mocked(window.sylor.sessions.rename)).toHaveBeenCalledTimes(1)
  })

  it('never touches a session that already carries a real title', async () => {
    window.sylor.providers.getCompletion = vi
      .fn()
      .mockResolvedValue({ ok: true, content: 'Something' })
    seedActive('User Named This')

    await useSessionStore.getState().autoName('build a todo app')

    expect(vi.mocked(window.sylor.sessions.rename)).not.toHaveBeenCalled()
    expect(vi.mocked(window.sylor.providers.getCompletion)).not.toHaveBeenCalled()
  })

  it('is a no-op for an attachment-only turn (no usable prompt text)', async () => {
    wireRenameRoundTrip()
    seedActive('New session')

    await useSessionStore.getState().autoName('   \n  ')

    expect(vi.mocked(window.sylor.sessions.rename)).not.toHaveBeenCalled()
  })

  it('does not clobber a manual rename that lands while the AI call is in flight', async () => {
    wireRenameRoundTrip()
    // Simulate the user renaming the session during the awaited AI round-trip.
    window.sylor.providers.getCompletion = vi.fn(async () => {
      useSessionStore.setState({ sessions: [summary({ title: 'User Renamed' })] })
      return { ok: true, content: 'Ai Suggested Title' }
    })
    seedActive('New session')

    await useSessionStore.getState().autoName('build a todo app')

    // Only the heuristic rename ran; the AI pass backed off because the title
    // no longer matched what it had set.
    const titles = vi.mocked(window.sylor.sessions.rename).mock.calls.map((c) => c[1])
    expect(titles).toEqual(['build a todo app'])
  })
})

describe('boot (fresh landing page, never restores the last chat)', () => {
  it('clears any stale project filter, shows an empty draft, and does NOT reopen mostRecent', async () => {
    useSessionStore.setState({ activeProjectId: 'proj-old', activeSessionId: 'sess-old' })
    window.sylor.sessions.mostRecent = vi.fn().mockResolvedValue('sess-recent')
    window.sylor.sessions.list = vi.fn().mockResolvedValue([])

    await useSessionStore.getState().boot()

    // A fresh landing page: the project scope is reset to "All chats"…
    expect(useSessionStore.getState().activeProjectId).toBeNull()
    // …no persisted session is active, and the chat is an unsaved draft
    // (sessionId null → the composer renders the EmptyState hero).
    expect(useSessionStore.getState().activeSessionId).toBeNull()
    expect(useChatStore.getState().sessionId).toBeNull()
    // The last conversation is deliberately NOT restored (reopen = clean slate).
    expect(window.sylor.sessions.mostRecent).not.toHaveBeenCalled()
  })
})

describe('newDraft (Claude-Desktop "New chat": no row until the first send)', () => {
  it('drops to an unsaved draft, keeps the project scope, and refreshes the list', async () => {
    useSessionStore.setState({ activeSessionId: 'sess-old', activeProjectId: 'proj-x' })
    window.sylor.sessions.list = vi.fn().mockResolvedValue([summary({ id: 'sess-x' })])

    await useSessionStore.getState().newDraft()

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    // Only boot clears the scope; a plain New chat stays within the active project.
    expect(useSessionStore.getState().activeProjectId).toBe('proj-x')
    expect(useChatStore.getState().sessionId).toBeNull()
    // The (global) recents list is reloaded so the rail stays current.
    expect(window.sylor.sessions.list).toHaveBeenCalledWith('proj-x')
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['sess-x'])
  })
})
