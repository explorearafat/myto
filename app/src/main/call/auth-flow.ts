/**
 * Call-system auth: bridges the RENDERER's Firebase session into the main
 * process. The renderer (already signed in via the AuthGate) forwards its
 * Firebase ID token over `call:auth-sync`; this module installs it on the
 * Firestore REST client and starts/stops the presence + signaling loops as auth
 * becomes available or expires. The renderer also re-sends the token every
 * ~25 minutes (ID tokens live one hour) and on `call:auth-needed`.
 */
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import { getSettings } from '../settings'
import { FirestoreRest } from './firestore-rest'

export class CallAuth {
  readonly rest: FirestoreRest
  private readyNotified = false
  private listeners = new Set<(uid: string) => void>()

  constructor() {
    this.rest = new FirestoreRest({
      onAuthExpired: () => this.requestFreshToken()
    })
  }

  /** Called from the `call:auth-sync` IPC handler with the renderer's token. */
  syncToken(idToken: string): { uid: string | null } {
    if (typeof idToken !== 'string' || idToken.length < 20) return { uid: null }
    const uid = this.rest.setToken(idToken)
    if (uid && !this.readyNotified) {
      this.readyNotified = true
      for (const l of this.listeners) l(uid)
    }
    return { uid }
  }

  /** Subscribe to "auth became available" (fires once per app run). */
  onReady(listener: (uid: string) => void): void {
    this.listeners.add(listener)
    const uid = this.rest.getUid()
    if (uid && this.readyNotified) listener(uid)
  }

  /** Is calling currently enabled in settings, and are we authenticated? */
  available(): boolean {
    return this.rest.hasAuth() && getSettings().call.enabled
  }

  /**
   * Ask the renderer for a fresh token (401 recovery). Best-effort: fires the
   * request at every live window; the renderer answers via `call:auth-sync`.
   */
  requestFreshToken(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.CallAuthNeeded, {})
    }
  }
}

/** Singleton — the call modules all share one auth/REST session. */
export const callAuth = new CallAuth()
