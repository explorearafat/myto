/**
 * Desktop presence + device pairing.
 *
 * Two Firestore paths, both owner-only by the existing rules:
 *  - `users/{uid}/config/desktop`            — the live presence doc the phone
 *    reads to decide whether "Call Myto" can connect (online / busy / offline is
 *    just `lastSeen` freshness + the `busy` flag).
 *  - `users/{uid}/config/desktopDevices/{id}`— the pairing registry written once
 *    per device install. The desktop writes itself here; the user can revoke a
 *    device by flipping `revoked` (Settings UI / console) and this install then
 *    stands itself down on the next heartbeat.
 *
 * Heartbeats are wall-clock epoch ms (Firestore REST has no serverTimestamp
 * transform), refreshed every 15s. The phone treats >45s staleness as offline.
 */
import { app } from 'electron'
import os from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSettings } from '../settings'
import type { DesktopDeviceDoc, DesktopPresenceDoc } from './types'
import type { RestValue } from './firestore-rest'
import type { CallAuth } from './auth-flow'
import { isBusyForCalls } from './busy-state'

const HEARTBEAT_MS = 15_000
const STALE_AFTER_MS = 45_000

/** Is a presence doc fresh enough to trust? Shared shape with the phone. */
export function isPresenceFresh(doc: DesktopPresenceDoc | null | undefined, now = Date.now()): boolean {
  return doc !== null && doc !== undefined && typeof doc.ts === 'number' && now - doc.ts < STALE_AFTER_MS
}

let heartbeatTimer: NodeJS.Timeout | null = null
let started = false
let currentDeviceId: string | null = null

/** The stable per-install device id (persisted once in userData/call-device.json). */
export function deviceId(userDataDir: string): string {
  if (currentDeviceId) return currentDeviceId
  const file = join(userDataDir, 'call-device.json')
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { deviceId?: string }
      if (raw.deviceId) {
        currentDeviceId = raw.deviceId
        return currentDeviceId
      }
    }
  } catch {
    /* fall through: rewrite a fresh one */
  }
  currentDeviceId = randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ deviceId: currentDeviceId }, null, 2) + '\n', 'utf8')
  } catch (error) {
    console.error('[call] could not persist device id:', error)
  }
  return currentDeviceId
}

/**
 * Start the presence loop. Registers this install in the pairing registry
 * (once per run), then heartbeats the live presence doc until stopped. No-op
 * while unauthenticated; the auth-ready callback (re)starts it.
 */
export function startPresence(auth: CallAuth, userDataDir: string): void {
  if (started) return
  started = true
  const id = deviceId(userDataDir)

  const registerDevice = async (): Promise<void> => {
    const uid = auth.rest.getUid()
    if (!uid || !auth.rest.hasAuth()) return
    const doc: DesktopDeviceDoc = {
      deviceName: os.hostname(),
      platform: 'windows',
      version: app.getVersion(),
      addedAt: Date.now(),
      lastSeen: Date.now(),
      revoked: false
    }
    try {
      await auth.rest.setDoc(
        `users/${uid}/config/desktopDevices/${id}`,
        doc as unknown as Record<string, RestValue>
      )
    } catch (error) {
      console.error('[call] device registration failed:', error)
    }
  }

  const beat = async (): Promise<void> => {
    const uid = auth.rest.getUid()
    if (!uid || !auth.rest.hasAuth()) return
    // A revoked device stands down immediately: presence goes dark and the loop
    // exits. Re-enabling requires re-pairing (Settings › Calls).
    try {
      const self = await auth.rest.getDoc(`users/${uid}/config/desktopDevices/${id}`)
      if (self && self.fields.revoked === true) {
        console.warn('[call] this device has been revoked — going offline')
        stopPresence(auth)
        return
      }
    } catch {
      /* registry read is best-effort; heartbeat continues */
    }

    const s = getSettings().call
    const doc: DesktopPresenceDoc = {
      online: true,
      busy: isBusyForCalls(),
      deviceName: os.hostname(),
      deviceId: id,
      platform: 'windows',
      version: app.getVersion(),
      callEnabled: s.enabled,
      turn: s.turn,
      ts: Date.now()
    }
    try {
      await auth.rest.patchDoc(
        `users/${uid}/config/desktop`,
        doc as unknown as Record<string, RestValue>
      )
    } catch (error) {
      console.error('[call] presence heartbeat failed:', error)
    }
  }

  auth.onReady(() => {
    void registerDevice()
    void beat()
    heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS)
  })
}

/** Write offline + stop the loop (app quit, revoked, or disabled). */
export function stopPresence(auth: CallAuth): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  started = false
  const uid = auth.rest.getUid()
  if (!uid) return
  void auth.rest
    .patchDoc(`users/${uid}/config/desktop`, { online: false, busy: false, ts: Date.now() }, [
      'online',
      'busy',
      'ts'
    ])
    .catch(() => undefined)
}
