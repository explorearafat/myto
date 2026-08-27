import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { PreviewEvent } from '../shared/types'
import { setPreviewEmitter, startAuto, startDev, startStatic, stopPreview } from './preview/server'

/**
 * Registers the live-preview IPC. `start-static`/`start-dev` are invoke/handle
 * (the renderer awaits the resolved URL), while lifecycle events — `ready` from
 * a boot, `reload` from the file watcher, `error` from a failed dev server —
 * arrive asynchronously, so the server pushes them through a persistent sink.
 *
 * That sink broadcasts to every open window (Sylor is single-window in practice)
 * because a watcher `reload` isn't tied to any one renderer request.
 */
export function registerPreviewIpc(): void {
  setPreviewEmitter((payload: PreviewEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.PreviewEvent, payload)
    }
  })

  ipcMain.handle(IpcChannel.PreviewStartStatic, (_event: IpcMainInvokeEvent, entry?: string) =>
    startStatic(entry)
  )
  ipcMain.handle(IpcChannel.PreviewStartDev, (_event: IpcMainInvokeEvent, command: string) =>
    startDev(command)
  )
  ipcMain.handle(IpcChannel.PreviewStartAuto, (_event: IpcMainInvokeEvent, entry?: string) =>
    startAuto(entry)
  )
  ipcMain.on(IpcChannel.PreviewStop, () => {
    stopPreview()
  })
}
