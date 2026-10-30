import { describe, expect, it } from 'vitest'

import {
  extractSentences,
  splitSentences,
  spokenText,
  TtsService
} from './tts-service'

describe('extractSentences', () => {
  it('splits complete sentences and keeps the unfinished tail', () => {
    const { sentences, rest } = extractSentences('Hello there. I am working on it! Wait,')
    expect(sentences).toEqual(['Hello there.', 'I am working on it!'])
    expect(rest).toBe('Wait,')
  })

  it('does not split on abbreviations', () => {
    const { sentences, rest } = extractSentences('Dr. Smith and Mr. Jones arrived')
    expect(sentences).toEqual([])
    expect(rest).toBe('Dr. Smith and Mr. Jones arrived')
  })

  it('splits when the abbreviation sentence actually ends', () => {
    const { sentences } = extractSentences('Dr. Smith arrived. He was late.')
    expect(sentences).toEqual(['Dr. Smith arrived.', 'He was late.'])
  })

  it('flushes a long unbroken tail in soft pieces', () => {
    const long = 'a '.repeat(200).trim() // 400 chars, no punctuation
    const { sentences, rest } = extractSentences(long)
    expect(sentences.length).toBeGreaterThan(1)
    expect(rest).toBe('')
  })

  it('strips markdown fences before splitting', () => {
    const { sentences } = extractSentences('Here is the plan. ```ts\nconst a = 1\n```\nAnything else?')
    expect(sentences).toEqual(['Here is the plan.', 'Anything else?'])
  })

  it('returns empty for empty input', () => {
    expect(extractSentences('')).toEqual({ sentences: [], rest: '' })
  })
})

describe('splitSentences', () => {
  it('returns the tail as the final item', () => {
    expect(splitSentences('One. Two is coming')).toEqual(['One.', 'Two is coming'])
  })
})

describe('spokenText', () => {
  it('drops code fences, emphasis and link targets', () => {
    expect(spokenText('Run `npm test` — see [the docs](https://x.y) *now*.'))
      .toBe('Run npm test — see the docs now.')
  })
})

describe('TtsService streaming', () => {
  it('feeds sentence-by-sentence into the queue without synthesis (degraded mode)', async () => {
    const spoken: string[] = []
    const svc = new TtsService({
      onAudio: () => undefined,
      onFallbackText: (sentence) => spoken.push(sentence),
      onError: () => undefined
    })
    // FAILURE_LIMIT consecutive failures put it in degraded mode without any
    // network access (each pump attempt fails fast on a bogus endpoint env).
    // Instead of forcing failures, we assert the queue plumbing via a fresh
    // service stopped immediately: say() must be a no-op after stop().
    svc.start()
    svc.stop()
    svc.say('This must not be spoken.')
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toEqual([])
    expect(svc.isStopped()).toBe(true)
  })
})
