import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setUserMemoryDirForTest,
  readUserMemory,
  appendUserMemory
} from './user-memory'

/**
 * Global user memory is the electron-free twin of settings/db: the userData dir is
 * INJECTED, so a throwaway temp dir stands in for it here. Each test resets the dir.
 */
const ROOT = mkdtempSync(join(tmpdir(), 'myto-usermem-'))
const memFile = join(ROOT, 'memory.md')

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
  __setUserMemoryDirForTest(ROOT)
})

describe('readUserMemory', () => {
  it('returns "" when nothing has been written yet', () => {
    expect(readUserMemory()).toBe('')
  })

  it('returns "" when no userData dir has been injected', () => {
    __setUserMemoryDirForTest(null)
    expect(readUserMemory()).toBe('')
  })

  it('reads back what was appended', () => {
    appendUserMemory('The user prefers pnpm')
    expect(readUserMemory()).toMatch(/The user prefers pnpm/)
  })

  it('caps a huge memory to its recent tail', () => {
    // Write well past the 8000-char read cap; the newest content must survive.
    for (let i = 0; i < 400; i++) appendUserMemory(`fact number ${i} padded ${'x'.repeat(40)}`)
    const out = readUserMemory()
    expect(out.length).toBeLessThan(8200)
    expect(out).toMatch(/earlier notes trimmed/)
    expect(out).toMatch(/fact number 399/)
  })
})

describe('appendUserMemory', () => {
  it('creates the file and stamps each fact with a date + bullet', () => {
    expect(existsSync(memFile)).toBe(false)
    expect(appendUserMemory('deploy with vercel')).toBe(true)
    const text = readFileSync(memFile, 'utf8')
    expect(text).toMatch(/^- \(\d{4}-\d{2}-\d{2}\) deploy with vercel$/m)
  })

  it('appends rather than overwrites', () => {
    appendUserMemory('first')
    appendUserMemory('second')
    const text = readFileSync(memFile, 'utf8')
    expect(text).toMatch(/first/)
    expect(text).toMatch(/second/)
  })

  it('refuses an empty fact', () => {
    expect(appendUserMemory('   ')).toBe(false)
    expect(existsSync(memFile)).toBe(false)
  })

  it('refuses when no userData dir is injected', () => {
    __setUserMemoryDirForTest(null)
    expect(appendUserMemory('nowhere to go')).toBe(false)
  })

  it('trims the file on disk once it grows past the byte cap', () => {
    // Seed a file already larger than the 40k on-disk cap, then append once.
    writeFileSync(memFile, `- (2020-01-01) ${'a'.repeat(45_000)}\n`, 'utf8')
    appendUserMemory('the newest fact')
    const text = readFileSync(memFile, 'utf8')
    expect(text.length).toBeLessThan(41_000)
    expect(text).toMatch(/earlier notes trimmed/)
    expect(text).toMatch(/the newest fact/)
  })
})
