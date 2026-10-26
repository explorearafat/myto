import { describe, it, expect } from 'vitest'
import { buildToneProfile, composerSystemPrompt, contactSlug, type ToneMessage } from './tone'

const banglish: ToneMessage[] = [
  { from: 'me', text: 'kemon acho' },
  { from: 'them', text: 'bhaloachi tumi?' },
  { from: 'me', text: 'thik ache 😄' },
  { from: 'me', text: 'ajke ektu busy' },
  { from: 'them', text: 'ok ok' },
  { from: 'me', text: 'pore kotha hobe' },
  { from: 'me', text: 'acha ekta kotha' },
  { from: 'me', text: 'kal dekha hobe?' },
  { from: 'them', text: 'hobe inshallah' },
  { from: 'me', text: 'thik ache 👍' }
]

describe('buildToneProfile', () => {
  const profile = buildToneProfile(banglish)

  it('detects a banglish conversation', () => {
    expect(profile.languageMix.banglish).toBeGreaterThan(0.5)
    expect(profile.languageMix.banglaScript).toBe(0)
  })
  it('measures emoji rate and message length', () => {
    expect(profile.emojiRate).toBeGreaterThan(0)
    expect(profile.avgWords).toBeGreaterThan(1)
    expect(profile.avgWords).toBeLessThan(6)
  })
  it('learns the casual no-fullstop style', () => {
    // One fixture message ends with '?' (real punctuation); the rest trail bare.
    expect(profile.trailingDotRate).toBeGreaterThan(0.8)
  })
  it('keeps short verbatim samples as anchors', () => {
    expect(profile.samples.length).toBeGreaterThan(3)
    expect(profile.samples.every((s) => s.length <= 120)).toBe(true)
  })
  it('counts every message, not just mine', () => {
    expect(profile.samplesCount).toBe(banglish.length)
  })
})

describe('composerSystemPrompt', () => {
  it('demands banglish and the no-dot style for a banglish profile', () => {
    const p = buildToneProfile(banglish)
    const prompt = composerSystemPrompt('Rafi', p, 'saying I will be late')
    expect(prompt).toContain('Banglish')
    expect(prompt).toContain('WITHOUT a full stop')
    expect(prompt).toContain('Rafi')
    expect(prompt).toContain('saying I will be late')
    expect(prompt).toContain('ONLY the message text')
  })
  it('falls back to plain warm voice without a profile', () => {
    const prompt = composerSystemPrompt('X', null, 'hi')
    expect(prompt).toContain('plain, warm, casual')
  })
  it('tells the model to match emoji, never exceed it, for emoji-light chats', () => {
    const p = buildToneProfile(banglish.map((m) => ({ ...m, text: m.text.replace(/[\p{Extended_Pictographic}]/gu, '') })))
    const prompt = composerSystemPrompt('Rafi', p, 'hi')
    expect(prompt).toContain('none')
  })
})

describe('contactSlug', () => {
  it('makes safe filenames', () => {
    expect(contactSlug('Rafi Bhai')).toBe('rafi-bhai')
    expect(contactSlug('  "Arefin" (work) ')).toBe('arefin-work')
  })
})
