import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import { runCommand } from '@main/terminal/runner'
import { ptyAvailable } from '@main/terminal/pty'

/**
 * Real integration tests — these spawn an ACTUAL pty (no mocks) to prove the
 * agent command path streams live output and reports real exit codes. They skip
 * automatically when the native pty backend can't load in this environment (e.g.
 * an ABI mismatch), mirroring the app's own runtime load guard. A throwaway cwd
 * keeps them hermetic.
 */
const MARK = 'SYLOR_RUN_OK'
let root: string
let originalRoot: string

beforeAll(() => {
  originalRoot = contextManager.getRoot()
  root = mkdtempSync(join(tmpdir(), 'sylor-run-'))
  contextManager.setRoot(root)
})

afterAll(() => {
  contextManager.setRoot(originalRoot)
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!ptyAvailable())('runCommand (real pty)', () => {
  it(
    'streams output live and resolves exitCode 0 for a successful command',
    async () => {
      let streamed = ''
      const result = await runCommand(`echo ${MARK}`, (d) => {
        streamed += d
      })
      expect(result.exitCode).toBe(0)
      // Captured buffer and the live stream both carry the command output.
      expect(result.output).toContain(MARK)
      expect(streamed).toContain(MARK)
      expect(result.truncated).toBe(false)
      // The captured copy is read by the model and shown on a tool card, so it
      // carries no terminal control bytes — a real pty (ConPTY especially) sprays
      // cursor and erase sequences around every command it runs.
      expect(result.output).not.toContain('\x1b')
    },
    20_000
  )

  it(
    'resolves exitCode null when the command is aborted',
    async () => {
      const ctrl = new AbortController()
      ctrl.abort() // pre-aborted: runCommand kills the pty and settles as aborted
      const result = await runCommand(`echo ${MARK}`, () => {}, ctrl.signal)
      expect(result.exitCode).toBeNull()
    },
    20_000
  )
})
