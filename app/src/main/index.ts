import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { IpcChannel } from '../shared/ipc'
import { createWindow } from './window'
import { cancelAllStreams, registerProviderIpc } from './provider-ipc'
import { registerSessionIpc } from './session-ipc'
import { registerProjectIpc } from './project-ipc'
import { registerAttachmentIpc } from './attachment-ipc'
import { registerAuthIpc } from './auth-ipc'
import { registerFileIpc } from './file-ipc'
import { registerCoworkIpc } from './cowork-ipc'
import { closeDb, setDbPath } from './db/db'
import { reconcileInterruptedRuns } from './db/sessions'
import { setUserDataDir } from './settings'

/** Registers window-control IPC handlers used by the custom title bar. */
function registerWindowControls(): void {
  ipcMain.on(IpcChannel.WindowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on(IpcChannel.WindowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  ipcMain.on(IpcChannel.WindowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(IpcChannel.WindowIsMaximized, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
}

/*
 * Single-instance lock.
 *
 * Without this, relaunching Sylor while it's already running starts a SECOND
 * process that opens the same sqlite file. The two fight over the DB (the loser's
 * writes hit SQLITE_BUSY and are swallowed by the IPC `safe()` wrapper), and the
 * newcomer shows a fresh, empty chat while the real one — with the in-flight run —
 * is still alive behind it. That reads exactly like "I reopened the app and my
 * task/prompt vanished".
 *
 * The second instance exits immediately and hands focus to the original, so there
 * is always exactly one owner of the DB and of any running reply.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A relaunch attempt: surface the existing window instead of opening a new app.
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
    }
  })
}

app.whenReady().then(() => {
  // Inject Electron's per-user paths here (not inside the modules) so the DB and
  // settings layers stay electron-free and unit-testable. Local-only, outside any
  // OneDrive-synced project dir. setUserDataDir must precede the first settings
  // read so caches populate from the right place.
  setUserDataDir(app.getPath('userData'))
  setDbPath(join(app.getPath('userData'), 'sylor.db'))

  // Tag any assistant turn left empty by a reply that died with the previous
  // process, so it explains itself and offers Rewrite instead of rendering as a
  // blank, permanently-stuck bubble. Must run before the window loads a session.
  try {
    const tagged = reconcileInterruptedRuns()
    if (tagged > 0) console.log(`[sylor] tagged ${tagged} interrupted assistant turn(s)`)
  } catch (error) {
    // Never let a startup housekeeping query block the app from opening.
    console.error('[sylor] failed to reconcile interrupted runs:', error)
  }

  registerWindowControls()
  registerProviderIpc()
  registerSessionIpc()
  registerProjectIpc()
  registerAttachmentIpc()
  registerAuthIpc()
  registerFileIpc()
  registerCoworkIpc()

  createWindow()

  app.on('activate', () => {
    // On macOS, re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length > 0) return
    createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS it's conventional to keep the app running until Cmd+Q.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Abort any in-flight provider streams and close the DB so nothing outlives the app.
  cancelAllStreams()
  closeDb()
})

/*
 * Keep the main process alive through a stray fault.
 *
 * Node's default for an uncaught exception is to kill the process — and killing
 * the main process kills the window, mid-write, with no chance to flush. That is
 * the harshest version of the "app died and my data was gone" report. Nothing here
 * tries to *repair* the fault; it logs it and lets the app keep running so the user
 * can finish or close cleanly. IPC handlers already wrap their own work, so
 * anything reaching this point is genuinely unexpected.
 */
process.on('uncaughtException', (error) => {
  console.error('[sylor] uncaught exception in main:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[sylor] unhandled rejection in main:', reason)
})
