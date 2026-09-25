import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb } from '@main/db/db'
import { createSession } from '@main/db/sessions'
import {
  deleteFileSnapshotsAfter,
  deleteFileSnapshotsByIds,
  findSnapshotBefore,
  insertFileSnapshot,
  listFileSnapshots,
  type NewFileSnapshot
} from '@main/db/snapshots'

/**
 * Snapshots (#1 checkpoints / rewind) go through the same electron-free DB seam as
 * the other tables: a throwaway file DB, fresh per test, so the AUTOINCREMENT ids
 * that rewind walks backwards are deterministic.
 */
let dir: string
let n = 5000
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myto-snap-'))
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dir, `t-${n}.db`))
})

/** Make a session to hang snapshots off (FK target), returning its id. */
function session(): string {
  return createSession('/proj/x', 'S', tick()).id
}

const snap = (over: Partial<NewFileSnapshot>): NewFileSnapshot => ({
  sessionId: 's',
  afterMsgId: 'm1',
  runId: 'run-1',
  path: '/proj/x/a.txt',
  before: null,
  after: 'hello',
  kind: 'write',
  existed: false,
  createdAt: tick(),
  ...over
})

describe('insertFileSnapshot / listFileSnapshots', () => {
  it('round-trips a row and maps it to the camelCase shape', () => {
    const sid = session()
    const id = insertFileSnapshot(snap({ sessionId: sid }))
    expect(id).toBeGreaterThan(0)

    const rows = listFileSnapshots(sid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      sessionId: sid,
      afterMsgId: 'm1',
      runId: 'run-1',
      path: '/proj/x/a.txt',
      before: null,
      after: 'hello',
      kind: 'write',
      existed: false
    })
  })

  it('preserves the boolean `existed` and a null `after` (a delete)', () => {
    const sid = session()
    insertFileSnapshot(snap({ sessionId: sid, kind: 'delete', before: 'old', after: null, existed: true }))
    const [row] = listFileSnapshots(sid)
    expect(row.kind).toBe('delete')
    expect(row.before).toBe('old')
    expect(row.after).toBeNull()
    expect(row.existed).toBe(true)
  })

  it('returns snapshots oldest-first (ascending id = order they happened)', () => {
    const sid = session()
    insertFileSnapshot(snap({ sessionId: sid, path: 'a' }))
    insertFileSnapshot(snap({ sessionId: sid, path: 'b' }))
    insertFileSnapshot(snap({ sessionId: sid, path: 'c' }))
    expect(listFileSnapshots(sid).map((r) => r.path)).toEqual(['a', 'b', 'c'])
  })

  it('scopes to one session', () => {
    const a = session()
    const b = session()
    insertFileSnapshot(snap({ sessionId: a }))
    insertFileSnapshot(snap({ sessionId: b }))
    insertFileSnapshot(snap({ sessionId: b }))
    expect(listFileSnapshots(a)).toHaveLength(1)
    expect(listFileSnapshots(b)).toHaveLength(2)
  })
})

describe('deleteFileSnapshotsAfter', () => {
  it('deletes only rows with id greater than the cutoff, in one session', () => {
    const sid = session()
    const id1 = insertFileSnapshot(snap({ sessionId: sid, path: 'a' }))
    const id2 = insertFileSnapshot(snap({ sessionId: sid, path: 'b' }))
    insertFileSnapshot(snap({ sessionId: sid, path: 'c' }))

    // Rewind to id1: everything after it is discarded, id1 stays.
    deleteFileSnapshotsAfter(sid, id1)
    const rows = listFileSnapshots(sid)
    expect(rows.map((r) => r.id)).toEqual([id1])
    expect(id2).toBeGreaterThan(id1)
  })

  it('leaves other sessions untouched', () => {
    const a = session()
    const b = session()
    insertFileSnapshot(snap({ sessionId: a, path: 'a1' }))
    const bId = insertFileSnapshot(snap({ sessionId: b, path: 'b1' }))
    // Deleting "after 0" in a wipes a's rows but never touches b's.
    deleteFileSnapshotsAfter(a, 0)
    expect(listFileSnapshots(a)).toHaveLength(0)
    expect(listFileSnapshots(b).map((r) => r.id)).toEqual([bId])
  })
})

describe('deleteFileSnapshotsByIds', () => {
  it('deletes exactly the listed ids (non-contiguous), scoped to the session', () => {
    const sid = session()
    const id1 = insertFileSnapshot(snap({ sessionId: sid, path: 'a' }))
    const id2 = insertFileSnapshot(snap({ sessionId: sid, path: 'b' }))
    const id3 = insertFileSnapshot(snap({ sessionId: sid, path: 'c' }))
    // Drop the first and last, keep the middle — an id> cutoff couldn't do this.
    deleteFileSnapshotsByIds(sid, [id1, id3])
    expect(listFileSnapshots(sid).map((r) => r.id)).toEqual([id2])
  })

  it('is a no-op for an empty id list', () => {
    const sid = session()
    const id1 = insertFileSnapshot(snap({ sessionId: sid, path: 'a' }))
    deleteFileSnapshotsByIds(sid, [])
    expect(listFileSnapshots(sid).map((r) => r.id)).toEqual([id1])
  })

  it('never touches another session even if an id matches there', () => {
    const a = session()
    const b = session()
    const aId = insertFileSnapshot(snap({ sessionId: a, path: 'a1' }))
    const bId = insertFileSnapshot(snap({ sessionId: b, path: 'b1' }))
    // Ask to delete b's id but scoped to a → nothing happens in either.
    deleteFileSnapshotsByIds(a, [bId])
    expect(listFileSnapshots(a).map((r) => r.id)).toEqual([aId])
    expect(listFileSnapshots(b).map((r) => r.id)).toEqual([bId])
  })
})

describe('findSnapshotBefore', () => {
  it('returns the pre-change bytes of the write whose after-content matches', () => {
    const sid = session()
    insertFileSnapshot(snap({ sessionId: sid, before: 'OLD', after: 'NEW', kind: 'write', existed: true }))
    expect(findSnapshotBefore(sid, 'NEW')).toBe('OLD')
  })

  it('is null when no snapshot has that after-content', () => {
    const sid = session()
    insertFileSnapshot(snap({ sessionId: sid, before: 'OLD', after: 'NEW', existed: true }))
    expect(findSnapshotBefore(sid, 'SOMETHING ELSE')).toBeNull()
  })

  it('is null for a fresh create (before is null) even though after matches', () => {
    const sid = session()
    insertFileSnapshot(snap({ sessionId: sid, before: null, after: 'FRESH', existed: false }))
    expect(findSnapshotBefore(sid, 'FRESH')).toBeNull()
  })

  it('matches by content regardless of the stored (absolute) path', () => {
    const sid = session()
    insertFileSnapshot(
      snap({ sessionId: sid, path: 'C:/ws/src/app.ts', before: 'V0', after: 'V1', existed: true })
    )
    // The card only knows the after-content, not the absolute path — still resolves.
    expect(findSnapshotBefore(sid, 'V1')).toBe('V0')
  })

  it('returns the newest before when the same after-content recurs', () => {
    const sid = session()
    insertFileSnapshot(snap({ sessionId: sid, before: 'A', after: 'SAME', existed: true }))
    insertFileSnapshot(snap({ sessionId: sid, before: 'B', after: 'SAME', existed: true }))
    expect(findSnapshotBefore(sid, 'SAME')).toBe('B')
  })

  it('is scoped to the session', () => {
    const a = session()
    const b = session()
    insertFileSnapshot(snap({ sessionId: a, before: 'A-OLD', after: 'SHARED', existed: true }))
    insertFileSnapshot(snap({ sessionId: b, before: 'B-OLD', after: 'SHARED', existed: true }))
    expect(findSnapshotBefore(a, 'SHARED')).toBe('A-OLD')
    expect(findSnapshotBefore(b, 'SHARED')).toBe('B-OLD')
  })
})
