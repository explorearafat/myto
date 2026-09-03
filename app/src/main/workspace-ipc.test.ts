import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { contextManager } from '@main/context/manager'
import { applyRoot, registerWorkspaceIpc, setActiveRoot } from '@main/workspace-ipc'

/**
 * Exercises the workspace root-switch surface (Problem 2) against the REAL
 * {@link contextManager} (electron-free) with its fan-out collaborators mocked.
 * The decisive assertion: {@link setActiveRoot} — used when opening a past chat —
 * re-points the root WITHOUT persisting it, while {@link applyRoot} — an explicit
 * folder pick — DOES persist. So reopening an old conversation restores its own
 * folder for that session yet never changes the default folder for new chats or
 * the next launch (decision Q2).
 */

// Electron is unavailable under vitest; the SUT imports BrowserWindow/dialog/ipcMain
// at module top. broadcastWorkspace only needs getAllWindows() → [] (no renderers).
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: vi.fn() }
}))

// Collaborators the root switch fans out to. Hoisted so the mock factories below
// (lifted above the imports by vitest) can close over the same spies the tests read.
const { setProjectRoot, reload, saveSettings } = vi.hoisted(() => ({
  setProjectRoot: vi.fn(),
  reload: vi.fn(),
  saveSettings: vi.fn()
}))
vi.mock('@main/mcp/manager', () => ({ mcpManager: { setProjectRoot } }))
vi.mock('@main/skills/registry', () => ({ skillsRegistry: { reload } }))
vi.mock('@main/settings', () => ({
  getSettings: () => ({ ui: { workspaceRoot: null } }),
  saveSettings
}))

let dirA: string
let dirB: string
let originalRoot: string

beforeAll(() => {
  originalRoot = contextManager.getRoot()
  dirA = mkdtempSync(join(tmpdir(), 'sylor-ws-a-'))
  dirB = mkdtempSync(join(tmpdir(), 'sylor-ws-b-'))
})

afterAll(() => {
  contextManager.setRoot(originalRoot)
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

beforeEach(() => {
  setProjectRoot.mockClear()
  reload.mockClear()
  saveSettings.mockClear()
})

describe('setActiveRoot (open a past chat: re-point WITHOUT persisting)', () => {
  it('re-points the context manager + collaborators and returns the folder as chosen', () => {
    const info = setActiveRoot(dirA)

    expect(info).toEqual({ root: dirA, chosen: true })
    expect(contextManager.getRoot()).toBe(dirA)
    expect(setProjectRoot).toHaveBeenCalledWith(dirA)
    expect(reload).toHaveBeenCalledWith(dirA)
    // The whole point of the fix: opening a past chat must NOT change the persisted
    // default folder. Only applyRoot (an explicit folder pick) saves settings.
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('is a no-op for a missing/moved folder — keeps the current root, never throws', () => {
    setActiveRoot(dirA) // establish a known-good current root
    setProjectRoot.mockClear()
    reload.mockClear()

    const info = setActiveRoot(join(dirA, 'deleted-since'))

    expect(info.root).toBe(dirA) // unchanged
    expect(contextManager.getRoot()).toBe(dirA)
    expect(setProjectRoot).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
  })
})

describe('applyRoot (explicit folder pick: re-point AND persist)', () => {
  it('persists the chosen folder — the one line that separates it from setActiveRoot', () => {
    applyRoot(dirB)

    expect(contextManager.getRoot()).toBe(dirB)
    expect(setProjectRoot).toHaveBeenCalledWith(dirB)
    expect(reload).toHaveBeenCalledWith(dirB)
    expect(saveSettings).toHaveBeenCalledOnce()
  })
})

describe('WorkspaceSetRoot IPC handler', () => {
  it('returns current info without re-pointing on an empty/non-string dir', () => {
    setActiveRoot(dirA)
    setProjectRoot.mockClear()

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      }
    )
    registerWorkspaceIpc()

    const handler = handlers.get(IpcChannel.WorkspaceSetRoot)!
    // Empty string → the guard returns currentInfo() (chosen=false via the settings
    // mock), which is distinct from a successful setActiveRoot (always chosen=true).
    expect(handler({}, '')).toEqual({ root: dirA, chosen: false })
    expect(setProjectRoot).not.toHaveBeenCalled()
  })
})
