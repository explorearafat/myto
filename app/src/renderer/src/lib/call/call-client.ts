/**
 * Renderer-side call client bootstrap: keeps main's Firestore session
 * authenticated with the renderer's Firebase tokens and hosts the WebRTC peer.
 * Mounted once from App.tsx; returns a disposer for hot reloads.
 */
import { onIdTokenChanged } from 'firebase/auth'
import { auth } from '../firebase'
import { startCallPeerHost } from './webrtc-bridge'

export function startCallClient(): () => void {
  // Host the WebRTC peer + audio graph (idempotent listener registration).
  startCallPeerHost()

  // Forward the Firebase session to main: on sign-in, on every token refresh,
  // and whenever main reports a 401 (CallAuthNeeded). A 30-minute safety-net
  // re-send covers the case where the renderer tab is idle and the token
  // silently lapses.
  let lastToken = ''
  const push = async (): Promise<void> => {
    try {
      const token = await auth.currentUser?.getIdToken()
      if (token && token !== lastToken) {
        lastToken = token
        await window.myto.call.authSync(token)
      }
    } catch {
      /* signed out — nothing to sync */
    }
  }

  const unsubToken = onIdTokenChanged(auth, () => {
    void push()
  })
  const unsubNeeded = window.myto.call.onAuthNeeded(() => {
    lastToken = ''
    void push()
  })
  const interval = window.setInterval(() => void push(), 30 * 60 * 1000)
  void push()

  return () => {
    unsubToken()
    unsubNeeded()
    clearInterval(interval)
  }
}
