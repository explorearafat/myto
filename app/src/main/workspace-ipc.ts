import { BrowserWindow, dialog, ipcMain } from 'electron'
import { statSync } from 'node:fs'
import { IpcChannel } from '../shared/ipc'
import type { WorkspaceInfo } from '../shared/types'
import { contextManager } from './context/manager'
import { mcpManager } from './mcp/manager'
import { skillsRegistry } from './skills/registry'
import { getSettings, saveSettings } from './settings'

/**
 * Workspace (folder-first Code mode; requirement A).
 *
 * Code mode is a folder agent, but until this subsystem there was no way to
 * choose that folder — {@link contextManager} silently defaulted to
 * `process.cwd()` (the install dir in a packaged build). Selecting a folder here
 * retargets the single source of truth for the project root, which the engine,
 * live preview, fs sandbox, and pty all read at call time; MCP and skills are
 * pointed at the new project too so their root-specific `.sylor/*` config
 * reloads on the next turn. The choice is persisted so the workspace is restored
 * next launch (see {@link ./settings} + {@link applyRoot}).
 *
 * Everything stays sandbox-scoped to the chosen root — this only *moves* the
 * sandbox; it never widens it.
 */

/** Broadcast the new workspace to every renderer so stores can react. */
function broadcastWorkspace(info: WorkspaceInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.WorkspaceChanged, info)
  }
}

/** The current root + whether it was explicitly chosen (persisted) vs the cwd default. */
function currentInfo(): WorkspaceInfo {
  return { root: contextManager.getRoot(), chosen: !!getSettings().ui.workspaceRoot }
}

/**
 * Applies a chosen root everywhere and persists it. Retargets the context manager
 * (engine/preview/fs/pty read it live), repoints MCP + re-scans skills so their
 * project `.sylor/*` config reloads, saves `workspaceRoot`, then broadcasts. MCP
 * is only repointed (cheap + sync) — the actual reconnect is lazy, happening on
 * the next agent turn via `ensureConnected(root)`, so picking a folder never
 * blocks on a slow server handshake.
 */
export function applyRoot(dir: string): WorkspaceInfo {
  contextManager.setRoot(dir)
  mcpManager.setProjectRoot(dir)
  skillsRegistry.reload(dir)
  const settings = getSettings()
  saveSettings({ ...settings, ui: { ...settings.ui, workspaceRoot: dir } })
  const info: WorkspaceInfo = { root: dir, chosen: true }
  broadcastWorkspace(info)
  return info
}

/**
 * Re-points the active root to an already-known folder WITHOUT persisting it as
 * the default (used when opening a past conversation, to restore its own
 * `projectRoot`). Identical to {@link applyRoot} except it deliberately omits the
 * `saveSettings` line — so the folder for brand-new chats and the next launch
 * stays the user's last *explicit* pick, not whichever old chat they last opened.
 *
 * A missing/invalid `dir` (folder deleted or moved) is a no-op: the current root
 * is kept and its info returned, so opening a stale conversation never crashes or
 * silently drops the sandbox onto a bad path.
 */
export function setActiveRoot(dir: string): WorkspaceInfo {
  let isDir = false
  try {
    isDir = statSync(dir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) return currentInfo()
  contextManager.setRoot(dir)
  mcpManager.setProjectRoot(dir)
  skillsRegistry.reload(dir)
  const info: WorkspaceInfo = { root: dir, chosen: true }
  broadcastWorkspace(info)
  return info
}

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IpcChannel.WorkspaceGet, () => currentInfo())

  ipcMain.handle(IpcChannel.WorkspaceSetRoot, (_event, dir: string): WorkspaceInfo => {
    if (typeof dir !== 'string' || dir.length === 0) return currentInfo()
    return setActiveRoot(dir)
  })

  ipcMain.handle(IpcChannel.WorkspaceSelect, async (event): Promise<WorkspaceInfo | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Select a folder to work in',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return applyRoot(result.filePaths[0])
  })
}
