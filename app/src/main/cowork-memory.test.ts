import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureMytoDir,
  readJournal,
  recordGoal,
  recordNote,
  recordToolAction
} from './cowork-memory'
import type { ToolCall } from './tools/toolParser'

/** A real temp folder stands in for a Cowork working folder; each test resets it. */
const ROOT = mkdtempSync(join(tmpdir(), 'myto-coworkmem-'))
const mytoJournal = join(ROOT, '.myto', 'journal.md')
const legacyJournal = join(ROOT, '.sylor', 'journal.md')

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

/** Seed a legacy `.sylor/journal.md` with the given body (pre-rebrand history). */
function seedLegacy(body: string): void {
  mkdirSync(join(ROOT, '.sylor'), { recursive: true })
  writeFileSync(legacyJournal, body, 'utf8')
}

describe('ensureMytoDir', () => {
  it('creates .myto with a README explainer', () => {
    ensureMytoDir(ROOT)
    expect(existsSync(join(ROOT, '.myto'))).toBe(true)
    expect(readFileSync(join(ROOT, '.myto', 'README.md'), 'utf8')).toMatch(/# \.myto/)
  })

  it('migrates a legacy .sylor/journal.md into .myto on first creation', () => {
    seedLegacy('## 2026-01-01 — goal\nold work here\n')
    ensureMytoDir(ROOT)
    expect(existsSync(mytoJournal)).toBe(true)
    expect(readFileSync(mytoJournal, 'utf8')).toMatch(/old work here/)
  })

  it('is idempotent — a second call does not clobber the journal', () => {
    ensureMytoDir(ROOT)
    recordGoal(ROOT, 'build a site')
    ensureMytoDir(ROOT)
    expect(readJournal(ROOT)).toMatch(/build a site/)
  })
})

describe('readJournal', () => {
  it('returns "" for a folder with no memory', () => {
    expect(readJournal(ROOT)).toBe('')
  })

  it('reads the current .myto journal', () => {
    recordGoal(ROOT, 'ship the feature')
    expect(readJournal(ROOT)).toMatch(/ship the feature/)
  })

  it('falls back to a legacy .sylor journal when .myto has none', () => {
    seedLegacy('## 2026-01-01 — goal\nlegacy-only history\n')
    // No ensureMytoDir call, so .myto/journal.md does not exist yet.
    expect(readJournal(ROOT)).toMatch(/legacy-only history/)
  })
})

describe('recordNote (remember → project scope)', () => {
  it('appends a stamped note line and reads back', () => {
    expect(recordNote(ROOT, 'the API base url is /v2')).toBe(true)
    expect(readFileSync(mytoJournal, 'utf8')).toMatch(/note: the API base url is \/v2/)
    expect(readJournal(ROOT)).toMatch(/the API base url is/)
  })

  it('refuses an empty note or an empty workspace', () => {
    expect(recordNote(ROOT, '   ')).toBe(false)
    expect(recordNote('', 'something')).toBe(false)
  })
})

describe('recordToolAction', () => {
  const call = (name: string, input: Record<string, unknown>): ToolCall => ({
    block: '',
    name,
    input,
    error: null
  })

  it('journals a write with its path', () => {
    recordToolAction(ROOT, call('write_file', { path: 'index.html' }), 'Wrote 10 characters')
    expect(readJournal(ROOT)).toMatch(/wrote `index\.html`/)
  })

  it('does not journal read-only tools', () => {
    recordToolAction(ROOT, call('read_file', { path: 'index.html' }), 'contents')
    recordToolAction(ROOT, call('list_dir', { path: '.' }), 'a\nb')
    expect(readJournal(ROOT)).toBe('')
  })
})
