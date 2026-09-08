import { describe, expect, it } from 'vitest'
import {
  findingsNudge,
  isGatherTool,
  listPaths,
  planReadWindow,
  stopGatheringNudge
} from '@main/workflow/gather'

/**
 * The gathering pass, unit-tested without a run: `planReadWindow` is the mechanism
 * that turns "13 inspection steps" into one, and the two nudges are the hand-off
 * that stops the model going back for a fourteenth look. Pure module, no Electron.
 */

describe('isGatherTool', () => {
  it('recognises the four read-only inspection blocks', () => {
    for (const t of ['read_file', 'list_files', 'search_files', 'find_files']) {
      expect(isGatherTool(t)).toBe(true)
    }
  })

  it('rejects anything that changes the project or the world', () => {
    for (const t of [
      'edit_file',
      'write_file',
      'run_command',
      'web_fetch',
      'preview_inspect',
      'spawn_agent',
      ''
    ]) {
      expect(isGatherTool(t)).toBe(false)
    }
  })
})

describe('planReadWindow', () => {
  it('makes the FIRST read of a file whole, ignoring a guessed window', () => {
    // `lines 830–889 of 1769` is a keyhole: the model cannot know a useful window
    // before it has seen the file, and a keyhole always costs a second read.
    expect(planReadWindow(false, 830)).toEqual({})
    expect(planReadWindow(false, 1)).toEqual({})
    expect(planReadWindow(false, undefined)).toEqual({})
  })

  it('honours an offset once the whole file HAS been read — that is a continuation', () => {
    expect(planReadWindow(true, 4_001)).toEqual({ offset: 4_001 })
  })

  it('treats offset 1 (or none) after a whole read as another whole read', () => {
    // Nothing to continue from at line 1, so this is a repeat, not a continuation —
    // and a repeat is what the read cache answers from a note.
    expect(planReadWindow(true, 1)).toEqual({})
    expect(planReadWindow(true, 0)).toEqual({})
    expect(planReadWindow(true, undefined)).toEqual({})
  })

  it('never returns a limit — how much fits is the reader cap, not a model guess', () => {
    for (const plan of [
      planReadWindow(false, 10),
      planReadWindow(true, 10),
      planReadWindow(true, undefined)
    ]) {
      expect(plan.limit).toBeUndefined()
    }
  })
})

describe('listPaths', () => {
  it('joins a short list in full', () => {
    expect(listPaths(['a.ts', 'b.ts'])).toBe('a.ts, b.ts')
  })

  it('elides a long list so one nudge cannot become a wall of paths', () => {
    const many = Array.from({ length: 15 }, (_, i) => `f${i}.ts`)
    const out = listPaths(many)
    expect(out).toContain('f0.ts')
    expect(out).toContain('f11.ts')
    expect(out).not.toContain('f12.ts')
    expect(out).toContain('+3 more')
  })

  it('is empty for no paths', () => {
    expect(listPaths([])).toBe('')
  })
})

describe('findingsNudge', () => {
  it('declares the pass over, names what is held, and asks for ONE message', () => {
    const n = findingsNudge(['PromoBanner.tsx', 'Navbar.tsx'])
    expect(n).toContain('gathering pass is done')
    expect(n).toContain('PromoBanner.tsx, Navbar.tsx')
    expect(n).toContain('no tool block yet')
    // The four things the findings message must contain — what/where/each/how.
    expect(n).toContain('what you read')
    expect(n).toContain('what you actually found')
    expect(n).toContain('how you are going to fix it')
    // And the refusal that keeps it from looking again instead.
    expect(n).toContain('Do NOT open any of those files again')
  })

  it('omits the holding list when there is nothing to name', () => {
    expect(findingsNudge([])).not.toContain('You are holding')
  })
})

describe('stopGatheringNudge', () => {
  it('names the round it is on and refuses another look', () => {
    const n = stopGatheringNudge(3, ['a.ts'])
    expect(n).toContain('round 3')
    expect(n).toContain('a.ts')
    expect(n).toContain('Stop gathering')
    expect(n).toContain('edit_file')
  })

  it('still allows ONE genuinely missing file — in the same message as the fix', () => {
    const n = stopGatheringNudge(2, [])
    expect(n).toContain('genuinely still missing')
    expect(n).toContain('same message as your fix')
    expect(n).not.toContain('You already have')
  })
})
