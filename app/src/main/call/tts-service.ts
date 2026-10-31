/**
 * The call TTS engine: Myto's voice on the phone.
 *
 * Pipeline: the agent streams text → {@link TtsService.feed} accumulates it →
 * complete sentences are extracted as they form → each is synthesized by
 * Microsoft Edge TTS (`en-IN-NeerjaNeural`) → MP3 buffers are handed to the
 * renderer, which decodes and schedules them on the WebRTC audio track. The
 * first sentence is usually in the phone's speaker ~1s after the model starts
 * replying; the rest keeps synthesizing behind it.
 *
 * Interruption (barge-in): {@link stop} breaks the in-flight synthesis
 * generator (which closes the Edge connection), drops everything queued, and is
 * called the moment the phone reports the user speaking.
 *
 * Reliability: the free Edge endpoint occasionally rate-limits; after repeated
 * failures the service degrades to text-only mode and the phone speaks the same
 * sentences locally (on-device TTS fallback).
 */
import { EdgeTTS } from 'node-edge-tts'

/** Myto's voice — natural female Indian English (the spec's exact voice). */
export const MYTO_VOICE = 'en-IN-NeerjaNeural'
export const MYTO_LANG = 'en-IN'

/** Consecutive Edge failures before degrading to phone-side TTS for the call. */
const FAILURE_LIMIT = 3

/** Common abbreviations whose periods must NOT end a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'approx', 'apt', 'dept', 'est', 'inc', 'ltd', 'no', 'vol', 'fig', 'min', 'max'
])

/**
 * Make model prose speakable: drop code fences, inline code backticks, markdown
 * emphasis, links (keep the label), list markers, and headings. Exported for tests.
 */
export function spokenText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>]{1,3}/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract the COMPLETE, speakable sentences from `text`, returning what should
 * stay buffered (an unfinished tail) in `rest`. A long tail with no sentence
 * boundary is flushed in soft-boundary pieces (comma/space) so a rambling model
 * still streams promptly. Exported for unit tests.
 */
export function extractSentences(input: string): { sentences: string[]; rest: string } {
  const text = spokenText(input)
  if (!text) return { sentences: [], rest: '' }
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '.' && ch !== '!' && ch !== '?') continue
    // A sentence end needs a boundary after it (end of text or a space).
    if (i + 1 < text.length && text[i + 1] !== ' ') continue
    // Abbreviation guard: the word before the period is a known abbreviation.
    if (ch === '.') {
      const before = text.slice(start, i).trimEnd()
      const lastWord = before.slice(before.lastIndexOf(' ') + 1).toLowerCase()
      if (ABBREVIATIONS.has(lastWord.replace(/\.+$/, ''))) continue
    }
    const sentence = text.slice(start, i + 1).trim()
    if (sentence) sentences.push(sentence)
    start = i + 1
  }
  let rest = text.slice(start).trim()
  // Flush a long unbroken tail in soft pieces so playback isn't starved.
  if (rest.length > 280) {
    let from = 0
    while (from < rest.length) {
      let cut = Math.min(from + 240, rest.length)
      if (cut < rest.length) {
        const soft = Math.max(
          rest.lastIndexOf(',', cut),
          rest.lastIndexOf(': ', cut),
          rest.lastIndexOf(' ', cut)
        )
        if (soft > from + 80) cut = soft + 1
      }
      const piece = rest.slice(from, cut).trim()
      if (piece) sentences.push(piece)
      from = cut
    }
    rest = ''
  }
  return { sentences, rest }
}

/**
 * Convenience: split a COMPLETE text into speakable sentences (the streaming
 * path uses {@link extractSentences}; this is for whole-string inputs).
 */
export function splitSentences(input: string): string[] {
  const { sentences, rest } = extractSentences(input)
  return rest ? [...sentences, rest] : sentences
}

export interface TtsCallbacks {
  /** One synthesized sentence (complete MP3 buffer), in speaking order. */
  onAudio: (sentence: string, mp3: Buffer) => void
  /** Edge failed for this sentence — the phone speaks the text locally instead. */
  onFallbackText: (sentence: string) => void
  /** Pipeline error (diagnostics; the call keeps flowing). */
  onError: (error: string) => void
}

export class TtsService {
  private readonly cb: TtsCallbacks
  private queue: string[] = []
  private buffer = ''
  private synthBusy = false
  private stopped = true
  private consecutiveFailures = 0
  private rate = 'default'
  /** Guards against re-entrant stop() while a generator is unwinding. */
  private stopping = false

  constructor(cb: TtsCallbacks) {
    this.cb = cb
  }

  /** Voice speed, Edge-style (e.g. '+10%', '-5%'). Set from the phone's More menu. */
  setRate(rate: string): void {
    if (/^[+-]\d{1,2}%$/.test(rate) || rate === 'default') this.rate = rate
  }

  getRate(): string {
    return this.rate
  }

  /** Begin speaking. A fresh service starts stopped; sessions call start() once. */
  start(): void {
    this.stopped = false
  }

  /** Feed a stream delta from the agent. Sentences are emitted as they complete. */
  feed(delta: string): void {
    if (this.stopped || !delta) return
    this.buffer += delta
    const { sentences, rest } = extractSentences(this.buffer)
    this.buffer = rest
    for (const s of sentences) this.enqueue(s)
  }

  /** Flush whatever remains (end of the agent's reply) even without a closing period. */
  flush(): void {
    if (this.stopped || !this.buffer.trim()) return
    const tail = this.buffer.trim()
    this.buffer = ''
    if (tail) this.enqueue(tail)
  }

  /** Speak one complete text immediately (greeting, callback scripts, confirmations). */
  say(text: string): void {
    if (this.stopped) return
    for (const s of splitSentences(spokenText(text))) this.enqueue(s)
  }

  private enqueue(sentence: string): void {
    this.queue.push(sentence)
    if (this.queue.length > 20) this.queue = this.queue.slice(-20) // runaway guard
    void this.pump()
  }

  /**
   * Synthesize queued sentences sequentially (order matters). Each finished
   * sentence is handed to the renderer's playback queue immediately, so the
   * phone never waits for later sentences to finish synthesizing.
   */
  private async pump(): Promise<void> {
    if (this.synthBusy || this.stopped) return
    this.synthBusy = true
    try {
      while (!this.stopped && this.queue.length > 0) {
        const sentence = this.queue[0]
        await this.synthesizeOne(sentence)
        this.queue.shift()
      }
    } finally {
      this.synthBusy = false
    }
  }

  private async synthesizeOne(sentence: string): Promise<void> {
    // Degraded mode: Edge is down for this call — let the phone speak it.
    if (this.consecutiveFailures >= FAILURE_LIMIT) {
      this.cb.onFallbackText(sentence)
      return
    }
    try {
      const tts = new EdgeTTS({
        voice: MYTO_VOICE,
        lang: MYTO_LANG,
        rate: this.rate,
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 12_000
      })
      // Edge streams a sentence as several MP3 chunks; the renderer decodes ONE
      // complete MP3 per sentence, so accumulate before handing it over.
      const chunks: Buffer[] = []
      for await (const chunk of tts.streamAudio(sentence)) {
        if (this.stopped) break // breaking the generator closes the Edge connection
        if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      }
      if (this.stopped) return
      if (chunks.length > 0) this.cb.onAudio(sentence, Buffer.concat(chunks))
      this.consecutiveFailures = 0
    } catch (error) {
      if (this.stopped) return
      this.consecutiveFailures++
      this.cb.onError(
        `edge-tts failed (${this.consecutiveFailures}/${FAILURE_LIMIT}): ${String(error)}`
      )
      // A 429 is a rate limit — it won't recover mid-call, so degrade NOW
      // instead of silently dropping the next two sentences.
      if (String(error).includes('429')) this.consecutiveFailures = FAILURE_LIMIT
      // A failed sentence would otherwise be silent forever: hand it to the
      // phone immediately (it speaks the text with its own voice).
      this.cb.onFallbackText(sentence)
    }
  }

  /** Barge-in / hangup / hold: kill the current synthesis and drop the queue. */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    this.stopped = true
    this.queue = []
    this.buffer = ''
    // Allow a future instance reuse only after generators unwind; sessions
    // create a fresh TtsService per call, so this is just re-entrancy safety.
    setTimeout(() => {
      this.stopping = false
    }, 50)
  }

  isStopped(): boolean {
    return this.stopped
  }
}
