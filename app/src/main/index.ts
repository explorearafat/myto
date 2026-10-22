import { app, BrowserWindow, ipcMain } from 'electron'
import { join, basename, dirname } from 'node:path'
import { existsSync, cpSync } from 'node:fs'
import { IpcChannel } from '../shared/ipc'
import { createWindow } from './window'
import { cancelAllStreams, registerProviderIpc } from './provider-ipc'
import { registerSessionIpc } from './session-ipc'
import { registerProjectIpc } from './project-ipc'
import { registerAttachmentIpc } from './attachment-ipc'
import { registerAuthIpc } from './auth-ipc'
import { registerFileIpc } from './file-ipc'
import { registerCoworkIpc } from './cowork-ipc'
import { registerPreviewIpc } from './preview-ipc'
import { registerMcpIpc, syncConnectors, disposeConnectors } from './mcp-ipc'
import { registerVoiceIpc } from './voice-ipc'
import { registerScreenshotIpc } from './screenshot-ipc'
import { registerScheduledTasksIpc } from './scheduled-tasks-ipc'
import { registerTerminalIpc } from './terminal-ipc'
import { registerEditorIpc } from './editor-ipc'
import { syncSkills } from './skills/manager'
import { discoverSkills } from './skills/discovery'
import type { SkillConfig } from '../shared/types'
import { closeDb, setDbPath } from './db/db'
import { reconcileInterruptedRuns } from './db/sessions'
import { setUserDataDir, getSettings, setSettingsSavedListener } from './settings'
import { setUserMemoryDir } from './user-memory'
import { setTrayWindowOpener, applyTrayState, markQuitting, shouldKeepAlive } from './tray'

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
 * Without this, relaunching Myto while it's already running starts a SECOND
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

/**
 * One-time carry-over of local data from the pre-rebrand "Sylor" userData folder.
 *
 * `productName` (Myto) drives Electron's per-user data directory, so a rebranded build points
 * at `…/Myto` while existing installs kept their chats and settings under the sibling `…/Sylor`.
 * When the new folder has no database yet but the old one does, copy the old folder across so
 * upgrading users keep their history. Best-effort — never allowed to block startup, and it
 * never overwrites files already present in the new folder.
 */
function migrateLegacyUserData(): void {
  try {
    const current = app.getPath('userData')
    if (basename(current) !== 'Myto') return // dev run or a still-"Sylor" build: nothing to carry
    if (existsSync(join(current, 'sylor.db'))) return // already migrated
    const legacy = join(dirname(current), 'Sylor')
    if (!existsSync(join(legacy, 'sylor.db'))) return // no prior install to carry over
    cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false })
    console.log('[myto] carried local data over from the legacy Sylor folder')
  } catch (error) {
    console.error('[myto] legacy userData migration skipped:', error)
  }
}

/**
 * Discover file-based skills under `userData/skills` (best-effort). Returns the parsed
 * skills and logs any that were skipped, so a malformed SKILL.md is visible in the log
 * rather than silently missing. Never throws — a bad skills dir must not block startup.
 */
function loadFileSkills(): SkillConfig[] {
  try {
    const { skills, skipped } = discoverSkills(join(app.getPath('userData'), 'skills'))
    for (const s of skipped) console.warn(`[myto] skill skipped (${s.reason}): ${s.path}`)
    return skills
  } catch (error) {
    console.error('[myto] file-based skill discovery failed:', error)
    return []
  }
}

app.whenReady().then(() => {
  // Inject Electron's per-user paths here (not inside the modules) so the DB and
  // settings layers stay electron-free and unit-testable. Local-only, outside any
  // OneDrive-synced project dir. setUserDataDir must precede the first settings
  // read so caches populate from the right place.
  migrateLegacyUserData()
  setUserDataDir(app.getPath('userData'))
  setUserMemoryDir(app.getPath('userData'))
  setDbPath(join(app.getPath('userData'), 'sylor.db'))

  // Tag any assistant turn left empty by a reply that died with the previous
  // process, so it explains itself and offers Rewrite instead of rendering as a
  // blank, permanently-stuck bubble. Must run before the window loads a session.
  try {
    const tagged = reconcileInterruptedRuns()
    if (tagged > 0) console.log(`[myto] tagged ${tagged} interrupted assistant turn(s)`)
  } catch (error) {
    // Never let a startup housekeeping query block the app from opening.
    console.error('[myto] failed to reconcile interrupted runs:', error)
  }

  registerWindowControls()
  registerProviderIpc()
  registerSessionIpc()
  registerProjectIpc()
  registerAttachmentIpc()
  registerAuthIpc()
  registerFileIpc()
  registerCoworkIpc()
  registerPreviewIpc()
  registerMcpIpc()
  registerVoiceIpc()
  registerScreenshotIpc()
  registerScheduledTasksIpc()
  registerTerminalIpc()
  registerEditorIpc()

  createWindow()

  // Background autonomy (opt-in): let the tray's "Show Myto" re-open or focus a window,
  // then bring the tray up if the user has enabled keep-alive. With the flag off (the
  // default) this is a no-op and the app keeps its normal quit-on-last-window lifecycle.
  setTrayWindowOpener(() => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
    } else {
      createWindow()
    }
  })
  applyTrayState(getSettings().background.keepAliveInTray)

  // Register the enabled skills as tools up front (synchronous, cheap). Merge in any
  // file-based skills dropped under userData/skills (a folder with a SKILL.md, like
  // Claude Code's skills dir); symlinks are never followed and malformed files are
  // logged and skipped. Settings skills always win a slug collision.
  try {
    syncSkills(getSettings().skills, loadFileSkills())
  } catch (error) {
    console.error('[myto] skill sync failed:', error)
  }

  // Re-sync skills whenever settings are saved, so adding/editing a skill in the UI
  // takes effect on the next turn without a restart. (Connectors re-sync explicitly
  // from the renderer because they surface async connection status.)
  setSettingsSavedListener((settings) => {
    try {
      syncSkills(settings.skills, loadFileSkills())
    } catch (error) {
      console.error('[myto] skill re-sync failed:', error)
    }
    // Toggle the tray keep-alive live when the user flips it in Settings — no restart.
    try {
      applyTrayState(settings.background.keepAliveInTray)
    } catch (error) {
      console.error('[myto] tray reconcile failed:', error)
    }
  })

  // Connect to the user's enabled connectors in the background. Failure-isolated
  // inside the manager, so a dead server never blocks the window or a chat turn.
  void syncConnectors()

  app.on('activate', () => {
    // On macOS, re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length > 0) return
    createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS it's conventional to keep the app running until Cmd+Q.
  if (process.platform === 'darwin') return
  // Background autonomy (opt-in): when the user has enabled tray keep-alive, closing the
  // last window leaves Myto running in the tray (scheduled tasks / in-flight runs survive)
  // instead of quitting. Default OFF → quit exactly as before.
  try {
    if (shouldKeepAlive(getSettings().background.keepAliveInTray)) return
  } catch (error) {
    console.error('[myto] keep-alive check failed; quitting normally:', error)
  }
  app.quit()
})

app.on('before-quit', () => {
  // Mark the real quit so the tray never tries to keep the process alive past this point.
  markQuitting()
  // Abort any in-flight provider streams and close the DB so nothing outlives the app.
  cancelAllStreams()
  closeDb()
  // Close connector (MCP) connections — kills any spawned stdio server processes.
  void disposeConnectors()
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
  console.error('[myto] uncaught exception in main:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[myto] unhandled rejection in main:', reason)
})
