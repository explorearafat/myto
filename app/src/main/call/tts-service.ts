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

// ---------------------------------------------------------------------------
// Expressiveness: humans never speak every sentence at one flat rate and
// pitch. These helpers turn a plain sentence into (spoken text, rate, pitch):
// laughter markers become actual giggly "ha ha ha", questions lift, long
// explanations speed up, short asides slow down, everything gets a little
// jitter — so Myto sounds like a person, not a GPS.
// ---------------------------------------------------------------------------

/** The user's More-menu offset ("+10%" / "-5%" / "default"), as a signed number. */
export function parseRatePercent(rate: string): number {
  const m = /^([+-]\d{1,2})%$/.exec(rate ?? '')
  return m ? Number(m[1]) : 0
}

const RATE_MIN = -25
const RATE_MAX = 30
const PITCH_MIN = -30
const PITCH_MAX = 40

export interface ExpressedSentence {
  text: string
  rate: string
  pitch: string
}

/**
 * Turn a clean sentence into expressive speech parameters. Exported for tests.
 * Laughter/emotion markers the model writes ("haha", "[laughs]", "sighs") are
 * converted into spoken forms with matching tone; sentence shape (question /
 * exclamation / long / short) tunes rate and pitch; a touch of jitter keeps
 * consecutive sentences from sounding mechanical.
 */
export function expressify(sentence: string, userRate: string): ExpressedSentence {
  let text = ` ${sentence.trim()} `
  let rate = parseRatePercent(userRate)
  let pitch = 0

  // Laughter: any marker becomes a spoken giggle, faster and brighter.
  const giggleRe = /\[?(laugh(?:s|ing)?|haha+|hehe+|hihi+|lol|lmao)\]?/gi
  let giggles = 0
  text = text.replace(giggleRe, () => {
    giggles++
    return ' ha ha ha, '
  })
  if (giggles > 0) {
    rate += 16 + Math.min(8, giggles * 4)
    pitch += 22
  }

  // A sigh slows everything down and drops the pitch a touch.
  if (/\[?(sighs?|sighing)\]?/gi.test(text)) {
    text = text.replace(/\[?sighs?(ing)?\]?/gi, ' ahh,')
    rate -= 9
    pitch -= 8
  }

  // Interjections carry feeling — brighten them.
  if (/^\s*(wow|oh (no|wow|my)|oof|ouch|yay|whoa|aww|hm+m)\b/i.test(text)) {
    pitch += 9
  }

  // Sentence shape.
  const s = text.trim()
  if (s.endsWith('?')) {
    pitch += 11 // a question lifts at the end
    rate -= 3
  } else if (s.endsWith('!')) {
    rate += 6
    pitch += 7
  }
  if (s.length > 140) rate += 5 // long explanations flow faster
  else if (s.length < 55) rate -= 3 // short asides land slower

  // Deterministic-feeling jitter (±2%) so no two sentences match exactly.
  const jitter = ((s.length % 5) - 2) * 1.2
  rate += jitter

  const r = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, rate)))
  const p = Math.round(Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch)))
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    rate: `${r >= 0 ? '+' : ''}${r}%`,
    pitch: p === 0 ? 'default' : `${p >= 0 ? '+' : ''}${p}Hz`
  }
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
    // Expressive transform first: the fallback path speaks the same cleaned
    // text ("ha ha ha" instead of literal "haha") on the phone.
    const expr = expressify(sentence, this.rate)
    // Degraded mode: Edge is down for this call — let the phone speak it.
    if (this.consecutiveFailures >= FAILURE_LIMIT) {
      this.cb.onFallbackText(expr.text)
      return
    }
    try {
      // Per-sentence expressive prosody: the rate/pitch ride on top of the
      // user's More-menu offset, shaped by the sentence's emotion and shape.
      const tts = new EdgeTTS({
        voice: MYTO_VOICE,
        lang: MYTO_LANG,
        rate: expr.rate,
        pitch: expr.pitch,
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 12_000
      })
      // Edge streams a sentence as several MP3 chunks; the renderer decodes ONE
      // complete MP3 per sentence, so accumulate before handing it over.
      const chunks: Buffer[] = []
      for await (const chunk of tts.streamAudio(expr.text)) {
        if (this.stopped) break // breaking the generator closes the Edge connection
        if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      }
      if (this.stopped) return
      if (chunks.length > 0) this.cb.onAudio(expr.text, Buffer.concat(chunks))
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
      this.cb.onFallbackText(expr.text)
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
