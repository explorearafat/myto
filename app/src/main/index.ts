import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IpcChannel } from '../shared/ipc'
import { createWindow } from './window'
import { cancelAllStreams, registerProviderIpc } from './provider-ipc'
import { registerWorkflowIpc } from './workflow-ipc'
import { registerSessionIpc } from './session-ipc'
import { registerProjectIpc } from './project-ipc'
import { registerAttachmentIpc } from './attachment-ipc'
import { registerPreviewIpc } from './preview-ipc'
import { registerMcpIpc } from './mcp-ipc'
import { registerSkillsIpc } from './skills-ipc'
import { registerCommandsIpc } from './commands-ipc'
import { registerPluginsIpc } from './plugins-ipc'
import { registerWorkspaceIpc } from './workspace-ipc'
import { registerMemoryIpc } from './memory-ipc'
import { closeChrome, registerChromeIpc } from './chrome-ipc'
import { attachBrowserWindow, registerBrowserIpc } from './browser-ipc'
import { registerSchedulerIpc, stopScheduler } from './scheduler-ipc'
import { configureBrowserSession } from './browser/session'
import { destroyBrowserView } from './browser/view'
import { cancelAllWorkflows } from './workflow/engine'
import { killAllPtys } from './terminal/pty'
import { stopPreview } from './preview/server'
import { mcpManager, setMcpBrowserOpener } from './mcp/manager'
import { contextManager } from './context/manager'
import { closeDb, setDbPath } from './db/db'
import { reconcileInterruptedRuns } from './db/sessions'
import { getSettings, setUserDataDir } from './settings'

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
 * process that opens the same sqlite file and the same workspace. The two fight
 * over the DB (the loser's writes hit SQLITE_BUSY and are swallowed by the IPC
 * `safe()` wrapper), and the newcomer shows a fresh, empty chat while the real
 * one — with the in-flight run — is still alive behind it. That reads exactly
 * like "I reopened the app and my task/prompt vanished".
 *
 * The second instance exits immediately and hands focus to the original, so
 * there is always exactly one owner of the DB and of any running task.
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
  // settings layers stay electron-free and unit-testable — the same seam the
  // headless CLI (Phase 6) uses to drive the engine without a GUI. Local-only,
  // outside any OneDrive-synced project dir. setUserDataDir must precede the first
  // settings read (getSettings below) so caches populate from the right place.
  setUserDataDir(app.getPath('userData'))
  setDbPath(join(app.getPath('userData'), 'sylor.db'))

  // Tag any assistant turn left empty by a run that died with the previous
  // process, so it explains itself and offers Rewrite instead of rendering as a
  // blank, permanently-stuck bubble. Must run before the window loads a session.
  try {
    const tagged = reconcileInterruptedRuns()
    if (tagged > 0) console.log(`[sylor] tagged ${tagged} interrupted assistant turn(s)`)
  } catch (error) {
    // Never let a startup housekeeping query block the app from opening.
    console.error('[sylor] failed to reconcile interrupted runs:', error)
  }

  // Restore the persisted working folder (requirement A) before any window or
  // subsystem reads the root, so the engine/preview/MCP/skills all start scoped
  // to the folder the user last chose. Absent on first launch → cwd default.
  const savedRoot = getSettings().ui.workspaceRoot
  if (savedRoot) {
    contextManager.setRoot(savedRoot)
    mcpManager.setProjectRoot(savedRoot)
  }

  // An OAuth MCP server's consent screen belongs in the user's real browser, never
  // in an app window: they can see the address bar and their password manager
  // works. Wired here so `mcp/oauth.ts` itself stays Electron-free (and testable).
  setMcpBrowserOpener((url) => shell.openExternal(url))

  registerWindowControls()
  registerProviderIpc()
  registerWorkflowIpc()
  registerSessionIpc()
  registerProjectIpc()
  registerAttachmentIpc()
  registerPreviewIpc()
  registerMcpIpc()
  registerSkillsIpc()
  registerCommandsIpc()
  registerPluginsIpc()
  registerWorkspaceIpc()
  registerMemoryIpc()
  // The user's real Chrome, driven over DevTools — the path for every site the
  // embedded page view can't sign in to (see chrome-ipc.ts).
  registerChromeIpc()
  // The in-app page view the `browse` tool drives, drawn inside the chat window.
  registerBrowserIpc()
  // Scheduled tasks (Phase 4): rehydrate durable tasks from the DB and start the
  // tick loop. Registered after the DB path is set above so the store can read.
  registerSchedulerIpc()
  // Present the browsing partition as ordinary desktop Chrome so real sign-ins
  // don't reject it as an "insecure" embedded browser.
  configureBrowserSession()
  attachBrowserWindow(createWindow())

  app.on('activate', () => {
    // On macOS, re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) attachBrowserWindow(createWindow())
  })
})

app.on('window-all-closed', () => {
  // On macOS it's conventional to keep the app running until Cmd+Q.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Abort any in-flight provider streams and workflow runs, tear down the
  // preview server, disconnect MCP servers, and kill live ptys, so nothing
  // outlives the app.
  cancelAllStreams()
  cancelAllWorkflows()
  stopScheduler()
  stopPreview()
  void mcpManager.disconnectAll()
  // Close the controlled browser too: its debugging port is a capability that must
  // not outlive Sylor.
  void closeChrome()
  destroyBrowserView()
  killAllPtys()
  closeDb()
})

/*
 * Keep the main process alive through a stray fault.
 *
 * Node's default for an uncaught exception is to kill the process — and killing
 * the main process kills the window, mid-write, with no chance to flush. That is
 * the harshest version of the "app died and my data was gone" report: a rejected
 * promise in a tool handler or an MCP transport could take the whole app down.
 * Nothing here tries to *repair* the fault; it logs it and lets the app keep
 * running so the user can finish or close cleanly. IPC handlers already wrap their
 * own work, so anything reaching this point is genuinely unexpected.
 */
process.on('uncaughtException', (error) => {
  console.error('[sylor] uncaught exception in main:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[sylor] unhandled rejection in main:', reason)
})
