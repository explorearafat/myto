import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb } from '@main/db/db'
import {
  appendMessage,
  createSession,
  getMessageSeq,
  loadSession,
  truncateSessionAfter
} from '@main/db/sessions'
import { insertFileSnapshot } from '@main/db/snapshots'
import { rewindSession } from '@main/rewind'
import type { PersistedMessage } from '@shared/types'

/**
 * Rewind (#1) exercised end-to-end against a throwaway file DB *and* real temp
 * files on disk: the reverse-replay reads/writes/deletes actual paths, so the test
 * asserts the file bytes as well as the DB truncation.
 */
let dir: string
let work: string
let n = 9000
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myto-rewind-'))
})
afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dir, `t-${n}.db`))
  // A fresh workspace dir per test for the files rewind restores.
  work = mkdtempSync(join(dir, 'ws-'))
})

/** Append a user turn and return its id. */
function userTurn(sessionId: string, id: string, content: string): string {
  const msg: PersistedMessage = { id, role: 'user', content }
  appendMessage(sessionId, msg, tick())
  return id
}
/** Append an assistant turn. */
function botTurn(sessionId: string, id: string, content: string): void {
  const msg: PersistedMessage = { id, role: 'assistant', content }
  appendMessage(sessionId, msg, tick())
}

const p = (name: string): string => join(work, name)

describe('getMessageSeq / truncateSessionAfter', () => {
  it('reports the 0-based seq and null for an unknown id', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'hi')
    botTurn(sid, 'a1', 'hello')
    expect(getMessageSeq(sid, 'u1')).toBe(0)
    expect(getMessageSeq(sid, 'a1')).toBe(1)
    expect(getMessageSeq(sid, 'nope')).toBeNull()
    expect(getMessageSeq('other', 'u1')).toBeNull()
  })

  it('drops every turn after the cut but keeps the anchor', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'one')
    botTurn(sid, 'a1', 'reply one')
    userTurn(sid, 'u2', 'two')
    botTurn(sid, 'a2', 'reply two')

    const removed = truncateSessionAfter(sid, getMessageSeq(sid, 'u1')!, tick())
    expect(removed).toBe(3) // a1, u2, a2
    const ids = loadSession(sid)!.messages.map((m) => m.id)
    expect(ids).toEqual(['u1'])
  })
})

describe('rewindSession', () => {
  it('is a no-op with a reason for an unknown message id', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'hi')
    const r = rewindSession(sid, 'ghost', tick())
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
    expect(r.messagesRemoved).toBe(0)
  })

  it('deletes files the run created (existed=false) and truncates the chat', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'make a file')
    botTurn(sid, 'a1', 'done')
    // The run created new.txt (it did not exist before).
    writeFileSync(p('new.txt'), 'created by run', 'utf8')
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u1',
      runId: 'r1',
      path: p('new.txt'),
      before: null,
      after: 'created by run',
      kind: 'write',
      existed: false,
      createdAt: tick()
    })

    const r = rewindSession(sid, 'u1', tick())
    expect(r.ok).toBe(true)
    expect(r.filesDeleted).toBe(1)
    expect(r.filesRestored).toBe(0)
    expect(existsSync(p('new.txt'))).toBe(false)
    // The anchor (u1) stays; its reply is discarded.
    expect(loadSession(sid)!.messages.map((m) => m.id)).toEqual(['u1'])
  })

  it('restores the pre-change bytes of an edited file', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'edit it')
    botTurn(sid, 'a1', 'edited')
    writeFileSync(p('doc.txt'), 'AFTER', 'utf8')
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u1',
      runId: 'r1',
      path: p('doc.txt'),
      before: 'BEFORE',
      after: 'AFTER',
      kind: 'edit',
      existed: true,
      createdAt: tick()
    })

    const r = rewindSession(sid, 'u1', tick())
    expect(r.filesRestored).toBe(1)
    expect(readFileSync(p('doc.txt'), 'utf8')).toBe('BEFORE')
  })

  it('replays newest-first: a double-edit lands on the earliest before-bytes', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'first edit')
    botTurn(sid, 'a1', 'v1')
    userTurn(sid, 'u2', 'second edit')
    botTurn(sid, 'a2', 'v2')
    writeFileSync(p('doc.txt'), 'V2', 'utf8')
    // Two snapshots of the same file across two turns.
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u1',
      runId: 'r1',
      path: p('doc.txt'),
      before: 'V0',
      after: 'V1',
      kind: 'edit',
      existed: true,
      createdAt: tick()
    })
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u2',
      runId: 'r2',
      path: p('doc.txt'),
      before: 'V1',
      after: 'V2',
      kind: 'edit',
      existed: true,
      createdAt: tick()
    })

    // Rewind to u1 → undo both edits → the file returns to V0 (the oldest before).
    const r = rewindSession(sid, 'u1', tick())
    expect(r.filesRestored).toBe(2)
    expect(readFileSync(p('doc.txt'), 'utf8')).toBe('V0')
    expect(loadSession(sid)!.messages.map((m) => m.id)).toEqual(['u1'])
  })

  it('only undoes snapshots at or after the target turn', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'turn one')
    botTurn(sid, 'a1', 'r1')
    userTurn(sid, 'u2', 'turn two')
    botTurn(sid, 'a2', 'r2')
    // A file touched only in turn one — must survive a rewind to turn two.
    writeFileSync(p('kept.txt'), 'ONE', 'utf8')
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u1',
      runId: 'r1',
      path: p('kept.txt'),
      before: null,
      after: 'ONE',
      kind: 'write',
      existed: false,
      createdAt: tick()
    })
    // A file touched in turn two — must be undone.
    writeFileSync(p('undo.txt'), 'TWO', 'utf8')
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u2',
      runId: 'r2',
      path: p('undo.txt'),
      before: null,
      after: 'TWO',
      kind: 'write',
      existed: false,
      createdAt: tick()
    })

    const r = rewindSession(sid, 'u2', tick())
    expect(r.filesDeleted).toBe(1)
    expect(existsSync(p('undo.txt'))).toBe(false)
    expect(readFileSync(p('kept.txt'), 'utf8')).toBe('ONE') // untouched
    expect(loadSession(sid)!.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('recreates a file the run had deleted (existed=true, before set)', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'delete it')
    botTurn(sid, 'a1', 'deleted')
    // The run deleted gone.txt; it's absent on disk now.
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u1',
      runId: 'r1',
      path: p('gone.txt'),
      before: 'ORIGINAL',
      after: null,
      kind: 'delete',
      existed: true,
      createdAt: tick()
    })
    expect(existsSync(p('gone.txt'))).toBe(false)

    const r = rewindSession(sid, 'u1', tick())
    expect(r.filesRestored).toBe(1)
    expect(readFileSync(p('gone.txt'), 'utf8')).toBe('ORIGINAL')
  })

  it('recreates a nested path whose parent dir no longer exists', () => {
    const sid = createSession('/x', 'S', tick()).id
    userTurn(sid, 'u1', 'delete nested')
    botTurn(sid, 'a1', 'deleted')
    insertFileSnapshot({
      sessionId: sid,
      afterMsgId: 'u1',
      runId: 'r1',
      path: join(work, 'sub', 'deep', 'f.txt'),
      before: 'DEEP',
      after: null,
      kind: 'delete',
      existed: true,
      createdAt: tick()
    })

    const r = rewindSession(sid, 'u1', tick())
    expect(r.filesRestored).toBe(1)
    expect(readFileSync(join(work, 'sub', 'deep', 'f.txt'), 'utf8')).toBe('DEEP')
  })
})
