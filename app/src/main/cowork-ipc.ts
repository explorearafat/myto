import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { CredentialInput, CredentialMeta } from '../shared/types'
import { getSettings } from './settings'
import { listWorkspaceFiles } from './tools/search'
import { resolveInWorkspace } from './tools/fs'
import { openBrowserSetup } from './cowork-browser-setup'
import { listCredentialMeta, saveCredential, deleteCredential } from './credential-vault'

/*
 * Cowork working-folder picker.
 *
 * Cowork's filesystem tools are sandboxed to one folder the user chooses. This
 * handler opens the native "choose folder" dialog (parented to the requesting
 * window) and returns the absolute path picked, or null when the user cancels.
 * Nothing is persisted here — the renderer takes the path and saves it into
 * settings.cowork.workspaceDir through the ordinary settings store, which is what
 * actually scopes the tools (see tools/fs.ts). Picking the folder is the user's
 * explicit opt-in to Myto reading and writing inside it.
 */
async function pickWorkspace(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
  try {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a working folder for Cowork',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  } catch (error) {
    console.error('[myto] cowork workspace picker failed:', error)
    return null
  }
}

/*
 * `@file` mention lister (#7).
 *
 * The composer's `@` popover asks for workspace-relative paths matching what the
 * user has typed so far. The working folder is authoritative here — the renderer
 * never passes a root — so we read `cowork.workspaceDir` from settings and hand it
 * to {@link listWorkspaceFiles}, which walks it through the same sandbox chokepoint
 * ({@link resolveInWorkspace}) the fs tools use. With no folder chosen we return an
 * empty list, so the popover simply shows nothing rather than leaking anything
 * outside a Cowork sandbox.
 */
async function listFiles(query: unknown): Promise<string[]> {
  try {
    const dir = getSettings().cowork.workspaceDir
    if (!dir) return []
    // Re-resolve through the sandbox chokepoint: a torn/relative setting can't send
    // the walk outside the chosen folder.
    const root = resolveInWorkspace(dir, '.')
    if (!root) return []
    return await listWorkspaceFiles(root, typeof query === 'string' ? query : '')
  } catch (error) {
    console.error('[myto] cowork file lister failed:', error)
    return []
  }
}

/**
 * The Cowork working folder the credential vault is scoped to, or null when none is
 * chosen. Credentials live in that folder's git-ignored `.data/<site>/`, so with no
 * folder there is nowhere to read or write them.
 */
function currentWorkspaceDir(): string | null {
  const dir = getSettings().cowork.workspaceDir.trim()
  return dir || null
}

export function registerCoworkIpc(): void {
  ipcMain.handle(IpcChannel.CoworkPickWorkspace, (event) => pickWorkspace(event))
  ipcMain.handle(IpcChannel.CoworkListFiles, (_event, query: unknown) => listFiles(query))
  // Open the human-driven "Setup Myto Browser" window (manual logins on the shared profile).
  ipcMain.handle(IpcChannel.BrowserOpenSetup, () => {
    openBrowserSetup()
  })

  // Credential vault (Settings › Credentials). These are the mirror image of the
  // `save_credential` / `list_credentials` / `delete_credential` chat tools: the Settings
  // UI drives the SAME per-site encrypted store, scoped to the Cowork working folder.
  // Only masked metadata (CredentialMeta — no secret values) ever crosses back to the
  // renderer; the plaintext lives solely in the main process on its way into safeStorage.
  ipcMain.handle(IpcChannel.CredentialsList, (): CredentialMeta[] => {
    const dir = currentWorkspaceDir()
    return dir ? listCredentialMeta(dir) : []
  })
  ipcMain.handle(IpcChannel.CredentialsSave, (_event, input: CredentialInput): CredentialMeta[] => {
    const dir = currentWorkspaceDir()
    // No folder chosen → nowhere to store it. Reject so the UI shows a clear reason
    // rather than silently dropping the secret. saveCredential also throws when
    // safeStorage is unavailable or the input is malformed (no plaintext fallback).
    if (!dir) throw new Error('Choose a Cowork working folder before saving a credential.')
    return saveCredential(dir, input)
  })
  ipcMain.handle(IpcChannel.CredentialsDelete, (_event, site: unknown): CredentialMeta[] => {
    const dir = currentWorkspaceDir()
    if (!dir) return []
    return deleteCredential(dir, typeof site === 'string' ? site : '')
  })
}
