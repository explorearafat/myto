import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb, getDb, SCHEMA_VERSION } from '@main/db/db'
import {
  appendMessage,
  createSession,
  deleteSession,
  INTERRUPTED_NOTE,
  listSessions,
  loadSession,
  mostRecentSession,
  reconcileInterruptedRuns,
  renameSession,
  resetMessageForRegenerate,
  searchSessions,
  setMessageFeedback
} from '@main/db/sessions'
import { createProject } from '@main/db/projects'

/**
 * The DB layer is electron-free and takes an injected path, so we point it at a
 * throwaway file DB (not `:memory:` — we want WAL + a real file to mirror prod)
 * inside a temp dir for the suite. Each test starts from a fresh DB so ordering
 * assertions are deterministic.
 */
const ROOT = '/proj/myto'
let dir: string
let n = 1000
/** Monotonic fake clock — `Date.now()` is injected everywhere, so tests control it. */
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myto-db-'))
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  // Fresh DB file per test: close, swap to a new path, reopen on first getDb().
  closeDb()
  __setDbPathForTest(join(dir, `t-${n}.db`))
})

describe('migration', () => {
  it('sets user_version to the current schema version on open', () => {
    const row = getDb().prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
  })

  it('enables foreign keys', () => {
    const row = getDb().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(row.foreign_keys).toBe(1)
  })

  it('upgrades a v4 database to the current version without data loss (adds feedback + flagged)', () => {
    // Build a full v4 DB by hand: every table as it stood at v4 (messages has no
    // feedback/flagged columns yet), with one chat + one message, marked
    // user_version 4. Starting AT v4 means migrate() runs the `< 5` step (this
    // test's focus — feedback/flagged) and every later step, so the earlier
    // tables must already be present (they wouldn't be recreated).
    const path = join(dir, `v4-${tick()}.db`)
    closeDb()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, project_root TEXT NOT NULL,
        project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, error TEXT
      );
      CREATE TABLE tool_ops (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, after_msg_id TEXT NOT NULL, run_id TEXT NOT NULL,
        auto INTEGER NOT NULL, decision TEXT, proposal_json TEXT NOT NULL, result_json TEXT
      );
      CREATE TABLE terminal_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
        memory TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE project_knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL,
        size INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
    `)
    legacy.exec(
      `INSERT INTO sessions (id, title, project_root, created_at, updated_at)
       VALUES ('sess-v4', 'Pre-v5 chat', '${ROOT}', 100, 200)`
    )
    legacy.exec(
      `INSERT INTO messages (id, session_id, seq, role, content)
       VALUES ('msg-v4', 'sess-v4', 0, 'assistant', 'answer from v4')`
    )
    legacy.exec('PRAGMA user_version = 4')
    legacy.close()

    // Reopen through the real layer — migrate() lifts it v4 → current.
    __setDbPathForTest(path)
    const db = getDb()
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION
    )

    // Pre-existing message survived, and reads back with no feedback/flag set.
    const loaded = loadSession('sess-v4')
    expect(loaded?.messages[0].content).toBe('answer from v4')
    expect(loaded?.messages[0].feedback).toBeUndefined()
    expect(loaded?.messages[0].flagged).toBeUndefined()

    // The new columns are writable on the upgraded DB.
    setMessageFeedback('msg-v4', 'like', true)
    const after = loadSession('sess-v4')
    expect(after?.messages[0].feedback).toBe('like')
    expect(after?.messages[0].flagged).toBe(true)
  })

  it('persists, clears, and round-trips feedback + flagged; reset blanks a message', () => {
    const s = createSession(ROOT, 'Feedback', tick())
    appendMessage(s.id, { id: 'm-a', role: 'user', content: 'q' }, tick())
    appendMessage(s.id, { id: 'm-b', role: 'assistant', content: 'a' }, tick())

    // Set both markers, then read them back.
    setMessageFeedback('m-b', 'dislike', true)
    let loaded = loadSession(s.id)
    let mb = loaded?.messages.find((m) => m.id === 'm-b')
    expect(mb?.feedback).toBe('dislike')
    expect(mb?.flagged).toBe(true)

    // Clearing feedback (null) drops the field; flag off too.
    setMessageFeedback('m-b', null, false)
    loaded = loadSession(s.id)
    mb = loaded?.messages.find((m) => m.id === 'm-b')
    expect(mb?.feedback).toBeUndefined()
    expect(mb?.flagged).toBeUndefined()

    // Reset for regenerate: blanks content and clears the markers.
    setMessageFeedback('m-b', 'like', true)
    resetMessageForRegenerate('m-b')
    loaded = loadSession(s.id)
    mb = loaded?.messages.find((m) => m.id === 'm-b')
    expect(mb?.content).toBe('')
    expect(mb?.feedback).toBeUndefined()
    expect(mb?.flagged).toBeUndefined()
    // The user turn is untouched.
    expect(loaded?.messages.find((m) => m.id === 'm-a')?.content).toBe('q')
  })
})

describe('sessions CRUD', () => {
  it('creates and lists sessions newest-updated first', () => {
    const a = createSession(ROOT, 'First', tick())
    const b = createSession(ROOT, 'Second', tick())
    const list = listSessions()
    expect(list.map((s) => s.id)).toEqual([b.id, a.id])
    expect(list[0].messageCount).toBe(0)
  })

  it('lists sessions from every folder — history is global, not project-scoped', () => {
    // The heart of the fix: switching the working folder must never hide chats, so
    // the list spans all roots (newest-updated first) regardless of where each was
    // created.
    createSession(ROOT, 'Mine', tick())
    createSession('/other/root', 'Theirs', tick())
    expect(listSessions().map((s) => s.title)).toEqual(['Theirs', 'Mine'])
  })

  it('rename bumps updated_at and reorders the list', () => {
    const a = createSession(ROOT, 'A', tick())
    const b = createSession(ROOT, 'B', tick())
    // b is newest; renaming a with a later clock makes it newest.
    renameSession(a.id, 'A renamed', tick())
    const list = listSessions()
    expect(list[0].id).toBe(a.id)
    expect(list[0].title).toBe('A renamed')
    expect(list[0].updatedAt).toBeGreaterThan(b.updatedAt)
  })

  it('mostRecent picks the latest-updated session across every folder', () => {
    createSession(ROOT, 'A', tick())
    const b = createSession('/other/root', 'B', tick())
    // Global: the newest wins even though it lives under a different root.
    expect(mostRecentSession()).toBe(b.id)
  })

  it('mostRecent returns null when there are no sessions', () => {
    expect(mostRecentSession()).toBeNull()
  })

  it('mostRecent skips a newer EMPTY session in favour of one with messages', () => {
    // Regression: clicking New Chat creates a blank session with a fresh
    // updated_at. Booting into it made the user's actual work look deleted.
    const work = createSession(ROOT, 'Real work', tick())
    appendMessage(work.id, { id: 'msg-1', role: 'user', content: 'build me a thing' }, tick())
    const blank = createSession(ROOT, 'New session', tick())

    expect(blank.updatedAt).toBeGreaterThan(work.updatedAt)
    expect(mostRecentSession()).toBe(work.id)
  })
})

describe('reconcileInterruptedRuns', () => {
  it('tags an assistant turn left empty by a killed run, and is idempotent', () => {
    const s = createSession(ROOT, 'Interrupted', tick())
    appendMessage(s.id, { id: 'msg-1', role: 'user', content: 'big task' }, tick())
    // The up-front assistant row, still empty because the app died mid-run.
    appendMessage(s.id, { id: 'msg-2', role: 'assistant', content: '' }, tick())

    expect(reconcileInterruptedRuns()).toBe(1)

    const loaded = loadSession(s.id)
    expect(loaded?.messages[1].error).toBe(INTERRUPTED_NOTE)
    // The user's prompt must be untouched.
    expect(loaded?.messages[0].content).toBe('big task')
    expect(loaded?.messages[0].error).toBeUndefined()

    // Running again on the same DB tags nothing further.
    expect(reconcileInterruptedRuns()).toBe(0)
  })

  it('leaves completed replies and real errors alone', () => {
    const s = createSession(ROOT, 'Fine', tick())
    appendMessage(s.id, { id: 'msg-1', role: 'assistant', content: 'a full answer' }, tick())
    appendMessage(
      s.id,
      { id: 'msg-2', role: 'assistant', content: '', error: 'Provider refused' },
      tick()
    )

    expect(reconcileInterruptedRuns()).toBe(0)

    const loaded = loadSession(s.id)
    expect(loaded?.messages[0].error).toBeUndefined()
    expect(loaded?.messages[1].error).toBe('Provider refused')
  })
})

describe('append + load round-trips', () => {
  it('stores messages in seq order with their session count', () => {
    const s = createSession(ROOT, 'Work', tick())
    appendMessage(s.id, { id: 'msg-1', role: 'user', content: 'hello' }, tick())
    appendMessage(s.id, { id: 'msg-2', role: 'assistant', content: 'hi there' }, tick())

    const loaded = loadSession(s.id)!
    expect(loaded.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2'])
    expect(loaded.messages[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(loaded.session.messageCount).toBe(2)
  })

  it('appendMessage on a duplicate id replaces content without adding a row', () => {
    const s = createSession(ROOT, 'Dup', tick())
    appendMessage(s.id, { id: 'msg-1', role: 'assistant', content: 'v1' }, tick())
    appendMessage(s.id, { id: 'msg-1', role: 'assistant', content: 'v2' }, tick())
    const loaded = loadSession(s.id)!
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0].content).toBe('v2')
  })

  it('returns null for an unknown session id', () => {
    expect(loadSession('nope')).toBeNull()
  })
})

describe('search', () => {
  it('matches on session title (case-insensitive), newest-updated first', () => {
    const a = createSession(ROOT, 'Refactor the parser', tick())
    const b = createSession(ROOT, 'Parser edge cases', tick())
    createSession(ROOT, 'Unrelated notes', tick())
    // Both titles contain "parser"; b is newer so it sorts first.
    expect(searchSessions('PARSER').map((s) => s.id)).toEqual([b.id, a.id])
  })

  it('matches on message content even when the title does not', () => {
    const s = createSession(ROOT, 'Chat', tick())
    appendMessage(s.id, { id: 'm1', role: 'user', content: 'how do I use zustand?' }, tick())
    const hits = searchSessions('zustand')
    expect(hits.map((h) => h.id)).toEqual([s.id])
    expect(hits[0].messageCount).toBe(1)
  })

  it('returns each matching session once even with multiple matching messages', () => {
    const s = createSession(ROOT, 'Chat', tick())
    appendMessage(s.id, { id: 'm1', role: 'user', content: 'alpha alpha' }, tick())
    appendMessage(s.id, { id: 'm2', role: 'assistant', content: 'alpha again' }, tick())
    expect(searchSessions('alpha')).toHaveLength(1)
  })

  it('searches every folder and returns [] for a blank query', () => {
    createSession(ROOT, 'Mine parser', tick())
    createSession('/other/root', 'Theirs parser', tick())
    // Global: matches come back from every root (newest-updated first).
    expect(searchSessions('parser').map((s) => s.title)).toEqual(['Theirs parser', 'Mine parser'])
    expect(searchSessions('   ')).toEqual([])
  })

  it('filters by project id when provided (null = every chat)', () => {
    const proj = createProject('Parsers', tick())
    const filed = createSession(ROOT, 'Filed parser', tick(), proj.id)
    const unfiled = createSession(ROOT, 'Unfiled parser', tick())
    // A concrete id narrows to that project…
    expect(searchSessions('parser', proj.id).map((s) => s.id)).toEqual([filed.id])
    // …while null (the rail's "All chats") returns every match, filed or not,
    // newest first.
    expect(searchSessions('parser', null).map((s) => s.id)).toEqual([unfiled.id, filed.id])
  })

  it('treats LIKE wildcards in the query as literals', () => {
    const pct = createSession(ROOT, '100% done', tick())
    createSession(ROOT, '100 tasks', tick())
    // Without escaping, "100%" would match "100 tasks" too; it must not.
    expect(searchSessions('100%').map((s) => s.id)).toEqual([pct.id])
  })
})

describe('delete cascade', () => {
  it('removes the session and all its child rows, leaving others intact', () => {
    const keep = createSession(ROOT, 'Keep', tick())
    appendMessage(keep.id, { id: 'k-msg', role: 'user', content: 'safe' }, tick())

    const gone = createSession(ROOT, 'Gone', tick())
    appendMessage(gone.id, { id: 'g-msg', role: 'user', content: 'bye' }, tick())

    deleteSession(gone.id)

    expect(loadSession(gone.id)).toBeNull()
    expect(listSessions().map((s) => s.id)).toEqual([keep.id])
    // Child rows for the deleted session are gone (cascade).
    const orphans = getDb()
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
      .get(gone.id) as { c: number }
    expect(orphans.c).toBe(0)
    // The kept session's rows survive.
    expect(loadSession(keep.id)!.messages[0].content).toBe('safe')
  })
})
