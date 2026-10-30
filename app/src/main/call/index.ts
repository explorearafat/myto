/**
 * Voice-call IPC registration: the seam between the renderer and the whole
 * call system. The renderer's only call responsibilities are (a) forwarding
 * its Firebase ID token so main can reach Firestore, and (b) hosting the
 * Chromium WebRTC peer + audio graph; everything else — presence, signaling,
 * the agent, TTS, execution, callbacks — lives here in main.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type { CallPeerControl, CallPeerEvent, CallStatusEvent } from '../../shared/types'
import { callAuth } from './auth-flow'
import { startPresence, stopPresence } from './presence'
import { CallbackManager } from './callback-manager'
import { CallSessionManager } from './call-session'
import { listCallTasks } from './db'

let sessions: CallSessionManager | null = null
let callbacks: CallbackManager | null = null
let bootstrapped = false

/** Broadcast a call lifecycle event to every window (the header indicator). */
function broadcastStatus(event: CallStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.CallStatus, event)
  }
}

/** Deliver a WebRTC control command to the renderer peer host. */
function sendPeerControl(msg: CallPeerControl): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.CallPeerControl, msg)
  }
}

export function registerCallIpc(userDataDir: string): void {
  // Renderer hands over its Firebase session (on sign-in, on refresh, on demand).
  ipcMain.handle(IpcChannel.CallAuthSync, (_event, idToken: string) => {
    const result = callAuth.syncToken(idToken)
    if (result.uid && !bootstrapped) {
      bootstrapped = true
      startPresence(callAuth, userDataDir)
      callbacks = new CallbackManager(callAuth, (event) => {
        console.log('[call] callback event:', event.kind, 'taskId' in event ? event.taskId : '')
      })
      sessions = new CallSessionManager({
        auth: callAuth,
        sendPeerControl,
        onStatus: broadcastStatus,
        onTaskTerminal: (task) => callbacks?.onTaskTerminal(task),
        onCallbackDelivered: (taskId) => callbacks?.markDelivered(taskId)
      })
      callbacks.attachSessions(sessions)
      sessions.start()
      callbacks.reconcileAtBoot()
    }
    return result
  })

  // Late-mounting renderer UI asks for the current snapshot.
  ipcMain.handle(IpcChannel.CallGetState, () => ({
    available: callAuth.available(),
    activeCallId: sessions?.getActiveCallId() ?? null,
    tasks: listCallTasks(20).map((t) => ({
      id: t.id,
      status: t.status,
      summary: t.summary,
      prompt: t.prompt,
      createdAt: t.createdAt
    }))
  }))

  // The renderer's WebRTC peer reports back.
  ipcMain.on(IpcChannel.CallPeerEvent, (_event, payload: CallPeerEvent) => {
    sessions?.onPeerEvent(payload)
  })
}

/** Graceful shutdown (app quit): end the call, go dark in presence. */
export function stopCallSystem(): void {
  sessions?.stop()
  stopPresence(callAuth)
}
