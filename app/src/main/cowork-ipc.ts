import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'

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

export function registerCoworkIpc(): void {
  ipcMain.handle(IpcChannel.CoworkPickWorkspace, (event) => pickWorkspace(event))
}
