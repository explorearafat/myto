/**
 * The tone engine — the piece that makes the Assistant sound like YOU in a
 * conversation. Given the last few days of messages between you and one person
 * (from screenshots the vision model read, or text you pasted), it distils a
 * compact STYLE PROFILE: which language mix you two use (Bangla script /
 * Banglish / English), how often you emoji, how long your messages run, whether
 * you end with dots, your usual openers — and turns that profile into strict
 * composer instructions. Pure functions only; storage is a tiny JSON per
 * contact under the assistant data dir.
 */

export interface ToneMessage {
  from: 'me' | 'them'
  text: string
}

export interface ToneProfile {
  /** Rough share of Bangla-script words, Banglish markers and English. */
  languageMix: { banglaScript: number; banglish: number; english: number }
  /** Emoji per message, averaged. */
  emojiRate: number
  /** Mean words per message (me only — that's the voice we clone). */
  avgWords: number
  /** Share of messages ending without a full stop. */
  trailingDotRate: number
  /** Share of fully-lowercase messages (the "casual typing" signal). */
  lowercaseRate: number
  /** Frequent openers (first token) and signoffs (last token), me only. */
  openers: string[]
  signoffs: string[]
  /** Up to 12 characteristic short messages kept verbatim as style anchors. */
  samples: string[]
  /** How many messages the profile was built from. */
  samplesCount: number
  builtAt: string
}

const BANGLA_RE = /[\u0980-\u09FF]/
const BANGLISH_WORDS = /\b(ami|tumi|tui|apni|kemon|acho|achhen|accha|acha|thik|ache|korbo|korchi|kore|hobe|janina|bhalo|kotha|dekhi|pore|age|ekhon|kichu|onek|valo|kori|keno|kivabe|ki)\b/gi
const EMOJI_RE = /(\p{Extended_Pictographic}|\u{1F3FB}-?\u200d?)|\uFE0F/gu

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? m.length : 0
}

function isEmojiOnly(text: string): boolean {
  const stripped = text.replace(EMOJI_RE, '').replace(/\s/g, '')
  return stripped.length === 0 && text.trim().length > 0
}

/** Pure: build the profile from the message samples (mine dominate the voice). */
export function buildToneProfile(messages: ToneMessage[], now = new Date()): ToneProfile {
  const mine = messages.filter((m) => m.from === 'me' && m.text.trim())
  const all = messages.filter((m) => m.text.trim())

  let banglaScript = 0
  let banglish = 0
  let english = 0
  let emoji = 0
  let words = 0
  let noDot = 0
  let lower = 0
  const openerTally = new Map<string, number>()
  const signoffTally = new Map<string, number>()

  for (const m of mine) {
    const text = m.text.trim()
    const tokens = text.split(/\s+/).filter(Boolean)
    words += tokens.length
    emoji += countMatches(text, EMOJI_RE)
    if (!/[.!?]$/.test(text)) noDot++
    const letters = text.replace(/[^a-zA-Z]/g, '')
    if (letters.length > 3 && letters === letters.toLowerCase()) lower++
    const hasScript = BANGLA_RE.test(text)
    const hasBanglish = countMatches(text, BANGLISH_WORDS) > 0
    if (hasScript) banglaScript++
    else if (hasBanglish) banglish++
    else english++
    if (tokens.length >= 1 && !isEmojiOnly(text)) {
      const opener = tokens[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      if (opener) openerTally.set(opener, (openerTally.get(opener) ?? 0) + 1)
      const signoff = tokens[tokens.length - 1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      if (signoff) signoffTally.set(signoff, (signoffTally.get(signoff) ?? 0) + 1)
    }
  }

  const top = (tally: Map<string, number>): string[] =>
    [...tally.entries()]
      .filter(([w, n]) => w.length > 1 && n >= Math.max(2, Math.ceil(mine.length * 0.15)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w)

  const n = Math.max(mine.length, 1)
  return {
    languageMix: {
      banglaScript: round(banglaScript / n),
      banglish: round(banglish / n),
      english: round(english / n)
    },
    emojiRate: round(emoji / n),
    avgWords: Math.round(words / n),
    trailingDotRate: round(noDot / n),
    lowercaseRate: round(lower / n),
    openers: top(openerTally),
    signoffs: top(signoffTally),
    // Short messages carry the voice best; skip emoji-only ones.
    samples: mine
      .map((m) => m.text.trim())
      .filter((t) => !isEmojiOnly(t) && t.length <= 120)
      .slice(-12),
    samplesCount: all.length,
    builtAt: now.toISOString()
  }
}

function round(x: number): number {
  return Math.round(x * 100) / 100
}

/** Pure: turn the profile into the composer's system prompt. Strict by design —
 * the user's #1 rule is "no mistakes, exact tune". */
export function composerSystemPrompt(contact: string, profile: ToneProfile | null, userIntent: string): string {
  const lines: string[] = []
  if (profile) {
    const mix = profile.languageMix
    const lang =
      mix.banglaScript >= 0.5
        ? 'Mostly Bangla (in Bangla script).'
        : mix.banglish >= 0.5
          ? 'Mostly Banglish — Bangla written with English letters (e.g. "kemon acho", "thik ache").'
          : 'Mostly English.'
    lines.push(
      `You are writing ONE chat message from the user to ${contact}. Match their shared conversation style EXACTLY — this is a real message, not an exercise.`,
      `Language: ${lang} (script shares — bangla: ${mix.banglaScript}, banglish: ${mix.banglish}, english: ${mix.english}).`,
      `Length: their messages average ~${profile.avgWords} words; stay within about that.`,
      `Emoji: they use ~${profile.emojiRate} per message — ${profile.emojiRate <= 0.2 ? 'none' : 'match it, never more'}.`,
      profile.trailingDotRate > 0.6
        ? 'Punctuation: they usually end WITHOUT a full stop — do the same.'
        : 'Punctuation: they close sentences normally.',
      profile.lowercaseRate > 0.5 ? 'Capitalisation: they type in lowercase — do the same.' : '',
      profile.openers.length ? `Typical openers: ${profile.openers.slice(0, 3).join(', ')}.` : '',
      profile.samples.length ? `Style anchors (their real messages):\n${profile.samples.map((s) => `- ${s}`).join('\n')}` : ''
    )
  } else {
    lines.push(`You are writing ONE chat message from the user to ${contact}, in a plain, warm, casual voice.`)
  }
  lines.push(
    '',
    'Hard rules: reply with ONLY the message text — no quotes, no explanations, no markdown.',
    'Keep every fact the user asked to convey; invent nothing else.',
    '',
    `What the message should say: ${userIntent}`
  )
  return lines.filter(Boolean).join('\n')
}

// ── Storage (per contact, under the assistant data dir) ─────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** "Rafi Bhai" → "rafi-bhai" — the per-contact profile filename. */
export function contactSlug(contact: string): string {
  return (
    contact
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'contact'
  )
}

export function tonePath(dir: string, contact: string): string {
  return join(dir, 'tones', contactSlug(contact) + '.json')
}

export function loadToneProfile(dir: string, contact: string): ToneProfile | null {
  try {
    const p = tonePath(dir, contact)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as ToneProfile
  } catch {
    return null
  }
}

export function saveToneProfile(dir: string, contact: string, profile: ToneProfile): void {
  const tones = join(dir, 'tones')
  mkdirSync(tones, { recursive: true })
  writeFileSync(tonePath(dir, contact), JSON.stringify(profile, null, 2) + '\n', 'utf8')
}
