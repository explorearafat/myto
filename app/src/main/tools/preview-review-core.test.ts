import { describe, it, expect } from 'vitest'
import {
  MAX_VISUAL_REVIEWS,
  PREVIEW_ENTRY_CANDIDATES,
  pickReviewTarget,
  visualReviewInstruction
} from './preview-review-core'
import type { PreviewTarget } from '../../shared/types'

/**
 * Pure build-complete visual-review logic: which preview gets screenshot-reviewed, and the
 * instruction that rides back with the picture. The Electron capture + finish-gate wiring are
 * exercised only by the (gated) e2e harness.
 */

describe('MAX_VISUAL_REVIEWS', () => {
  it('is exactly one — the review is a decisive, one-shot pass, never a loop', () => {
    expect(MAX_VISUAL_REVIEWS).toBe(1)
  })
})

describe('pickReviewTarget', () => {
  const url = (u: string): PreviewTarget => ({ kind: 'url', url: u, title: u })

  it('prefers what the model already previewed', () => {
    const last = url('http://localhost:5173/')
    expect(
      pickReviewTarget({
        lastPreview: last,
        runningServerUrl: 'http://localhost:3000/',
        existingEntry: { rel: 'index.html', url: 'file:///w/index.html' }
      })
    ).toBe(last)
  })

  it('falls back to a running dev server when nothing was previewed', () => {
    expect(
      pickReviewTarget({
        lastPreview: null,
        runningServerUrl: 'http://localhost:3000/',
        existingEntry: { rel: 'index.html', url: 'file:///w/index.html' }
      })
    ).toEqual({ kind: 'url', url: 'http://localhost:3000/', title: 'http://localhost:3000/' })
  })

  it('falls back to a built HTML entry when there is no preview and no server', () => {
    expect(
      pickReviewTarget({
        lastPreview: null,
        runningServerUrl: null,
        existingEntry: { rel: 'dist/index.html', url: 'file:///w/dist/index.html' }
      })
    ).toEqual({ kind: 'file', url: 'file:///w/dist/index.html', title: 'dist/index.html' })
  })

  it('ignores a blank running-server URL', () => {
    expect(
      pickReviewTarget({ lastPreview: null, runningServerUrl: '   ', existingEntry: null })
    ).toBeNull()
  })

  it('returns null for a non-web deliverable (nothing to look at)', () => {
    expect(
      pickReviewTarget({ lastPreview: null, runningServerUrl: null, existingEntry: null })
    ).toBeNull()
  })
})

describe('PREVIEW_ENTRY_CANDIDATES', () => {
  it('checks the working-folder root before the build-output dirs', () => {
    expect(PREVIEW_ENTRY_CANDIDATES[0]).toBe('index.html')
    expect(PREVIEW_ENTRY_CANDIDATES).toContain('dist/index.html')
    expect(PREVIEW_ENTRY_CANDIDATES).toContain('build/index.html')
  })
})

describe('visualReviewInstruction', () => {
  const note = visualReviewInstruction('GOAL: build a dashboard.\n\n', 'index.html')

  it('keeps the original goal in view', () => {
    expect(note).toContain('GOAL: build a dashboard.')
  })
  it('tells the model the attachment is the real rendered screenshot', () => {
    expect(note).toMatch(/screenshot/i)
    expect(note).toMatch(/ground truth/i)
    expect(note).toContain('index.html')
  })
  it('names concrete visual faults to hunt for', () => {
    expect(note).toMatch(/overlap|misaligned|contrast|blank page|error overlay/i)
  })
  it('gives a clear fix-or-stop exit so the run terminates', () => {
    expect(note).toMatch(/edit_file|write_file/)
    expect(note).toMatch(/stop/i)
    expect(note).toMatch(/verif/i)
  })
})
