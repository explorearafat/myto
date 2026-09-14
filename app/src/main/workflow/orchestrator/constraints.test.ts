import { describe, expect, it } from 'vitest'
import {
  describeConstraints,
  effectiveTurnEffort,
  extractConstraints,
  hasConstraints,
  phaseCeilingComplexity
} from '@main/workflow/orchestrator/constraints'

/**
 * Constraints are extracted deterministically and conservatively: a real, explicit
 * phrase must be present, because a false positive would wrongly shrink a plan.
 * These tests pin both what IS caught and — just as important — what is NOT.
 */
describe('extractConstraints — task/step caps', () => {
  it('reads "in at most N steps"', () => {
    expect(extractConstraints('build it in at most 5 steps').maxSteps).toBe(5)
  })

  it('reads spelled-out numbers', () => {
    expect(extractConstraints('do it in at most five steps').maxSteps).toBe(5)
  })

  it('reads a bare "in N steps" and "N tasks or fewer"', () => {
    expect(extractConstraints('add sign-in in 3 steps').maxSteps).toBe(3)
    expect(extractConstraints('keep it to 4 tasks or fewer').maxSteps).toBe(4)
  })

  it('treats "tasks" and "steps" as the same budget', () => {
    expect(extractConstraints('no more than 2 tasks').maxSteps).toBe(2)
  })

  it('ignores an implausible or zero count', () => {
    expect(extractConstraints('in 0 steps').maxSteps).toBeUndefined()
    expect(extractConstraints('in 900 steps').maxSteps).toBeUndefined()
  })

  it('does not read a four-digit year as a cap', () => {
    expect(extractConstraints('ship the 2026 steps redesign').maxSteps).toBeUndefined()
  })
})

describe('extractConstraints — phase caps', () => {
  it('reads "no more than N phases"', () => {
    expect(extractConstraints('do this in no more than 2 phases').maxPhases).toBe(2)
  })

  it('keeps step and phase caps independent', () => {
    const c = extractConstraints('in at most 6 steps and no more than 3 phases')
    expect(c.maxSteps).toBe(6)
    expect(c.maxPhases).toBe(3)
  })
})

describe('extractConstraints — minimal', () => {
  it('catches curated "keep it minimal" phrasings', () => {
    for (const p of ['keep it minimal', "don't over-engineer", 'nothing fancy', 'bare minimum']) {
      expect(extractConstraints(`please ${p} here`).minimal, p).toBe(true)
    }
  })

  it('does not fire on ordinary prose that merely mentions simple things', () => {
    expect(extractConstraints('add a simple login form to the page').minimal).toBeFalsy()
    expect(extractConstraints('build the minimal viable product roadmap module').minimal).toBeFalsy()
  })
})

describe('extractConstraints — file scope', () => {
  it('captures explicit file targets', () => {
    const c = extractConstraints('only touch src/auth.ts and src/db.ts, nothing else')
    expect(c.filesScope).toEqual(['src/auth.ts', 'src/db.ts'])
  })

  it('stays empty when the "only touch" target is prose, not files', () => {
    expect(extractConstraints('only touch the login flow').filesScope).toBeUndefined()
  })
})

describe('extractConstraints — verbatim + emptiness', () => {
  it('quotes back every matched phrase', () => {
    const c = extractConstraints('in at most 5 steps, and keep it minimal')
    expect(c.verbatim).toContain('5 steps')
    expect(c.verbatim).toContain('keep it minimal')
  })

  it('returns an empty object for an unconstrained request', () => {
    const c = extractConstraints('build me a university admissions website')
    expect(c).toEqual({})
    expect(hasConstraints(c)).toBe(false)
  })
})

describe('phaseCeilingComplexity', () => {
  it('shrinks to medium for a minimal request', () => {
    expect(phaseCeilingComplexity({ minimal: true })).toBe('medium')
  })

  it('shrinks to medium for a small explicit phase or step budget', () => {
    expect(phaseCeilingComplexity({ maxPhases: 2 })).toBe('medium')
    expect(phaseCeilingComplexity({ maxSteps: 5 })).toBe('medium')
  })

  it('never shrinks below medium — simple is not reachable from a scope phrase', () => {
    // Even the tightest scope only demotes the roadmap tier to medium; collapsing to
    // the single-node SIMPLE path is a complexity-router decision, not a scope one.
    expect(phaseCeilingComplexity({ minimal: true, maxSteps: 1 })).toBe('medium')
  })

  it('implies no shrink when the budget is large or absent', () => {
    expect(phaseCeilingComplexity({})).toBeUndefined()
    expect(phaseCeilingComplexity({ maxSteps: 8 })).toBeUndefined()
    expect(phaseCeilingComplexity({ maxPhases: 9 })).toBeUndefined()
  })
})

describe('effectiveTurnEffort (Principle 5 — effort agrees with the roadmap)', () => {
  it('forces max for an unconstrained complex build', () => {
    // The everyday "build me a whole app" path: complex → max, requested tier ignored.
    expect(effectiveTurnEffort('complex', 'medium', 'build me a full task manager app')).toBe('max')
    expect(effectiveTurnEffort('complex', 'low', 'build a whole dashboard with charts')).toBe('max')
  })

  it('does NOT force max when an explicit smaller scope clamps the roadmap to medium', () => {
    // THE flagged interaction: sized complex, but "keep it minimal" clamps the roadmap
    // to medium — so the turn must fall back to the requested tier, not pay max.
    expect(effectiveTurnEffort('complex', 'medium', 'build the login page — keep it minimal')).toBe(
      'medium'
    )
    expect(effectiveTurnEffort('complex', 'low', 'add a logout button in at most 3 steps')).toBe(
      'low'
    )
  })

  it('honours an explicit high/max dial under a smaller scope — the clamp removes only the auto-bump, never caps the dial', () => {
    // Sized complex + "keep it minimal" clamps the roadmap to medium. The clamp only
    // strips the AUTOMATIC bump to max; a tier the user dialled by hand is still theirs,
    // neither forced up to max nor capped down to medium.
    expect(effectiveTurnEffort('complex', 'high', 'build the header, keep it minimal')).toBe('high')
    expect(effectiveTurnEffort('complex', 'max', 'add a logout button, keep it minimal')).toBe('max')
  })

  it('passes a non-complex turn through at exactly the requested tier', () => {
    // simple / medium turns are never bumped and never clamped — the dial wins.
    expect(effectiveTurnEffort('medium', 'high', 'refactor the parser')).toBe('high')
    expect(effectiveTurnEffort('simple', 'low', 'fix the typo')).toBe('low')
    expect(effectiveTurnEffort(null, 'medium', 'what does this file do?')).toBe('medium')
    // Even with a minimal phrase, a non-complex turn just uses the requested tier.
    expect(effectiveTurnEffort('medium', 'high', 'keep it minimal')).toBe('high')
  })
})

describe('describeConstraints', () => {
  it('is empty when there is nothing to say', () => {
    expect(describeConstraints({})).toBe('')
  })

  it('renders each rule and quotes the user back', () => {
    const note = describeConstraints({
      maxSteps: 5,
      minimal: true,
      filesScope: ['src/a.ts'],
      verbatim: 'in at most 5 steps; keep it minimal'
    })
    expect(note).toContain('at most 5 tasks')
    expect(note).toContain('keep it minimal')
    expect(note).toContain('src/a.ts')
    expect(note).toContain('in at most 5 steps')
    expect(note).toMatch(/honour it exactly/i)
  })

  it('uses a singular noun for a one-task budget', () => {
    expect(describeConstraints({ maxSteps: 1 })).toContain('at most 1 task')
  })
})
