import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb, getDb, SCHEMA_VERSION } from '@main/db/db'
import {
  addProjectKnowledge,
  appendProjectMemory,
  assignSessionToProject,
  createProject,
  deleteProject,
  getProject,
  getProjectMemory,
  listProjectKnowledge,
  listProjects,
  removeProjectKnowledge,
  renameProject,
  setProjectInstructions,
  setProjectMemory
} from '@main/db/projects'
import { createSession, listSessions, loadSession } from '@main/db/sessions'

/**
 * Mirrors sessions.test.ts: a throwaway file DB per test (WAL + real file, not
 * `:memory:`) so migrations and cascades behave like production. The clock is
 * injected everywhere, so tests drive ordering deterministically.
 */
const ROOT = '/proj/sylor'
let dir: string
let n = 5000
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sylor-proj-'))
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dir, `t-${n}.db`))
})

describe('projects CRUD', () => {
  it('creates and lists projects newest-updated first', () => {
    const a = createProject('Alpha', tick())
    const b = createProject('Beta', tick())
    const list = listProjects()
    expect(list.map((p) => p.id)).toEqual([b.id, a.id])
    expect(list[0].sessionCount).toBe(0)
  })

  it('counts sessions filed under a project', () => {
    const p = createProject('Website', tick())
    const s1 = createSession(ROOT, 'One', tick(), p.id)
    createSession(ROOT, 'Two', tick(), p.id)
    createSession(ROOT, 'Unfiled', tick(), null)
    expect(getProject(p.id)?.sessionCount).toBe(2)
    // Listing by project id returns exactly its two filed chats…
    expect(listSessions(p.id)).toHaveLength(2)
    // …while the global list (null) spans every chat, filed or not.
    const all = listSessions(null)
    expect(all.some((s) => s.id === s1.id)).toBe(true)
    expect(all).toHaveLength(3)
  })

  it('renames and updates instructions', () => {
    const p = createProject('Old', tick())
    renameProject(p.id, 'New', tick())
    setProjectInstructions(p.id, 'Be terse.', tick())
    const loaded = getProject(p.id)
    expect(loaded?.name).toBe('New')
    expect(loaded?.instructions).toBe('Be terse.')
  })

  it('assigns and unfiles a session', () => {
    const p = createProject('Grp', tick())
    const s = createSession(ROOT, 'Chat', tick(), null)
    assignSessionToProject(s.id, p.id, tick())
    expect(loadSession(s.id)?.session.projectId).toBe(p.id)
    assignSessionToProject(s.id, null, tick())
    expect(loadSession(s.id)?.session.projectId).toBeNull()
  })

  it('deletes a project, detaching its chats and cascading knowledge', () => {
    const p = createProject('Doomed', tick())
    const s = createSession(ROOT, 'Kept', tick(), p.id)
    addProjectKnowledge(p.id, 'Spec', 'content', tick())
    deleteProject(p.id)
    expect(getProject(p.id)).toBeNull()
    // The chat survives, unfiled.
    expect(loadSession(s.id)?.session.projectId).toBeNull()
    // Knowledge cascaded away with the project.
    expect(listProjectKnowledge(p.id)).toHaveLength(0)
  })
})

describe('project knowledge', () => {
  it('adds, lists oldest-first, and removes docs', () => {
    const p = createProject('K', tick())
    const d1 = addProjectKnowledge(p.id, 'First', 'a', tick())
    const d2 = addProjectKnowledge(p.id, 'Second', 'b', tick())
    expect(listProjectKnowledge(p.id).map((d) => d.id)).toEqual([d1.id, d2.id])
    removeProjectKnowledge(d1.id)
    expect(listProjectKnowledge(p.id).map((d) => d.id)).toEqual([d2.id])
  })
})

describe('v1 → current migration in place', () => {
  it('upgrades an existing v1 DB to the current schema without data loss', () => {
    // Build a v1 database by hand (v1 schema + user_version = 1), seed a chat.
    const path = join(dir, 'legacy-v1.db')
    const legacy = new DatabaseSync(path)
    legacy.exec('PRAGMA foreign_keys = ON')
    // Full v1 schema (all four tables), matching what the v1 migration block
    // created — loadSession() reads tool_ops + terminal_logs, so they must exist.
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, project_root TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
    `)
    legacy.exec(
      `INSERT INTO sessions (id, title, project_root, created_at, updated_at)
       VALUES ('sess-legacy', 'Legacy chat', '${ROOT}', 100, 200)`
    )
    legacy.exec(
      `INSERT INTO messages (id, session_id, seq, role, content)
       VALUES ('msg-legacy', 'sess-legacy', 0, 'user', 'hello from v1')`
    )
    legacy.exec('PRAGMA user_version = 1')
    legacy.close()

    // Reopen through the real layer — migrate() should lift it to the current version.
    __setDbPathForTest(path)
    const db = getDb()
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION
    )

    // The pre-existing chat and its message survived untouched.
    const loaded = loadSession('sess-legacy')
    expect(loaded?.session.title).toBe('Legacy chat')
    expect(loaded?.session.projectId).toBeNull()
    expect(loaded?.messages[0].content).toBe('hello from v1')

    // And the new project machinery works against the upgraded DB.
    const p = createProject('Post-migration', tick())
    assignSessionToProject('sess-legacy', p.id, tick())
    expect(loadSession('sess-legacy')?.session.projectId).toBe(p.id)
    // The v4 memory column is present and defaults to empty on the upgraded DB.
    expect(getProjectMemory(p.id)).toBe('')
  })
})

describe('project memory', () => {
  it('starts empty and round-trips a wholesale set', () => {
    const p = createProject('Mem', tick())
    expect(p.memory).toBe('')
    expect(getProjectMemory(p.id)).toBe('')
    setProjectMemory(p.id, 'Uses pnpm, not npm.', tick())
    expect(getProjectMemory(p.id)).toBe('Uses pnpm, not npm.')
    expect(getProject(p.id)?.memory).toBe('Uses pnpm, not npm.')
  })

  it('appends notes as accumulating bullet lines', () => {
    const p = createProject('Mem2', tick())
    const first = appendProjectMemory(p.id, '  Prefers TypeScript strict  ', tick())
    expect(first).toBe('- Prefers TypeScript strict')
    const second = appendProjectMemory(p.id, 'Tests live next to source', tick())
    expect(second).toBe('- Prefers TypeScript strict\n- Tests live next to source')
    expect(getProjectMemory(p.id)).toBe(second)
  })

  it('ignores a blank note, leaving memory unchanged', () => {
    const p = createProject('Mem3', tick())
    setProjectMemory(p.id, '- Existing', tick())
    expect(appendProjectMemory(p.id, '   ', tick())).toBe('- Existing')
    expect(getProjectMemory(p.id)).toBe('- Existing')
  })

  it('collapses internal whitespace in an appended note to one line', () => {
    const p = createProject('Mem4', tick())
    const out = appendProjectMemory(p.id, 'line one\n   line two', tick())
    expect(out).toBe('- line one line two')
  })
})
