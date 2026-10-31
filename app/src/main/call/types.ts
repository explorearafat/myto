/**
 * Wire-protocol and lifecycle types for the Myto Remote voice-call system.
 * These describe the Firestore documents both peers read/write (the phone uses
 * the Firestore SDK; the desktop talks to the same paths over the authenticated
 * REST API) and the JSON messages carried on the WebRTC data channel once the
 * peer connection is up. Shared by the call modules in `main/call/`.
 */

/** Call direction: phone→desktop (the user calling Myto) or desktop→phone (a callback). */
export type CallDirection = 'm2d' | 'd2m'

/** Lifecycle states of a call document (`users/{uid}/calls/{callId}`). */
export type CallState =
  | 'ringing' // phone→desktop: the phone is ringing, nobody answered yet
  | 'incoming' // desktop→phone: a callback is ringing on the phone
  | 'accepted' // the callee said yes; WebRTC negotiation starts now
  | 'active' // peer connection live
  | 'ended' // completed normally (someone hung up)
  | 'failed' // could not connect (offline / timeout / negotiation error)
  | 'declined' // the callee refused
  | 'missed' // callback nobody answered (after retries or final timeout)
  | 'cancelled' // caller hung up before acceptance

/** Why a call left the live states. */
export type CallOutcome =
  | 'hangup'
  | 'declined'
  | 'offline'
  | 'busy'
  | 'timeout'
  | 'error'
  | 'missed'
  | 'completed'

/**
 * The call document. Both sides write with field masks (REST) so concurrent
 * writers never clobber each other's fields.
 */
export interface CallDoc {
  uid: string
  dir: CallDirection
  state: CallState
  /** Epoch ms — Firestore REST has no serverTimestamp, both sides use wall clock. */
  ts: number
  acceptedAt?: number
  endedAt?: number
  /** Terminal reason, set when state leaves the live set. */
  outcome?: CallOutcome
  /** Desktop device that accepted (informational, shown on the phone). */
  deviceName?: string
  /** For callbacks: the driving task and a short spoken summary. */
  taskRef?: string
  summary?: string
  /** Set on `failed`/`ended` so the phone can show a precise reason. */
  detail?: string
}

/** One signaling message (`users/{uid}/calls/{callId}/signals/{seq}`). */
export interface SignalDoc {
  from: 'desktop' | 'mobile'
  /** Monotonic per-call sequence (0,1,2…): the poller tracks what it has seen. */
  seq: number
  kind: 'accept' | 'offer' | 'answer' | 'ice' | 'hangup'
  /** JSON-encoded SDP or ICE payload (kept as a string — one typed value over REST). */
  payload: string
  ts: number
}

/** JSON messages carried on the WebRTC data channel (both directions). */
export type DataChannelMessage =
  // phone → desktop
  | { t: 'hello'; deviceName: string }
  | { t: 'stt_partial'; text: string }
  | { t: 'stt_final'; text: string }
  | { t: 'mute'; on: boolean }
  | { t: 'hold'; on: boolean }
  | { t: 'interrupt' }
  | { t: 'approval'; id: string; decision: 'allow' | 'allow_always' | 'deny' }
  | { t: 'question'; id: string; answers: string[] }
  | { t: 'keypad'; digits: string }
  | { t: 'voice_rate'; rate: string }
  | { t: 'ping'; ts: number }
  | { t: 'hangup' }
  // desktop → phone
  | { t: 'ready' }
  | { t: 'speaking'; on: boolean }
  | { t: 'listening'; on: boolean }
  | { t: 'status'; text: string }
  | { t: 'transcript'; role: 'user' | 'myto'; text: string }
  | { t: 'log'; stream: 'out' | 'err'; text: string }
  | { t: 'command'; command: string; status: 'running' | 'done' | 'failed' }
  | { t: 'approval_request'; id: string; title: string; detail: string; tool: string }
  | { t: 'question'; id: string; title: string; options: string[] }
  | { t: 'task'; state: 'accepted' | 'running' | 'done' | 'failed' | 'blocked'; summary?: string }
  | { t: 'latency'; rttMs: number; quality: 'direct' | 'relay' | 'unknown' }
  | { t: 'speak_text'; text: string }
  | { t: 'pong'; ts: number }
  | { t: 'bye' }

/** The desktop presence document (`users/{uid}/config/desktop`). */
export interface DesktopPresenceDoc {
  online: boolean
  /** A call is live or an agent task is running — the phone shows "busy". */
  busy: boolean
  deviceName: string
  deviceId: string
  platform: 'windows' | 'macos' | 'linux'
  version: string
  callEnabled: boolean
  /** TURN relay the phone uses when a direct P2P path fails. */
  turn: { urls: string[]; username: string; credential: string }
  /** Epoch ms heartbeat; the phone treats >45s staleness as offline. */
  ts: number
}

/** One paired-desktop device registry entry (`users/{uid}/desktopDevices/{id}`). */
export interface DesktopDeviceDoc {
  deviceName: string
  platform: 'windows' | 'macos' | 'linux'
  version: string
  addedAt: number
  lastSeen: number
  revoked: boolean
}

/** Parse a data-channel JSON string; returns null for anything malformed. */
export function parseDcMessage(raw: string): DataChannelMessage | null {
  try {
    const v = JSON.parse(raw) as { t?: string }
    if (typeof v !== 'object' || v === null || typeof v.t !== 'string') return null
    return v as DataChannelMessage
  } catch {
    return null
  }
}
