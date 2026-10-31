/**
 * The desktop's WebRTC peer host — the ONLY part of the call system that needs
 * a browser engine, so it lives in the Chromium renderer.
 *
 * Main orchestrates over `window.myto.call.onPeerControl`; this module owns:
 *  - the RTCPeerConnection (STUN/TURN from the control message),
 *  - the audio graph: TTS sentences arrive as complete MP3s, are decoded and
 *    scheduled BACK-TO-BACK on an AudioContext, and its MediaStreamDestination
 *    track is what actually streams to the phone (the desktop stays silent),
 *  - the data channel (offered by whoever has the offerer role),
 *  - ICE candidate queueing before the remote description lands,
 *  - connection-state + RTT/candidate-type stats reporting.
 *
 * The phone's mic track arrives as a remote audio track; the desktop never
 * plays it (the phone transcribes locally and sends TEXT over the data channel).
 */
import type { CallPeerControl, CallPeerEvent } from '../../../../shared/types'

interface PendingIce {
  candidate: RTCIceCandidateInit
}

interface TtsItem {
  sentenceId: number
  buffer: AudioBuffer
}

class DesktopPeerHost {
  private pc: RTCPeerConnection | null = null
  private callId: string | null = null
  private dc: RTCDataChannel | null = null
  private ctx: AudioContext | null = null
  private dest: MediaStreamAudioDestinationNode | null = null
  private queue: TtsItem[] = []
  private playing: AudioBufferSourceNode | null = null
  private playhead = 0
  private playingSentence = -1
  private pendingIce: PendingIce[] = []
  private remoteSet = false
  private statsTimer: number | null = null
  // Desktop-side speech recognition: record the phone's mic track in complete
  // 4-second WebM segments and hand each to main for transcription. A fresh
  // recorder per segment keeps every blob independently decodable.
  private sttEnabled = false
  private sttRecorder: MediaRecorder | null = null
  private remoteStream: MediaStream | null = null

  start(): void {
    window.myto.call.onPeerControl((msg) => void this.onControl(msg))
  }

  private emit(event: CallPeerEvent): void {
    window.myto.call.peerEvent(event)
  }

  private async onControl(msg: CallPeerControl): Promise<void> {
    try {
      switch (msg.action) {
        case 'init':
          this.sttEnabled = msg.sttEnabled
          await this.init(msg.callId, msg.role, msg.iceServers)
          break
        case 'set-remote':
          await this.setRemote(msg.description)
          break
        case 'add-ice':
          await this.addIce(msg.candidate)
          break
        case 'tts-play':
          await this.playTts(msg.sentenceId, msg.mp3Base64)
          break
        case 'tts-stop':
          this.stopTts()
          break
        case 'send-dc':
          this.dc?.send(msg.json)
          break
        case 'ice-restart':
          this.pc?.restartIce()
          break
        case 'close':
          this.close()
          break
      }
    } catch (error) {
      this.emit({ callId: msg.callId ?? this.callId ?? '', kind: 'error', detail: String(error) })
    }
  }

  private async init(callId: string, role: 'offerer' | 'answerer', iceServers: RTCIceServer[]): Promise<void> {
    this.close()
    this.callId = callId
    this.remoteSet = false
    this.pendingIce = []
    this.queue = []
    this.playhead = 0

    this.ctx = new AudioContext()
    this.dest = this.ctx.createMediaStreamDestination()
    this.pc = new RTCPeerConnection({ iceServers })

    // Myto's voice: the destination track rides the connection (silent until a
    // sentence plays — no local spill).
    for (const track of this.dest.stream.getAudioTracks()) this.pc.addTrack(track, this.dest.stream)

    // The phone's mic arrives as a remote track — received, never played
    // locally. When desktop STT is enabled, it's ALSO the transcription feed.
    this.pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream && this.sttEnabled && this.sttRecorder === null) {
        this.remoteStream = stream
        this.startSttRecording()
      }
    }

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit({ callId, kind: 'ice', candidate: event.candidate.toJSON() })
      }
    }

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState
      if (state === 'connected' || state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.emit({ callId, kind: 'peer-state', state })
      }
      if (state === 'connected') this.startStats()
      if (state === 'failed') this.pc?.restartIce()
    }

    // The offerer owns the data channel; the answerer adopts it.
    if (role === 'offerer') {
      this.dc = this.pc.createDataChannel('myto-call', { ordered: true })
      this.wireDc()
      // One audio track + one data channel → a single offer on negotiationneeded.
      this.pc.onnegotiationneeded = async () => {
        try {
          const offer = await this.pc!.createOffer()
          await this.pc!.setLocalDescription(offer)
          this.emit({
            callId,
            kind: 'local-description',
            description: { type: 'offer', sdp: this.pc!.localDescription!.sdp }
          })
        } catch (error) {
          this.emit({ callId, kind: 'error', detail: `offer failed: ${String(error)}` })
        }
      }
    } else {
      this.pc.ondatachannel = (event) => {
        this.dc = event.channel
        this.wireDc()
      }
    }
  }

  private wireDc(): void {
    if (!this.dc) return
    this.dc.onopen = () => this.emit({ callId: this.callId ?? '', kind: 'dc-open' })
    this.dc.onclose = () => this.emit({ callId: this.callId ?? '', kind: 'dc-closed' })
    this.dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.emit({ callId: this.callId ?? '', kind: 'dc-message', json: event.data })
      }
    }
  }

  /**
   * Desktop-side STT capture: record the phone's mic in COMPLETE 4-second
   * WebM segments (a fresh recorder per segment — with timeslice, only the
   * first chunk carries the WebM header), base64 each blob to main, and let
   * the configured transcription endpoint turn it into text.
   */
  private startSttRecording(): void {
    const stream = this.remoteStream
    if (!stream || !this.pc || this.pc.connectionState === 'closed') return
    try {
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      this.sttRecorder = rec
      rec.ondataavailable = (e) => {
        if (e.data.size < 2_000) return // pure silence — skip the round trip
        const reader = new FileReader()
        reader.onload = () => {
          const b64 = String(reader.result).slice(String(reader.result).indexOf(',') + 1)
          this.emit({ callId: this.callId ?? '', kind: 'stt-audio', audioBase64: b64, mime: e.data.type || 'audio/webm' })
        }
        reader.readAsDataURL(e.data)
      }
      rec.onstop = () => {
        this.sttRecorder = null
        if (this.sttEnabled && this.pc && this.pc.connectionState !== 'closed') {
          setTimeout(() => this.startSttRecording(), 150)
        }
      }
      rec.start()
      setTimeout(() => {
        try {
          if (rec.state !== 'inactive') rec.stop()
        } catch {
          /* already stopped */
        }
      }, 4_000)
    } catch (error) {
      this.emit({ callId: this.callId ?? '', kind: 'error', detail: `stt recorder: ${String(error)}` })
    }
  }

  private async setRemote(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    if (!this.pc) return
    await this.pc.setRemoteDescription(
      description.type === 'offer'
        ? { type: 'offer', sdp: description.sdp }
        : { type: 'answer', sdp: description.sdp }
    )
    this.remoteSet = true
    // Drain any ICE that arrived early.
    for (const { candidate } of this.pendingIce) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined)
    }
    this.pendingIce = []

    if (description.type === 'offer') {
      // Answerer role: produce the answer (and adopt the phone's data channel).
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)
      this.emit({
        callId: this.callId ?? '',
        kind: 'local-description',
        description: { type: 'answer', sdp: this.pc.localDescription!.sdp }
      })
    }
  }

  private async addIce(candidate: unknown): Promise<void> {
    if (!this.pc) return
    if (!this.remoteSet) {
      this.pendingIce.push({ candidate: candidate as RTCIceCandidateInit })
      return
    }
    await this.pc.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => undefined)
  }

  private async playTts(sentenceId: number, mp3Base64: string): Promise<void> {
    if (!this.ctx || !this.dest) return
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined)
    const bytes = Uint8Array.from(atob(mp3Base64), (c) => c.charCodeAt(0))
    const copy = new ArrayBuffer(bytes.length)
    new Uint8Array(copy).set(bytes)
    const buffer = await this.ctx.decodeAudioData(copy)
    this.queue.push({ sentenceId, buffer })
    void this.drain()
  }

  /** Schedule queued sentences back-to-back; report playing/idle transitions. */
  private async drain(): Promise<void> {
    if (!this.ctx || !this.dest) return
    if (this.playing) return
    const next = this.queue.shift()
    if (!next) {
      if (this.playingSentence !== -1) {
        this.playingSentence = -1
        this.emit({ callId: this.callId ?? '', kind: 'tts-idle' })
      }
      return
    }
    const src = this.ctx.createBufferSource()
    src.buffer = next.buffer
    src.connect(this.dest)
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.playhead)
    src.start(startAt)
    this.playhead = startAt + next.buffer.duration
    this.playing = src
    if (this.playingSentence !== next.sentenceId) {
      this.playingSentence = next.sentenceId
      this.emit({ callId: this.callId ?? '', kind: 'tts-playing' })
    }
    src.onended = () => {
      this.playing = null
      void this.drain()
    }
  }

  private stopTts(): void {
    this.queue = []
    this.playhead = this.ctx?.currentTime ?? 0
    if (this.playing) {
      try {
        this.playing.stop()
      } catch {
        /* already stopped */
      }
      this.playing = null
    }
    if (this.playingSentence !== -1) {
      this.playingSentence = -1
      this.emit({ callId: this.callId ?? '', kind: 'tts-idle' })
    }
  }

  /** RTT + relay/direct every 5s while connected (the More menu's numbers). */
  private startStats(): void {
    if (this.statsTimer !== null) return
    this.statsTimer = window.setInterval(async () => {
      if (!this.pc || this.pc.connectionState !== 'connected') return
      try {
        const report = await this.pc.getStats()
        let rttMs = 0
        let quality: 'direct' | 'relay' | 'unknown' = 'unknown'
        let localType = ''
        let remoteType = ''
        report.forEach((s) => {
          if (s.type === 'candidate-pair' && (s as { state?: string; currentRoundTripTime?: number }).state === 'succeeded') {
            const pair = s as { currentRoundTripTime?: number; nominated?: boolean }
            if (pair.currentRoundTripTime !== undefined && (pair.nominated ?? true)) {
              rttMs = Math.round(pair.currentRoundTripTime * 1000)
            }
          }
          if (s.type === 'local-candidate') localType = (s as { candidateType?: string }).candidateType ?? ''
          if (s.type === 'remote-candidate') remoteType = (s as { candidateType?: string }).candidateType ?? ''
        })
        if (localType === 'relay' || remoteType === 'relay') quality = 'relay'
        else if (localType !== '' && remoteType !== '') quality = 'direct'
        if (rttMs > 0 || quality !== 'unknown') {
          this.emit({ callId: this.callId ?? '', kind: 'stats', rttMs, quality })
        }
      } catch {
        /* stats are best-effort */
      }
    }, 5_000)
  }

  private close(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    this.sttEnabled = false
    try {
      this.sttRecorder?.stop()
    } catch {
      /* already stopped */
    }
    this.sttRecorder = null
    this.remoteStream = null
    this.stopTts()
    try {
      this.dc?.close()
    } catch {
      /* already closed */
    }
    try {
      this.pc?.close()
    } catch {
      /* already closed */
    }
    void this.ctx?.close().catch(() => undefined)
    this.dc = null
    this.pc = null
    this.ctx = null
    this.dest = null
    this.remoteSet = false
  }
}

/** Singleton: App.tsx calls this once on mount. */
export function startCallPeerHost(): void {
  new DesktopPeerHost().start()
}
