/**
 * CallSessionManager — orchestrates one live voice call at a time.
 *
 * Lifecycle (phone→desktop): the idle poller notices a `ringing` m2d call doc →
 * waits the configured ring window (answerDelayMs + jitter, so the 5–7s of
 * ringing is REAL — the WebRTC negotiation only begins at accept) → accepts →
 * the renderer's Chromium peer answers the phone's offer over the Firestore
 * signal exchange → data channel opens → Myto greets in Neerja's voice and the
 * two-way voice loop runs.
 *
 * Lifecycle (desktop→phone, callbacks): the callback manager hands over an
 * already-accepted call; this side is the OFFERER and speaks the task summary.
 *
 * The voice loop:
 *   mic → phone's on-device STT → data channel text → agent turn (the REAL loop,
 *   via task-manager) → sentence TTS → renderer audio track → phone speaker,
 *   with barge-in (any speech while Myto talks stops playback + cancels the
 *   current conversational stream), hold, mute, a quick-command fast path
 *   through the permission-tiered executor, and voice/tap approval for
 *   side-effecting tools.
 *
 * Tasks ("finish the auth system") are recognized up front and handed to
 * startTaskFromCall, which runs the full cowork loop INDEPENDENT of the call:
 * progress streams into the call while it lives, the loop survives a hangup,
 * and the terminal state triggers the callback flow.
 */
import os from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ApprovalRequest, QuestionRequest } from '../../shared/types'
import type { CallPeerControl as PeerControl, CallPeerEvent as PeerEvent } from '../../shared/types'
import type { CallStatusEvent } from '../../shared/types'
import { getSettings, saveSettings } from '../settings'
import { decideApproval, answerCallQuestions, cancelStream } from '../provider-ipc'
import type { CallAuth } from './auth-flow'
import { setCallActive } from './busy-state'
import { executeCommand, classifyCommand, needsApproval, resolveCallCwd } from './call-executor'
import type { ExecHandle } from './call-executor'
import {
  deleteCallSignals,
  getCallDoc,
  patchCallDoc,
  pollLiveCalls,
  pollSignals,
  pushSignal,
  sleepPolling,
  IDLE_POLL_MS,
  NEGOTIATION_POLL_MS
} from './signaling'
import { TtsService } from './tts-service'
import { buildIceServers, describeResult, looksLikeTask, matchQuickCommand, yesNo } from './call-text'
import {
  appendAssistantMessage,
  appendUserMessage,
  buildVoiceMessages,

  createCallSession,
  loadHistory,
  runCallTurn,
  startTaskFromCall
} from './task-manager'
import { parseDcMessage } from './types'
import type { CallDoc, DataChannelMessage } from './types'

/** The exact greeting the spec mandates (spoken on every answered call). */
export const CALL_GREETING = "Hello! I'm Myto. I'm here and ready to help. What would you like me to do?"

export interface CallSessionDeps {
  auth: CallAuth
  /** Deliver a PeerControl message to the renderer (wired to IpcChannel.CallPeerControl). */
  sendPeerControl: (msg: PeerControl) => void
  /** Surface lifecycle changes (desktop UI indicator + tests). */
  onStatus: (event: CallStatusEvent) => void
  /** A task reached a terminal state → the callback manager takes over. */
  onTaskTerminal: (task: import('./db').CallTaskRow) => void
  /** The callback call was heard (dc-open on a d2m call) → close the task out. */
  onCallbackDelivered: (taskId: string) => void
}

const NEGOTIATION_TIMEOUT_MS = 60_000

/** Doc states that mean the call is over — a session must not linger past them. */
const TERMINAL_CALL_STATES = new Set(['ended', 'failed', 'declined', 'missed', 'cancelled'])

export class CallSessionManager {
  private readonly deps: CallSessionDeps
  private current: LiveCallSession | null = null
  private running = false

  constructor(deps: CallSessionDeps) {
    this.deps = deps
  }

  /** Begin the idle poller (once auth is ready). */
  start(): void {
    if (this.running) return
    this.running = true
    const loop = async (): Promise<void> => {
      while (this.running) {
        try {
          if (this.current === null && this.deps.auth.available()) {
            await pollLiveCalls(this.deps.auth, (callId, doc) => {
              void this.onLiveCall(callId, doc)
            })
          }
        } catch (error) {
          console.error('[call] poll error:', error)
        }
        await sleepPolling(this.current ? NEGOTIATION_POLL_MS : IDLE_POLL_MS)
      }
    }
    void loop()
  }

  stop(): void {
    this.running = false
    this.current?.hangup('desktop-shutdown').catch(() => undefined)
  }

  /** Renderer peer events land here (wired from IpcChannel.CallPeerEvent). */
  onPeerEvent(event: PeerEvent): void {
    this.current?.onPeerEvent(event)
  }

  private async onLiveCall(callId: string, doc: CallDoc): Promise<void> {
    if (this.current !== null) {
      // One call at a time: anything else ringing while busy is declined politely.
      if (doc.state === 'ringing' && doc.dir === 'm2d' && !doc.acceptedAt) {
        await patchCallDoc(this.deps.auth, callId, {
          state: 'declined',
          outcome: 'busy',
          endedAt: Date.now(),
          detail: 'Myto was on another call'
        }).catch(() => undefined)
      }
      return
    }
    if (doc.dir === 'm2d' && doc.state === 'ringing' && !doc.acceptedAt) {
      await this.answerIncoming(callId)
    }
  }

  /** The ring → accept choreography for a phone-initiated call. */
  private async answerIncoming(callId: string): Promise<void> {
    const s = getSettings().call
    if (!s.enabled) return
    this.deps.onStatus({ state: 'ringing', callId, direction: 'm2d' })

    // Genuine ringing: negotiation does not start until the ring window ends.
    const ringMs = Math.max(1500, s.answerDelayMs) + Math.floor(Math.random() * 1500)
    await sleepPolling(ringMs)

    // Re-read the doc: the user may have cancelled while it rang.
    const doc = await getCallDoc(this.deps.auth, callId).catch(() => null)
    if (!doc || doc.state !== 'ringing') return
    if (this.current !== null) return

    const session = new LiveCallSession(this.deps, callId, 'm2d', 'answerer')
    this.attach(callId, session)
    this.deps.onStatus({ state: 'connecting', callId })
    await patchCallDoc(this.deps.auth, callId, {
      state: 'accepted',
      acceptedAt: Date.now(),
      deviceName: session.deviceName
    }).catch(() => undefined)
    await pushSignal(this.deps.auth, callId, { from: 'desktop', kind: 'accept', payload: '{}' }).catch(
      () => undefined
    )
    session.begin()
  }

  /** Callback calls: the phone already accepted; this side offers and speaks. */
  async startCallbackCall(callId: string, task: import('./db').CallTaskRow, greeting: string): Promise<void> {
    if (this.current !== null) return
    const session = new LiveCallSession(this.deps, callId, 'd2m', 'offerer', greeting)
    // The message is delivered the moment the user hears it (dc-open).
    session.onConnected = (): void => this.deps.onCallbackDelivered(task.id)
    this.attach(callId, session)
    this.deps.onStatus({ state: 'connecting', callId })
    session.begin()
  }

  private attach(callId: string, session: LiveCallSession): void {
    this.current = session
    setCallActive(true)
    session.onEnded = (): void => {
      if (this.current?.callId === callId) {
        this.current = null
        setCallActive(false)
        this.deps.onStatus({ state: 'idle' })
      }
    }
  }

  /** A desktop-side hangup (window quit, etc.). */
  hangupCurrent(reason: string): void {
    this.current?.hangup(reason).catch(() => undefined)
  }

  getActiveCallId(): string | null {
    return this.current?.callId ?? null
  }
}

/**
 * One live call. Owns the renderer peer lifecycle, the data-channel protocol,
 * the TTS pipeline, and the agent-turn loop.
 */
class LiveCallSession {
  readonly callId: string
  readonly deviceName = 'Myto Desktop'
  onEnded: (() => void) | null = null
  onConnected: (() => void) | null = null

  private readonly deps: CallSessionDeps
  private readonly role: 'offerer' | 'answerer'
  private readonly openingScript: string

  private seenSignals = new Set<string>()
  private tts: TtsService | null = null
  private ended = false
  private negotiated = false
  private speaking = false
  private muted = false
  private hold = false
  private turnInFlight = false
  private currentStreamId: string | null = null
  private toolReportsThisTurn = 0
  private pendingApproval: ApprovalRequest | null = null
  private pendingQuestion: QuestionRequest | null = null
  private sessionRow: { sessionId: string } | null = null
  private sentenceCounter = 0
  private execHandles = new Set<ExecHandle>()
  private voiceConfirmations = new Map<string, (text: string) => void>()
  private taskRunning = false
  private taskSummaryLine = ''

  constructor(deps: CallSessionDeps, callId: string, _dir: 'm2d' | 'd2m', role: 'offerer' | 'answerer', openingScript?: string) {
    this.deps = deps
    this.callId = callId
    this.role = role
    this.openingScript = openingScript ?? CALL_GREETING
  }

  /** Kick off negotiation + signal polling. Fire-and-forget by design. */
  begin(): void {
    void this.run()
  }

  private async run(): Promise<void> {
    try {
      this.tts = new TtsService({
        onAudio: (sentence, mp3) => {
          const id = ++this.sentenceCounter
          this.deps.sendPeerControl({
            action: 'tts-play',
            callId: this.callId,
            sentenceId: id,
            mp3Base64: mp3.toString('base64'),
            sentence
          })
        },
        onFallbackText: (sentence) => {
          // Edge TTS is down: the phone speaks the sentence locally (on-device
          // TTS fallback) and shows it as a transcript line.
          this.sendDc({ t: 'speak_text', text: sentence })
          this.sendDc({ t: 'transcript', role: 'myto', text: sentence })
        },
        onError: (detail) => console.warn(`[call:${this.callId}] ${detail}`)
      })
      this.tts.start()

      // Spin up the renderer peer with the settings' ICE configuration
      // (sanitized — a half-filled TURN degrades to STUN-only, never kills the call).
      const turn = getSettings().call.turn
      this.deps.sendPeerControl({
        action: 'init',
        callId: this.callId,
        role: this.role,
        iceServers: buildIceServers(turn)
      })

      // Signal exchange loop (fast while negotiating; once the DC is open the
      // poll only watches for hangup — everything else rides the data channel).
      const negotiateDeadline = Date.now() + NEGOTIATION_TIMEOUT_MS
      let docChecks = 0
      while (!this.ended) {
        await pollSignals(this.deps.auth, this.callId, this.seenSignals, (sig) => {
          if (sig.from !== 'mobile') return
          if (sig.kind === 'hangup') {
            void this.hangup('remote-hangup')
          } else if (!this.ended) {
            this.onMobileSignal(sig.kind, sig.payload)
          }
        })
        if (!this.negotiated && !this.ended && Date.now() > negotiateDeadline) {
          await this.hangup('timeout')
          return
        }
        // Watchdog: a connected call whose phone vanished mid-call (network
        // switch, dead battery, app kill) never sends a hangup signal — and a
        // session that lingers blocks EVERY later call with 'busy'. Every ~15s
        // read the doc: terminal (or gone) → clean up locally.
        if (this.negotiated && !this.ended && ++docChecks % 10 === 0) {
          const doc = await getCallDoc(this.deps.auth, this.callId).catch(() => null)
          if (!doc || TERMINAL_CALL_STATES.has(doc.state)) {
            console.log(
              `[call:${this.callId}] remote gone (doc: ${doc?.state ?? 'missing'}) — releasing session`
            )
            await this.hangup('remote-gone')
            return
          }
        }
        await sleepPolling(this.negotiated ? 1_500 : NEGOTIATION_POLL_MS)
      }
    } catch (error) {
      console.error(`[call:${this.callId}] session crashed:`, error)
      await this.hangup('error').catch(() => undefined)
    }
  }

  private onMobileSignal(kind: string, payload: string): void {
    if (this.ended) return
    if (kind === 'offer' && this.role === 'answerer') {
      console.log(`[call:${this.callId}] offer received from phone`)
      this.deps.sendPeerControl({
        action: 'set-remote',
        callId: this.callId,
        description: { type: 'offer', sdp: payload }
      })
    } else if (kind === 'answer' && this.role === 'offerer') {
      console.log(`[call:${this.callId}] answer received from phone`)
      this.deps.sendPeerControl({
        action: 'set-remote',
        callId: this.callId,
        description: { type: 'answer', sdp: payload }
      })
    } else if (kind === 'ice') {
      try {
        this.deps.sendPeerControl({ action: 'add-ice', callId: this.callId, candidate: JSON.parse(payload) })
      } catch {
        /* malformed ICE candidate — ignore */
      }
    }
  }

  /** Renderer peer events (local description, ICE, DC, playback, stats). */
  onPeerEvent(event: PeerEvent): void {
    if (event.callId !== this.callId || this.ended) return
    switch (event.kind) {
      case 'local-description':
        console.log(`[call:${this.callId}] ${event.description.type} created`)
        void pushSignal(this.deps.auth, this.callId, {
          from: 'desktop',
          kind: event.description.type === 'offer' ? 'offer' : 'answer',
          payload: event.description.sdp
        }).catch((e) => console.error('[call] signal push failed:', e))
        break
      case 'ice':
        void pushSignal(this.deps.auth, this.callId, {
          from: 'desktop',
          kind: 'ice',
          payload: JSON.stringify(event.candidate)
        }).catch(() => undefined)
        break
      case 'dc-open':
        console.log(`[call:${this.callId}] data channel open`)
        this.sendDc({ t: 'ready' })
        this.deps.onStatus({ state: 'active', callId: this.callId })
        void patchCallDoc(this.deps.auth, this.callId, { state: 'active' }).catch(() => undefined)
        if (!this.negotiated) {
          this.negotiated = true
          this.onConnected?.()
          // Myto speaks first, immediately.
          this.tts?.say(this.openingScript)
          this.sendDc({ t: 'transcript', role: 'myto', text: this.openingScript })
        }
        break
      case 'dc-message':
        this.onDcMessage(event.json)
        break
      case 'dc-closed':
        void this.hangup('remote-hangup')
        break
      case 'peer-state':
        console.log(`[call:${this.callId}] peer state: ${event.state}`)
        if (event.state === 'failed') {
          // Give a phone-side ICE restart a beat, then fail the call.
          setTimeout(() => {
            if (!this.negotiated && !this.ended) void this.hangup('error')
          }, 10_000)
        }
        break
      case 'tts-playing':
        if (!this.speaking) {
          this.speaking = true
          this.sendDc({ t: 'speaking', on: true })
        }
        break
      case 'tts-idle':
        if (this.speaking) {
          this.speaking = false
          this.sendDc({ t: 'speaking', on: false })
          this.sendDc({ t: 'listening', on: true })
        }
        break
      case 'stats':
        this.sendDc({ t: 'latency', rttMs: event.rttMs, quality: event.quality })
        break
      case 'error':
        console.warn(`[call:${this.callId}] peer error: ${event.detail}`)
        break
    }
  }

  private onDcMessage(json: string): void {
    const msg = parseDcMessage(json)
    if (!msg || this.ended) return
    switch (msg.t) {
      case 'hello':
        break
      case 'stt_partial':
        // Barge-in: any speech while Myto talks stops playback at once.
        if (this.speaking && !this.hold && !this.muted) this.bargeIn()
        break
      case 'stt_final':
        if (this.muted || this.hold) return
        console.log(`[call:${this.callId}] you said: ${msg.text.slice(0, 120)}`)
        void this.onUserUtterance(msg.text)
        break
      case 'mute':
        this.muted = msg.on
        break
      case 'hold':
        this.hold = msg.on
        if (msg.on) {
          this.tts?.stop()
          this.deps.sendPeerControl({ action: 'tts-stop', callId: this.callId })
          if (this.currentStreamId) {
            cancelStream(this.currentStreamId)
            this.turnInFlight = false
          }
        }
        break
      case 'interrupt':
        this.bargeIn()
        break
      case 'approval': {
        decideApproval(msg.id, msg.decision)
        if (this.pendingApproval?.approvalId === msg.id) this.pendingApproval = null
        break
      }
      case 'question':
        // The phone→desktop variant carries answers (the desktop→phone variant
        // is only ever SENT from here, never received).
        if ('answers' in msg && Array.isArray(msg.answers)) {
          answerCallQuestions(msg.id, msg.answers)
          if (this.pendingQuestion?.questionId === msg.id) this.pendingQuestion = null
        }
        break
      case 'keypad':
        void this.onUserUtterance(`Keypad input: ${msg.digits}`)
        break
      case 'voice_rate':
        this.tts?.setRate(msg.rate)
        break
      case 'ping':
        this.sendDc({ t: 'pong', ts: msg.ts })
        break
      case 'hangup':
        void this.hangup('remote-hangup')
        break
    }
  }

  /** Stop playback + synthesis; cancel the conversational stream (never a task run). */
  private bargeIn(): void {
    this.tts?.stop()
    this.deps.sendPeerControl({ action: 'tts-stop', callId: this.callId })
    if (this.currentStreamId && this.toolReportsThisTurn === 0) {
      cancelStream(this.currentStreamId)
      this.turnInFlight = false
    }
  }

  private async onUserUtterance(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean || this.ended || this.hold) return

    // A spoken yes/no settles an open confirmation first.
    for (const [id, handler] of this.voiceConfirmations) {
      const decision = yesNo(clean)
      if (decision !== null) {
        this.voiceConfirmations.delete(id)
        handler(clean)
        return
      }
    }
    if (this.pendingApproval) {
      const decision = yesNo(clean)
      const approval = this.pendingApproval
      if (decision !== null) {
        this.pendingApproval = null
        decideApproval(approval.approvalId, decision)
        this.tts?.say(decision === 'allow' ? 'Alright, doing it.' : 'Okay, I will not do that.')
        return
      }
    }
    if (this.pendingQuestion) {
      const question = this.pendingQuestion
      this.pendingQuestion = null
      answerCallQuestions(question.questionId, [clean])
      return
    }

    if (this.turnInFlight) {
      // The user talked over a running answer: stop it, take the new instruction.
      this.bargeIn()
      this.turnInFlight = false
    }

    this.sendDc({ t: 'transcript', role: 'user', text: clean })

    // While an autonomous task runs, short status replies keep the call useful.
    if (this.taskRunning) {
      this.tts?.say(
        this.taskSummaryLine
          ? `I'm still working on that. ${this.taskSummaryLine} I'll call you back when it's done.`
          : "I'm still working on it. I'll call you back when it's done."
      )
      return
    }

    // Quick-command fast path: no model round-trip for crisp, known commands.
    const quick = matchQuickCommand(clean)
    if (quick) {
      await this.runQuickCommand(quick)
      return
    }

    if (looksLikeTask(clean)) {
      this.startBackgroundTask(clean)
      return
    }

    await this.runAgentTurn(clean)
  }

  /** Tiered + audited + confirmed direct execution (the call-executor path). */
  private async runQuickCommand(quick: { command: string; longRunning?: boolean; say?: string }): Promise<void> {
    const settings = getSettings()
    const tier = classifyCommand(quick.command)
    if (needsApproval(tier, settings.call.permissionMode)) {
      const ok = await this.confirmWithUser(
        quick.say ? `${quick.say} Shall I run it?` : `This will run: ${quick.command}. Approve?`,
        `run: ${quick.command}`
      )
      if (!ok) {
        this.tts?.say('Okay, I will not run that.')
        return
      }
    }
    if (quick.say) this.tts?.say(quick.say)
    const cwd = resolveCallCwd(ensureCallWorkspace(), os.homedir())
    const handle = await executeCommand({
      callId: this.callId,
      command: quick.command,
      cwd,
      approvedBy: 'voice',
      tier,
      longRunning: quick.longRunning,
      onLog: (stream, text) => this.sendDc({ t: 'log', stream, text: text.slice(0, 400) })
    })
    if (handle.pid) this.execHandles.add(handle)
    this.sendDc({ t: 'command', command: quick.command, status: 'running' })
    const result = await handle.done
    this.execHandles.delete(handle)
    this.sendDc({
      t: 'command',
      command: quick.command,
      status: result.exitCode === 0 ? 'done' : 'failed'
    })
    const out = (result.output.out || result.output.err).trim()
    this.tts?.say(describeResult(result.exitCode, out, result.timedOut))
  }

  /** A long task: run the FULL cowork loop in the background (survives hangup). */
  private startBackgroundTask(prompt: string): void {
    const workspaceDir = ensureCallWorkspace()
    if (workspaceDir.trim() === '') {
      this.tts?.say(
        'I can work on a project, but no working folder could be prepared. Check Myto settings, then call me again.'
      )
      return
    }
    this.taskRunning = true
    this.tts?.say(
      "Got it. I'm starting on that now. You can hang up whenever you like — I'll call you back when it's done."
    )
    this.sendDc({ t: 'task', state: 'accepted', summary: prompt.slice(0, 140) })
    void startTaskFromCall({
      callId: this.callId,
      workspaceDir,
      prompt,
      events: {
        onDelta: () => {
          /* task prose is not spoken — progress + summary are */
        },
        onStatus: (status) => {
          this.taskSummaryLine = status
          this.sendDc({ t: 'status', text: status })
        },
        onCommand: (run) => this.sendDc({ t: 'command', command: run.command, status: 'running' }),
        onApproval: (approval) => this.raiseApproval(approval),
        onQuestion: (question) => this.raiseQuestion(question),
        onLog: (line) => this.sendDc({ t: 'log', stream: 'out', text: line.slice(0, 400) }),
        onTaskState: (state, summary) => {
          this.sendDc({ t: 'task', state: state === 'completed' ? 'done' : state === 'running' ? 'running' : 'failed', summary: summary.slice(0, 140) })
          if (state !== 'running') {
            this.taskRunning = false
            // If the user is still on the line, Myto reports in person.
            if (!this.ended) this.tts?.say(`Update: ${summary}`)
          }
        }
      }
    })
      .then((task) => {
        this.deps.onTaskTerminal(task)
      })
      .catch((error) => {
        console.error('[call] task crashed:', error)
        this.taskRunning = false
      })
  }

  /** One conversational agent turn through the REAL loop. */
  private async runAgentTurn(userText: string): Promise<void> {
    const workspaceDir = ensureCallWorkspace()
    const mode = workspaceDir.trim() !== '' ? 'cowork' : 'chat'
    if (!this.sessionRow) {
      this.sessionRow = createCallSession(mode, workspaceDir, userText.slice(0, 60))
    }
    const sessionId = this.sessionRow.sessionId
    const msgId = appendUserMessage(sessionId, userText)
    const streamId = `call-${randomUUID().slice(0, 8)}`
    this.currentStreamId = streamId
    this.toolReportsThisTurn = 0
    this.turnInFlight = true

    try {
      const result = await runCallTurn({
        streamId,
        request: {
          messages: buildVoiceMessages(loadHistory(sessionId).slice(0, -1), userText, workspaceDir),
          mode,
          sessionId,
          afterMsgId: msgId
        },
        events: {
          onDelta: (delta) => this.tts?.feed(delta),
          onStatus: (status) => this.sendDc({ t: 'status', text: status }),
          onCommand: (run) => {
            this.toolReportsThisTurn++
            this.sendDc({ t: 'command', command: run.command, status: 'running' })
          },
          onApproval: (approval) => this.raiseApproval(approval),
          onQuestion: (question) => this.raiseQuestion(question),
          onLog: (line) => this.sendDc({ t: 'log', stream: 'out', text: line.slice(0, 400) })
        }
      })
      this.tts?.flush()
      appendAssistantMessage(sessionId, result.text || result.error || '')
      // The reply must be READABLE even when TTS is degraded — the phone shows
      // transcript lines as bubbles under the avatar.
      if (result.text.trim()) {
        this.sendDc({ t: 'transcript', role: 'myto', text: result.text.slice(0, 500) })
      }
      if (result.error) {
        console.warn(`[call:${this.callId}] agent turn error: ${result.error}`)
        this.tts?.say('Sorry, something went wrong on my side. Could you try again?')
      } else {
        console.log(`[call:${this.callId}] agent replied (${result.text.length} chars)`)
      }
    } finally {
      this.turnInFlight = false
      this.currentStreamId = null
    }
  }

  private raiseApproval(approval: ApprovalRequest): void {
    this.pendingApproval = approval
    this.sendDc({
      t: 'approval_request',
      id: approval.approvalId,
      title: approval.toolName,
      detail: approval.detail || approval.sideEffect,
      tool: approval.toolName
    })
    this.tts?.say(
      `I need your permission to ${approval.toolName.replace(/_/g, ' ')}${
        approval.detail ? ` — ${approval.detail}` : ''
      }. Say yes or no, or use the button on the screen.`
    )
  }

  private raiseQuestion(question: QuestionRequest): void {
    this.pendingQuestion = question
    const first = question.questions[0]
    this.sendDc({
      t: 'question',
      id: question.questionId,
      title: first?.question ?? 'I have a question',
      options: (first?.options ?? []).slice(0, 4)
    })
    this.tts?.say(first?.question ?? 'I have a question before I continue.')
  }

  /** Voice/tap confirmation used by the quick-command path (times out → no). */
  private confirmWithUser(prompt: string, detail: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `qa-${randomUUID().slice(0, 8)}`
      this.sendDc({ t: 'approval_request', id, title: 'confirm', detail, tool: 'run_command' })
      this.tts?.say(prompt)
      const timer = setTimeout(() => {
        this.voiceConfirmations.delete(id)
        resolve(false)
      }, 20_000)
      this.voiceConfirmations.set(id, (text: string) => {
        clearTimeout(timer)
        resolve(yesNo(text) === 'allow')
      })
    })
  }

  sendDc(msg: DataChannelMessage): void {
    this.deps.sendPeerControl({ action: 'send-dc', callId: this.callId, json: JSON.stringify(msg) })
  }

  async hangup(reason: string): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.tts?.stop()
    if (this.currentStreamId) cancelStream(this.currentStreamId)
    for (const h of this.execHandles) h.cancel()
    this.execHandles.clear()
    // Never leave the agent loop parked on a prompt nobody can answer anymore:
    // a task must keep running (and report the denial in its callback) rather
    // than wedge forever after the phone is gone.
    if (this.pendingApproval) {
      decideApproval(this.pendingApproval.approvalId, 'deny')
      this.pendingApproval = null
    }
    if (this.pendingQuestion) {
      answerCallQuestions(this.pendingQuestion.questionId, [])
      this.pendingQuestion = null
    }
    this.deps.sendPeerControl({ action: 'close', callId: this.callId })
    await patchCallDoc(this.deps.auth, this.callId, {
      state: 'ended',
      outcome: 'hangup',
      endedAt: Date.now(),
      detail: reason.slice(0, 200)
    }).catch(() => undefined)
    // Signaling payloads are dead weight once the call is over — prune them so
    // the subcollection stays small (the call doc itself remains as history).
    void deleteCallSignals(this.deps.auth, this.callId)
    this.deps.onStatus({
      state: 'ended',
      callId: this.callId,
      outcome: 'hangup',
      detail: reason
    })
    this.onEnded?.()
  }
}

/**
 * The folder a call works in: the dedicated call workspace when set (auto-
 * persisted to `Documents\Myto Call Work` on first use), else the main Cowork
 * workspace. Pure part exported for unit tests.
 */
export function resolveCallWorkspace(
  callWorkspaceDir: string,
  coworkWorkspaceDir: string
): string {
  if (callWorkspaceDir.trim() !== '') return callWorkspaceDir.trim()
  if (coworkWorkspaceDir.trim() !== '') return coworkWorkspaceDir.trim()
  return ''
}

/** The auto-persisted default when no folder was ever chosen. */
export function defaultCallWorkspace(): string {
  return join(os.homedir(), 'Documents', 'Myto Call Work')
}

/**
 * The workspace this call runs in — resolving + creating it once, and
 * persisting the auto default so the user can see/change it in Settings.
 */
export function ensureCallWorkspace(): string {
  const settings = getSettings()
  let dir = resolveCallWorkspace(settings.call.callWorkspaceDir, settings.cowork.workspaceDir)
  if (dir === '') {
    dir = defaultCallWorkspace()
    void saveSettings({ ...settings, call: { ...settings.call, callWorkspaceDir: dir } })
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.error('[call] could not create the call workspace:', error)
  }
  return dir
}
