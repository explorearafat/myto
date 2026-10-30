/**
 * The task-completion callback system: when a task started from a call reaches
 * a terminal state, Myto CALLS THE USER BACK on the phone.
 *
 * Flow: create the call doc (`dir:'d2m'`, state `incoming`) → push an FCM
 * "call" message through /api/notify (the desktop's own authenticated token —
 * the relay allows self-push for call kind only) → watch the call doc: the
 * phone accepting flips it to `accepted` and the call session takes over as the
 * OFFERER, speaking the summary. Nobody answers within the window → declined →
 * a notification + retry per the configured prefs, each attempt counted, never
 * duplicated (state machine in `call_tasks`).
 */
import { randomUUID } from 'node:crypto'
import { getSettings } from '../settings'
import { getCallTask, staleCallingTasks, updateCallTask, type CallTaskRow } from './db'
import type { CallAuth } from './auth-flow'
import { createCallDoc, getCallDoc, patchCallDoc } from './signaling'
import type { CallSessionManager } from './call-session'

const NOTIFY_URL = 'https://mytocode.vercel.app/api/notify'
const RING_TIMEOUT_MS = 35_000

/** A one-line status the UI/toast can show. */
export type CallbackEvent =
  | { kind: 'ringing'; taskId: string; callId: string }
  | { kind: 'answered'; taskId: string; callId: string }
  | { kind: 'missed'; taskId: string }
  | { kind: 'exhausted'; taskId: string }
  | { kind: 'delivered-notification'; taskId: string }
  | { kind: 'error'; taskId: string; detail: string }

export class CallbackManager {
  private readonly auth: CallAuth
  private sessions: CallSessionManager | null = null
  private notify: (event: CallbackEvent) => void
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(auth: CallAuth, notify: (event: CallbackEvent) => void) {
    this.auth = auth
    this.notify = notify
  }

  /** The call-session manager registers itself (avoids an import cycle). */
  attachSessions(sessions: CallSessionManager): void {
    this.sessions = sessions
  }

  /**
   * Boot-time reconciliation: callbacks that were ringing when the app died go
   * back to their terminal status and re-enter the flow.
   */
  reconcileAtBoot(): void {
    for (const task of staleCallingTasks()) {
      updateCallTask(task.id, { status: task.terminalStatus ?? 'completed' })
      void this.schedule(task.id, 5_000)
    }
  }

  /** Entry point: a task just reached a terminal state. */
  onTaskTerminal(task: CallTaskRow): void {
    void this.schedule(task.id, 1_500) // small beat so the desktop UI settles
  }

  /** Run the callback flow for one task (after `delayMs`). */
  schedule(taskId: string, delayMs: number): void {
    const existing = this.timers.get(taskId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(taskId)
      void this.deliver(taskId)
    }, delayMs)
    this.timers.set(taskId, timer)
  }

  private async deliver(taskId: string): Promise<void> {
    const task = getCallTask(taskId)
    if (!task || !task.terminalStatus) return
    if (!['completed', 'failed', 'blocked'].includes(task.status)) return

    const prefs = getSettings().call.callbacks
    const uid = this.auth.rest.getUid()
    if (!uid || !this.auth.rest.hasAuth()) {
      // No auth → can't ring; notify via FCM impossible too. Retry later.
      this.schedule(taskId, 60_000)
      return
    }

    if (!prefs.enabled || task.callbackAttempts > prefs.retryLimit) {
      updateCallTask(taskId, { status: 'acknowledged' })
      this.notify({ kind: task.callbackAttempts > prefs.retryLimit ? 'exhausted' : 'delivered-notification', taskId })
      return
    }

    const callId = `cb-${randomUUID().slice(0, 8)}`
    const greeting = callbackScript(task)

    try {
      await createCallDoc(this.auth, callId, {
        dir: 'd2m',
        state: 'incoming',
        ts: Date.now(),
        taskRef: task.id,
        summary: task.summary.slice(0, 900)
      })
      updateCallTask(taskId, {
        status: 'calling',
        callId,
        callbackAttempts: task.callbackAttempts + 1,
        lastCallbackAt: Date.now()
      })
      this.notify({ kind: 'ringing', taskId, callId })

      const pushed = await this.sendFcm(uid, callId, task)
      if (!pushed) console.warn('[call] callback FCM push failed — relying on the Firestore listener')

      // Wait for the phone: accepted (session takes over) or a terminal state.
      const accepted = await this.waitForAnswer(callId, taskId)
      if (accepted && this.sessions) {
        updateCallTask(taskId, { status: 'called' })
        this.notify({ kind: 'answered', taskId, callId })
        // The session owns the actual call; when it ends it marks acknowledged
        // via markDelivered().
        await this.sessions.startCallbackCall(callId, task, greeting)
        return
      }

      // Not answered: restore the terminal status (still owes a callback) and
      // retry per prefs — the delivered-state guard prevents duplicates.
      updateCallTask(taskId, { status: task.terminalStatus })
      const attempts = task.callbackAttempts + 1
      if (attempts > prefs.retryLimit) {
        updateCallTask(taskId, { status: 'acknowledged' })
        this.notify({ kind: 'delivered-notification', taskId })
      } else {
        this.notify({ kind: 'missed', taskId })
        this.schedule(taskId, Math.max(1, prefs.retryAfterMin) * 60_000)
      }
    } catch (error) {
      console.error('[call] callback delivery failed:', error)
      updateCallTask(taskId, { status: task.terminalStatus })
      this.notify({ kind: 'error', taskId, detail: String(error) })
      this.schedule(taskId, 60_000)
    }
  }

  /** The phone answered (call doc accepted) — resolves true; false on timeout/decline. */
  private async waitForAnswer(callId: string, taskId: string): Promise<boolean> {
    const deadline = Date.now() + RING_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700))
      const doc = await getCallDoc(this.auth, callId).catch(() => null)
      if (!doc) continue
      if (doc.state === 'accepted' || doc.state === 'active') return true
      if (doc.state === 'declined') {
        void taskId
        return false
      }
      if (doc.state === 'ended' || doc.state === 'failed' || doc.state === 'missed') return false
    }
    // Ring timeout: mark the doc so the phone stops any residual UI.
    await patchCallDoc(this.auth, callId, {
      state: 'ended',
      outcome: 'missed',
      endedAt: Date.now(),
      detail: 'No answer'
    }).catch(() => undefined)
    return false
  }

  /**
   * Push the incoming-call FCM through /api/notify with the desktop's own ID
   * token. The relay verifies the token, then reads the recipient's FCM tokens
   * from Firestore — same account, so a self-push, which the relay allows ONLY
   * for kind 'call'.
   */
  private async sendFcm(
    uid: string,
    callId: string,
    task: CallTaskRow
  ): Promise<boolean> {
    const idToken = this.auth.rest.getToken()
    if (!idToken) return false
    try {
      const res = await fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idToken,
          toUid: uid,
          kind: 'call',
          title: 'Myto',
          body: task.status === 'completed' ? 'Your task is done — tap to answer' : 'Myto needs your input',
          data: {
            type: 'call',
            callId,
            taskRef: task.id,
            summary: task.summary.slice(0, 180)
          }
        }),
        signal: AbortSignal.timeout(10_000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** The callback call was answered AND delivered — close the task out. */
  markDelivered(taskId: string): void {
    updateCallTask(taskId, { status: 'acknowledged' })
  }
}

/**
 * The spoken script Myto opens a callback with — completion and failure variants
 * per the product spec (said in Neerja's voice as soon as the user answers).
 */
export function callbackScript(task: CallTaskRow): string {
  if (task.status === 'completed' || task.terminalStatus === 'completed') {
    return `Hey! I've finished working on your project. ${task.summary} Would you like me to explain what I changed, or should we move on to the next task?`
  }
  if (task.terminalStatus === 'blocked') {
    return `Hey! I've paused your project task because I need your input. ${task.summary} Can you help me decide how to proceed?`
  }
  return `I've encountered an issue while working on your project. ${task.summary} I've identified the problem and need your input before continuing.`
}
