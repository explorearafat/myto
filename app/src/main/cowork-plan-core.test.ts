import { describe, it, expect } from 'vitest'
import { looksLikeBigTask } from './cowork-plan-core'

/**
 * looksLikeBigTask drives the auto-plan path (Plan toggle OFF): it must FIRE on
 * substantial build asks (so Myto drafts a plan first) and stay QUIET on questions
 * and small edits (so a one-liner isn't gated behind an approval). The bias is
 * toward quiet — a missed big task just builds directly; a false positive nags.
 */
describe('looksLikeBigTask', () => {
  it('fires on build-intent + project-noun asks (English)', () => {
    expect(looksLikeBigTask('build a landing page')).toBe(true)
    expect(looksLikeBigTask('build a small landing page')).toBe(true)
    expect(looksLikeBigTask('create a dashboard app')).toBe(true)
    expect(looksLikeBigTask('design a portfolio')).toBe(true)
    expect(looksLikeBigTask('make a complete e-commerce site')).toBe(true)
    expect(looksLikeBigTask('can you build me a website')).toBe(true)
  })

  it('fires on Banglish build asks', () => {
    expect(looksLikeBigTask('ekta website banao')).toBe(true)
    expect(looksLikeBigTask('ekta portfolio website banao')).toBe(true)
    expect(looksLikeBigTask('amar jonno ekta dashboard toiri koro')).toBe(true)
  })

  it('fires on a scale word next to a project noun, without an explicit verb', () => {
    expect(looksLikeBigTask('full dashboard')).toBe(true)
    expect(looksLikeBigTask('puro ekta website')).toBe(true)
  })

  it('stays quiet on questions (explain, not build)', () => {
    expect(looksLikeBigTask('what does this function do')).toBe(false)
    expect(looksLikeBigTask('how do I build a website')).toBe(false)
    expect(looksLikeBigTask('why is this failing')).toBe(false)
    expect(looksLikeBigTask('kivabe ekta website banabo')).toBe(false)
  })

  it('stays quiet on small edits and one-liners', () => {
    expect(looksLikeBigTask('fix typo')).toBe(false)
    expect(looksLikeBigTask('fix the title typo')).toBe(false)
    expect(looksLikeBigTask('ekta line change koro')).toBe(false)
    expect(looksLikeBigTask('rename getUserName to getUsername')).toBe(false)
    expect(looksLikeBigTask('add a comment to this file')).toBe(false)
    expect(looksLikeBigTask('make it faster')).toBe(false)
  })

  it('never fires on empty or non-string input', () => {
    expect(looksLikeBigTask('')).toBe(false)
    expect(looksLikeBigTask('   ')).toBe(false)
    // @ts-expect-error — guarding runtime misuse
    expect(looksLikeBigTask(undefined)).toBe(false)
  })

  it('does not trip on substrings (app in happy, site in opposite)', () => {
    expect(looksLikeBigTask('make me happy')).toBe(false)
    expect(looksLikeBigTask('explain the opposite approach')).toBe(false)
  })
})
