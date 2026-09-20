import { basename, extname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { FileSaveResult } from '../shared/types'

/*
 * Save-a-file handler for the chat's file cards.
 *
 * The desktop app is a plain chatbot — it never writes to disk on its own. When
 * the user clicks Download on a generated file card, the renderer sends the
 * suggested filename and the file's text here; we show a native Save As dialog
 * (parented to the requesting window) and write the bytes to the chosen path.
 * Nothing is written unless the user picks a location, and the suggested name is
 * reduced to a bare basename so a model-authored path can't steer the dialog
 * outside where the user is looking.
 */

/** Offer a type-specific filter (plus All Files) so the OS suggests the right kind. */
function filtersFor(name: string): Electron.FileFilter[] {
  const ext = extname(name).replace(/^\./, '').toLowerCase()
  const all: Electron.FileFilter = { name: 'All Files', extensions: ['*'] }
  if (!ext) return [all]
  return [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }, all]
}

async function saveFile(
  event: Electron.IpcMainInvokeEvent,
  name: string,
  content: string
): Promise<FileSaveResult> {
  try {
    const suggested = basename(name) || 'file.txt'
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = { defaultPath: suggested, filters: filtersFor(suggested) }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)

    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await writeFile(result.filePath, content, 'utf8')
    return { ok: true, path: result.filePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save the file.' }
  }
}

export function registerFileIpc(): void {
  ipcMain.handle(IpcChannel.FilesSave, (event, name: string, content: string) =>
    saveFile(event, name, content)
  )
}
