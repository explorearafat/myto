import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb, getDb } from '@main/db/db'
import {
  attachToMessage,
  createAttachment,
  getAttachment,
  listAttachmentsBySession,
  removeAttachment
} from '@main/db/attachments'
import { appendMessage, createSession, deleteSession, loadSession } from '@main/db/sessions'

/**
 * Attachments DB layer (chat-first redesign). Same throwaway-file-per-test setup
 * as {@link file://./sessions.test.ts}: metadata only lives here (bytes are on
 * disk, written by the IPC layer), so these tests exercise CRUD + the pending →
 * bound lifecycle + cascade-on-session-delete.
 */
const ROOT = '/proj/myto'
let dir: string
let n = 5000
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myto-att-'))
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dir, `t-${n}.db`))
})

describe('attachments CRUD', () => {
  it('creates a pending attachment (no message) and reads it back', () => {
    const s = createSession(ROOT, 'Chat', tick())
    const att = createAttachment(s.id, 'notes.txt', 'text/plain', '/disk/notes.txt', 42, tick())
    expect(att.messageId).toBeNull()
    expect(att.size).toBe(42)

    const loaded = getAttachment(att.id)
    expect(loaded).not.toBeNull()
    expect(loaded).toMatchObject({
      id: att.id,
      sessionId: s.id,
      name: 'notes.txt',
      mime: 'text/plain',
      path: '/disk/notes.txt',
      messageId: null
    })
  })

  it('returns null for an unknown id', () => {
    expect(getAttachment('nope')).toBeNull()
  })

  it('lists a session attachments oldest first', () => {
    const s = createSession(ROOT, 'Chat', tick())
    const a = createAttachment(s.id, 'a.png', 'image/png', '/disk/a', 1, tick())
    const b = createAttachment(s.id, 'b.png', 'image/png', '/disk/b', 2, tick())
    expect(listAttachmentsBySession(s.id).map((x) => x.id)).toEqual([a.id, b.id])
  })

  it('binds pending attachments to a user message', () => {
    const s = createSession(ROOT, 'Chat', tick())
    appendMessage(s.id, { id: 'msg-1', role: 'user', content: 'here' }, tick())
    const a = createAttachment(s.id, 'a.txt', 'text/plain', '/disk/a', 1, tick())
    const b = createAttachment(s.id, 'b.txt', 'text/plain', '/disk/b', 1, tick())

    attachToMessage([a.id, b.id], 'msg-1')

    expect(getAttachment(a.id)?.messageId).toBe('msg-1')
    expect(getAttachment(b.id)?.messageId).toBe('msg-1')
  })

  it('attachToMessage is a no-op for an empty id list', () => {
    // Should not throw or bind anything.
    expect(() => attachToMessage([], 'msg-1')).not.toThrow()
  })

  it('removes an attachment row by id', () => {
    const s = createSession(ROOT, 'Chat', tick())
    const a = createAttachment(s.id, 'a.txt', 'text/plain', '/disk/a', 1, tick())
    removeAttachment(a.id)
    expect(getAttachment(a.id)).toBeNull()
  })
})

describe('attachments in loadSession', () => {
  it('returns only message-bound attachments, oldest first', () => {
    const s = createSession(ROOT, 'Chat', tick())
    appendMessage(s.id, { id: 'msg-1', role: 'user', content: 'here' }, tick())
    const bound = createAttachment(s.id, 'bound.txt', 'text/plain', '/disk/bound', 1, tick())
    createAttachment(s.id, 'pending.txt', 'text/plain', '/disk/pending', 1, tick())
    attachToMessage([bound.id], 'msg-1')

    const loaded = loadSession(s.id)!
    // The still-pending attachment (no message) is excluded from history.
    expect(loaded.attachments.map((a) => a.id)).toEqual([bound.id])
    expect(loaded.attachments[0].messageId).toBe('msg-1')
  })
})

describe('attachments cascade', () => {
  it('deletes a session attachment rows when the session is deleted', () => {
    const s = createSession(ROOT, 'Gone', tick())
    const a = createAttachment(s.id, 'a.txt', 'text/plain', '/disk/a', 1, tick())
    deleteSession(s.id)
    expect(getAttachment(a.id)).toBeNull()
    const orphans = getDb()
      .prepare('SELECT COUNT(*) AS c FROM attachments WHERE session_id = ?')
      .get(s.id) as { c: number }
    expect(orphans.c).toBe(0)
  })
})
