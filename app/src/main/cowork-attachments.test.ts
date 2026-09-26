import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb } from '@main/db/db'
import { attachToMessage, createAttachment } from '@main/db/attachments'
import { createSession } from '@main/db/sessions'
import { materializeAttachmentFiles, materializeAttachments } from '@main/cowork-attachments'
import type { Attachment } from '@shared/types'

/**
 * The attachment → Cowork working-folder bridge. Two layers:
 *  - {@link materializeAttachmentFiles} — the pure filesystem copy (temp dirs only).
 *  - {@link materializeAttachments} — DB filter for "this turn's" rows over a real
 *    throwaway sqlite db (same harness as db/attachments.test.ts) + a temp workspace.
 */
const ROOT = '/proj/myto'
let dbDir: string
let n = 7000
const tick = (): number => (n += 1000)

/** A fresh temp working folder + a temp source dir with real bytes on disk. */
function freshDirs(): { ws: string; src: string } {
  return {
    ws: mkdtempSync(join(tmpdir(), 'myto-ws-')),
    src: mkdtempSync(join(tmpdir(), 'myto-src-'))
  }
}

/** Write `body` to <src>/<name> and return an Attachment row pointing at it. */
function srcAtt(src: string, name: string, body: string, over: Partial<Attachment> = {}): Attachment {
  const path = join(src, name.replace(/[\\/]/g, '_'))
  writeFileSync(path, body)
  return {
    id: `att-${name}`,
    sessionId: 's',
    messageId: null,
    name,
    mime: 'text/plain',
    path,
    size: Buffer.byteLength(body),
    createdAt: 1,
    ...over
  }
}

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'myto-catt-'))
})
afterAll(() => {
  closeDb()
  rmSync(dbDir, { recursive: true, force: true })
})
beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dbDir, `t-${n}.db`))
})

describe('materializeAttachmentFiles', () => {
  it('copies attachments into uploads/ and returns their relative paths', async () => {
    const { ws, src } = freshDirs()
    const out = await materializeAttachmentFiles(
      [srcAtt(src, 'report.pdf', 'PDF-BYTES', { mime: 'application/pdf', size: 9 })],
      ws
    )
    expect(out).toEqual([{ name: 'report.pdf', rel: 'uploads/report.pdf', mime: 'application/pdf', size: 9 }])
    expect(readFileSync(join(ws, 'uploads', 'report.pdf'), 'utf8')).toBe('PDF-BYTES')
    rmSync(ws, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  it('never clobbers an existing file (skip-if-exists) but still reports it', async () => {
    const { ws, src } = freshDirs()
    const first = srcAtt(src, 'data.csv', 'ORIGINAL')
    await materializeAttachmentFiles([first], ws)
    // A second upload with the same name but different bytes must not overwrite.
    const second = srcAtt(src, 'data.csv', 'REPLACEMENT')
    const out = await materializeAttachmentFiles([second], ws)
    expect(out.map((f) => f.rel)).toEqual(['uploads/data.csv'])
    expect(readFileSync(join(ws, 'uploads', 'data.csv'), 'utf8')).toBe('ORIGINAL')
    rmSync(ws, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  it('drops an attachment whose source bytes are gone', async () => {
    const { ws } = freshDirs()
    const ghost: Attachment = {
      id: 'x', sessionId: 's', messageId: null, name: 'missing.txt',
      mime: 'text/plain', path: join(ws, 'nope', 'missing.txt'), size: 3, createdAt: 1
    }
    expect(await materializeAttachmentFiles([ghost], ws)).toEqual([])
    expect(existsSync(join(ws, 'uploads', 'missing.txt'))).toBe(false)
    rmSync(ws, { recursive: true, force: true })
  })

  it('drops a name that would escape the sandbox', async () => {
    const { ws, src } = freshDirs()
    const evil = srcAtt(src, '../../evil.txt', 'X', { name: '../../evil.txt' })
    expect(await materializeAttachmentFiles([evil], ws)).toEqual([])
    rmSync(ws, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })
})

describe('materializeAttachments (DB filter)', () => {
  it("materializes this turn's bound + pending rows, and skips prior turns", async () => {
    const { ws, src } = freshDirs()
    const s = createSession(ROOT, 'Cowork', tick())

    // Bytes on disk for each row (createAttachment stores metadata → real path).
    writeFileSync(join(src, 'a.txt'), 'AAA')
    writeFileSync(join(src, 'b.txt'), 'BBB')
    writeFileSync(join(src, 'old.txt'), 'OLD')
    const a = createAttachment(s.id, 'a.txt', 'text/plain', join(src, 'a.txt'), 3, tick()) // → bound to this turn
    createAttachment(s.id, 'b.txt', 'text/plain', join(src, 'b.txt'), 3, tick()) // stays pending (null)
    const old = createAttachment(s.id, 'old.txt', 'text/plain', join(src, 'old.txt'), 3, tick())

    // Prior turn's upload is bound to an earlier message; this turn answers 'u-now'.
    attachToMessage([old.id], 'u-prev')
    attachToMessage([a.id], 'u-now')

    const out = await materializeAttachments(s.id, 'u-now', ws)
    expect(out.map((f) => f.rel).sort()).toEqual(['uploads/a.txt', 'uploads/b.txt'])
    expect(existsSync(join(ws, 'uploads', 'old.txt'))).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  it('returns [] for a session with no attachments', async () => {
    const { ws } = freshDirs()
    const s = createSession(ROOT, 'Cowork', tick())
    expect(await materializeAttachments(s.id, 'u-now', ws)).toEqual([])
    rmSync(ws, { recursive: true, force: true })
  })
})
