/**
 * Voice helpers for the composer.
 *
 * Text-to-speech (reads replies aloud) is always the browser's SpeechSynthesis.
 *
 * Speech-to-text has two paths, matching the user's "Whisper first, Web Speech fallback"
 * choice. Whisper needs a recorded clip sent to the gateway (see main/voice-ipc.ts); the
 * Web Speech API is live in-browser. Because the two capture differently, the path is
 * chosen when dictation STARTS: prefer Whisper when a gateway is configured, otherwise
 * (or if starting the preferred path throws) use Web Speech. {@link startDictation} owns
 * that decision so callers just get a running {@link SttSession}.
 */

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

/** Whether the browser can speak (SpeechSynthesis present). */
export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Strip markdown noise so a spoken reply isn't littered with symbols and code. */
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}

/** Speak `text` aloud, cancelling anything already speaking. Resolves when finished. */
export function ttsSpeak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const spoken = stripForSpeech(text)
    if (!ttsSupported() || !spoken) return resolve()
    try {
      window.speechSynthesis.cancel()
      const utter = new SpeechSynthesisUtterance(spoken)
      utter.onend = () => resolve()
      utter.onerror = () => resolve()
      window.speechSynthesis.speak(utter)
    } catch {
      resolve()
    }
  })
}

/** Stop any in-progress speech immediately. */
export function ttsStop(): void {
  if (!ttsSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

/** A running dictation session; both STT paths present this shape. */
export interface SttSession {
  /** Stop capture and resolve the recognised text (empty string when nothing was heard). */
  stop: () => Promise<string>
  /** Abort without transcribing (mic released without wanting the result). */
  cancel: () => void
}

/** Options for {@link startDictation}. */
export interface DictationOptions {
  /** True when a gateway is configured, so Whisper is the preferred path. */
  preferWhisper: boolean
  /** Live partial transcript callback (Web Speech only — Whisper has no interim results). */
  onPartial?: (text: string) => void
  /**
   * Stop on a natural pause instead of running until the caller stops it. Used by
   * hands-free voice mode so an utterance ends itself. Web Speech honours it (single-
   * shot recognition); the Whisper path can't detect silence, so it ignores it and
   * records until {@link SttSession.stop} is called.
   */
  autoStop?: boolean
  /**
   * Fired when capture ends on its own (Web Speech reached a natural pause with
   * {@link autoStop}), NOT when the caller calls stop/cancel. Hands-free mode uses this
   * to finalise and submit the utterance.
   */
  onEnd?: () => void
}

// -- Web Speech API ----------------------------------------------------------

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: { readonly transcript: string }
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Whether the browser's live Web Speech recognition is available. */
export function webSpeechSupported(): boolean {
  return recognitionCtor() != null
}

function startWebSpeech(
  onPartial?: (text: string) => void,
  autoStop?: boolean,
  onEnd?: () => void
): SttSession {
  const Ctor = recognitionCtor()
  if (!Ctor) throw new Error('Web Speech API is unavailable.')
  const rec = new Ctor()
  rec.lang = navigator.language || 'en-US'
  rec.interimResults = true
  // Continuous keeps listening for push-to-talk; single-shot ends on a natural pause
  // for hands-free (so an utterance finalises itself and gets submitted).
  rec.continuous = !autoStop

  let finalText = ''
  let ended = false
  let stoppedByCaller = false
  const endWaiters: Array<() => void> = []
  rec.onend = () => {
    ended = true
    for (const w of endWaiters.splice(0)) w()
    // A natural end (not a caller stop/cancel) is what hands-free listens for.
    if (!stoppedByCaller) onEnd?.()
  }
  rec.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result[0]?.transcript ?? ''
      if (result.isFinal) finalText += transcript
      else interim += transcript
    }
    onPartial?.((finalText + interim).trim())
  }
  rec.onerror = () => {
    /* handled by resolving with whatever was captured on end */
  }
  rec.start()

  const waitForEnd = (): Promise<void> =>
    ended ? Promise.resolve() : new Promise<void>((resolve) => endWaiters.push(resolve))

  return {
    async stop() {
      stoppedByCaller = true
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
      await waitForEnd()
      return finalText.trim()
    },
    cancel() {
      stoppedByCaller = true
      try {
        rec.abort()
      } catch {
        /* ignore */
      }
    }
  }
}

// -- Whisper (record → gateway) ---------------------------------------------

/** A recorder MIME the browser supports, or '' to let MediaRecorder pick its default. */
function preferredMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      /* isTypeSupported can throw on some engines */
    }
  }
  return ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      // Strip the `data:<mime>;base64,` prefix — the IPC wants raw base64.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

async function startWhisper(): Promise<SttSession> {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Audio recording is unavailable.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mime = preferredMime()
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }
  recorder.start()
  const releaseMic = (): void => stream.getTracks().forEach((track) => track.stop())

  const waitForStop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })

  return {
    async stop() {
      const stopped = waitForStop()
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped
      releaseMic()
      const blob = new Blob(chunks, { type: mime || 'audio/webm' })
      if (blob.size === 0) return ''
      const data = await blobToBase64(blob)
      const result = await window.myto.voice.transcribe({ data, mime: blob.type || 'audio/webm' })
      if (result.ok && result.text) return result.text
      throw new Error(result.error ?? 'transcription failed')
    },
    cancel() {
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        /* ignore */
      }
      releaseMic()
    }
  }
}

/**
 * Start a dictation session, choosing the path per the "Whisper first, Web Speech
 * fallback" rule. Prefers Whisper when a gateway is configured; if starting the
 * preferred path fails (no mic permission, unsupported), falls back to the other. Throws
 * only when neither path can start.
 */
export async function startDictation(options: DictationOptions): Promise<SttSession> {
  const order: Array<'whisper' | 'webspeech'> = options.preferWhisper
    ? ['whisper', 'webspeech']
    : ['webspeech', 'whisper']

  let lastError: unknown
  for (const path of order) {
    try {
      if (path === 'whisper') return await startWhisper()
      return startWebSpeech(options.onPartial, options.autoStop, options.onEnd)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Voice input is unavailable.')
}
