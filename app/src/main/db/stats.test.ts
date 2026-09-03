import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb, getDb } from '@main/db/db'
import { appendMessage, appendToolOp, createSession } from '@main/db/sessions'
import { readUsageFacts } from '@main/db/stats'
import type { PersistedToolOp } from '@shared/types'

/**
 * Same harness as sessions.test.ts: the DB layer takes an injected path, so each
 * test runs against a throwaway file DB. Timestamps are explicit — `appendMessage`
 * receives `now`, so the suite owns the clock the stats are derived from.
 */
const ROOT = '/proj/sylor'
let dir: string
let n = 0
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sylor-stats-'))
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dir, `t-${++n}.db`))
})

const toolOp = (id: string, afterMessageId: string): PersistedToolOp => ({
  id,
  afterMessageId,
  runId: 'run-1',
  auto: true,
  proposal: { id, kind: 'run_command', command: 'ls' },
  result: { id, kind: 'run_command', exitCode: 0, output: 'x'.repeat(40), truncated: false }
})

describe('readUsageFacts', () => {
  it('returns zeroes on an empty database', () => {
    const facts = readUsageFacts()
    expect(facts).toEqual({ sessions: 0, messages: 0, tokens: 0, timestamps: [], models: [] })
  })

  it('counts only sessions that hold at least one message', () => {
    const withMsg = createSession(ROOT, 'used', tick())
    createSession(ROOT, 'empty draft', tick())
    appendMessage(withMsg.id, { id: 'm1', role: 'user', content: 'hi' }, tick())

    const facts = readUsageFacts()
    expect(facts.sessions).toBe(1)
    expect(facts.messages).toBe(1)
  })

  it('stamps each message with the time it was appended', () => {
    const s = createSession(ROOT, 'a', 1_000)
    appendMessage(s.id, { id: 'm1', role: 'user', content: 'hi' }, 5_000)
    appendMessage(s.id, { id: 'm2', role: 'assistant', content: 'yo' }, 7_000)

    expect(readUsageFacts().timestamps).toEqual([5_000, 7_000])
  })

  it('keeps the first write’s timestamp when a streaming turn is re-upserted', () => {
    const s = createSession(ROOT, 'a', 1_000)
    appendMessage(s.id, { id: 'm1', role: 'assistant', content: '' }, 5_000)
    appendMessage(s.id, { id: 'm1', role: 'assistant', content: 'streamed' }, 9_000)

    expect(readUsageFacts().timestamps).toEqual([5_000])
  })

  it('dates pre-upgrade messages from their session', () => {
    const s = createSession(ROOT, 'a', 4_000)
    appendMessage(s.id, { id: 'm1', role: 'user', content: 'hi' }, 5_000)
    // Simulate a row written before the created_at column existed.
    getDb().prepare(`UPDATE messages SET created_at = NULL WHERE id = 'm1'`).run()

    expect(readUsageFacts().timestamps).toEqual([4_000])
  })

  it('estimates tokens from message bodies and tool payloads', () => {
    const s = createSession(ROOT, 'a', tick())
    appendMessage(s.id, { id: 'm1', role: 'user', content: 'x'.repeat(40) }, tick())

    const messagesOnly = readUsageFacts().tokens
    expect(messagesOnly).toBe(10) // 40 chars / 4

    appendToolOp(s.id, toolOp('t1', 'm1'), tick())
    const withTools = readUsageFacts().tokens
    expect(withTools).toBeGreaterThan(messagesOnly)
  })

  it('tallies assistant turns per model, busiest first', () => {
    const s = createSession(ROOT, 'a', tick())
    appendMessage(s.id, { id: 'm1', role: 'assistant', content: 'a', model: 'Sonnet' }, tick())
    appendMessage(s.id, { id: 'm2', role: 'assistant', content: 'b', model: 'Opus' }, tick())
    appendMessage(s.id, { id: 'm3', role: 'assistant', content: 'c', model: 'Opus' }, tick())
    // User turns and unstamped/blank models never enter the tally.
    appendMessage(s.id, { id: 'm4', role: 'user', content: 'q', model: 'Opus' }, tick())
    appendMessage(s.id, { id: 'm5', role: 'assistant', content: 'd' }, tick())
    appendMessage(s.id, { id: 'm6', role: 'assistant', content: 'e', model: '  ' }, tick())

    expect(readUsageFacts().models).toEqual([
      { model: 'Opus', count: 2 },
      { model: 'Sonnet', count: 1 }
    ])
  })

  it('spans every session in the database', () => {
    const a = createSession(ROOT, 'a', tick())
    const b = createSession('/other/root', 'b', tick())
    appendMessage(a.id, { id: 'm1', role: 'user', content: 'hi' }, tick())
    appendMessage(b.id, { id: 'm2', role: 'user', content: 'hi' }, tick())

    const facts = readUsageFacts()
    expect(facts.sessions).toBe(2)
    expect(facts.messages).toBe(2)
  })
})
