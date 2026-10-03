import { describe, it, expect } from 'vitest'
import type { EditorScript, PhotoAdjust, EditorClip, EditorTextClip } from '@shared/types'
import {
  cssFilterFor,
  vignetteOpacity,
  buildCurveLut,
  evalPhotoScriptAt,
  evalVideoScriptAt,
  videoGradeFilter,
  PHOTO_NEUTRAL_ADJUST
} from './editor-preview'

/** A neutral adjust with the given overrides — keeps each case to the field under test. */
function adj(over: Partial<PhotoAdjust>): PhotoAdjust {
  return { ...PHOTO_NEUTRAL_ADJUST, ...over }
}

describe('cssFilterFor', () => {
  it('returns none for a neutral adjust', () => {
    expect(cssFilterFor(PHOTO_NEUTRAL_ADJUST)).toBe('none')
  })

  it('raises brightness for positive exposure', () => {
    const f = cssFilterFor(adj({ exposure: 50 }))
    const m = f.match(/brightness\(([\d.]+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(1)
  })

  it('lowers contrast for negative contrast', () => {
    const f = cssFilterFor(adj({ contrast: -40 }))
    const m = f.match(/contrast\(([\d.]+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThan(1)
  })

  it('folds vibrance into saturate alongside saturation', () => {
    expect(cssFilterFor(adj({ saturation: 20, vibrance: 40 }))).toMatch(/saturate\(/)
  })

  it('warms with sepia for positive temp and cools with a hue rotation for negative temp', () => {
    expect(cssFilterFor(adj({ temp: 60 }))).toMatch(/sepia\(/)
    const cool = cssFilterFor(adj({ temp: -60 }))
    expect(cool).toMatch(/hue-rotate\(-?[\d.]+deg\)/)
  })

  it('does not emit a vignette primitive (that rides a separate overlay)', () => {
    expect(cssFilterFor(adj({ vignette: 80 }))).toBe('none')
  })
})

describe('vignetteOpacity', () => {
  it('is 0 when neutral', () => {
    expect(vignetteOpacity(PHOTO_NEUTRAL_ADJUST)).toBe(0)
  })
  it('scales with magnitude and caps at 0.6', () => {
    expect(vignetteOpacity(adj({ vignette: 100 }))).toBeCloseTo(0.6, 5)
    expect(vignetteOpacity(adj({ vignette: 50 }))).toBeCloseTo(0.3, 5)
  })
  it('uses magnitude, so a lightening (negative) vignette is also positive opacity', () => {
    expect(vignetteOpacity(adj({ vignette: -50 }))).toBeCloseTo(0.3, 5)
  })
})

describe('buildCurveLut', () => {
  it('is the identity ramp for no points', () => {
    const lut = buildCurveLut([])
    expect(lut).toHaveLength(256)
    expect(lut[0]).toBe(0)
    expect(lut[128]).toBe(128)
    expect(lut[255]).toBe(255)
  })

  it('interpolates linearly between points and is monotonic', () => {
    const lut = buildCurveLut([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 }
    ])
    expect(lut[0]).toBe(0)
    expect(lut[255]).toBe(255)
    expect(lut[128]).toBeGreaterThan(128) // lifted midtones
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1])
  })

  it('holds flat outside the first/last point', () => {
    const lut = buildCurveLut([
      { x: 0.25, y: 0.4 },
      { x: 0.75, y: 0.6 }
    ])
    expect(lut[0]).toBe(Math.round(0.4 * 255))
    expect(lut[255]).toBe(Math.round(0.6 * 255))
  })
})

/** A compact photo choreography touching a Basic slider, a curve, and a crop/rotate. */
function sampleScript(): EditorScript {
  return {
    kind: 'photo',
    totalMs: 400,
    target: adj({ exposure: 50, rotate: 90, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }),
    steps: [
      { type: 'panel-switch', panel: 'basic', atMs: 0 },
      { type: 'cursor-move', control: 'exposure', atMs: 0, durationMs: 100 },
      { type: 'set-slider', control: 'exposure', from: 0, to: 50, atMs: 100, durationMs: 100 },
      { type: 'panel-switch', panel: 'curve', atMs: 200 },
      {
        type: 'draw-curve',
        channel: 'rgb',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ],
        atMs: 200,
        durationMs: 100
      },
      { type: 'panel-switch', panel: 'crop', atMs: 300 },
      { type: 'set-slider', control: 'rotate', from: 0, to: 90, atMs: 300, durationMs: 100 },
      { type: 'render', atMs: 400 }
    ]
  }
}

describe('evalPhotoScriptAt', () => {
  it('starts neutral with the cursor aimed at the first control', () => {
    const pb = evalPhotoScriptAt(sampleScript(), 0)
    expect(pb.adjust.exposure).toBe(0)
    expect(pb.activePanel).toBe('basic')
    expect(pb.cursorControl).toBe('exposure')
    expect(pb.cursorProgress).toBeCloseTo(0, 5)
  })

  it('shows a slider mid-sweep as active and partway to its target', () => {
    const pb = evalPhotoScriptAt(sampleScript(), 150)
    expect(pb.adjust.exposure).toBeGreaterThan(0)
    expect(pb.adjust.exposure).toBeLessThan(50)
    expect(pb.activeControl).toBe('exposure')
  })

  it('reveals the curve while drawing it', () => {
    const pb = evalPhotoScriptAt(sampleScript(), 250)
    expect(pb.activePanel).toBe('curve')
    expect(pb.curveDraw?.channel).toBe('rgb')
    expect(pb.curveDraw!.progress).toBeGreaterThan(0)
    expect(pb.curveDraw!.progress).toBeLessThan(1)
    expect(pb.adjust.curve?.rgb).toHaveLength(2)
  })

  it('settles on the full target at the end, with crop applied and nothing mid-animation', () => {
    const pb = evalPhotoScriptAt(sampleScript(), 400)
    expect(pb.adjust.exposure).toBeCloseTo(50, 5)
    expect(pb.adjust.rotate).toBeCloseTo(90, 5)
    expect(pb.adjust.crop).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
    expect(pb.activePanel).toBe('crop')
    expect(pb.curveDraw).toBeNull()
    expect(pb.activeControl).toBeNull()
  })

  it('is deterministic', () => {
    expect(evalPhotoScriptAt(sampleScript(), 150)).toEqual(evalPhotoScriptAt(sampleScript(), 150))
  })
})

/** A compact video choreography: 2 clips + a transition, a grade sweep, a caption, a playhead sweep. */
function videoSampleScript(): EditorScript {
  const clip0: EditorClip = { id: 'clip-0', track: 'video', startSec: 0, endSec: 4, sourceStartSec: 0, sourceEndSec: 4, grade: 'cinematic' }
  const clip1: EditorClip = { id: 'clip-1', track: 'video', startSec: 4, endSec: 12, sourceStartSec: 4, sourceEndSec: 12, grade: 'cinematic' }
  const cap: EditorTextClip = { id: 'text-0', track: 'text', startSec: 0, endSec: 3, text: 'Summer', x: 0.5, y: 0.85 }
  return {
    kind: 'video',
    totalMs: 1500,
    timeline: {
      durationSec: 12,
      tracks: [
        { kind: 'video', clips: [clip0, clip1] },
        { kind: 'text', clips: [cap] },
        { kind: 'audio', clips: [{ id: 'audio-0', track: 'audio', startSec: 0, endSec: 12, volume: 100, muted: false }] }
      ]
    },
    steps: [
      { type: 'panel-switch', panel: 'timeline', atMs: 0 },
      { type: 'cursor-move', control: 'clip-0', atMs: 0, durationMs: 100 },
      { type: 'add-clip', clip: clip0, atMs: 100 },
      { type: 'transition', name: 'fade', atSec: 4, atMs: 150 },
      { type: 'cursor-move', control: 'clip-1', atMs: 200, durationMs: 100 },
      { type: 'add-clip', clip: clip1, atMs: 300 },
      { type: 'panel-switch', panel: 'effects', atMs: 400 },
      { type: 'cursor-move', control: 'grade', atMs: 400, durationMs: 100 },
      { type: 'set-slider', control: 'grade', from: 0, to: 100, atMs: 500, durationMs: 200 },
      { type: 'panel-switch', panel: 'text', atMs: 700 },
      { type: 'cursor-move', control: 'text-0', atMs: 700, durationMs: 100 },
      { type: 'add-text', clip: cap, atMs: 800 },
      { type: 'panel-switch', panel: 'timeline', atMs: 900 },
      { type: 'cursor-move', control: 'playhead', atMs: 900, durationMs: 100 },
      { type: 'playhead', from: 0, to: 12, atMs: 1000, durationMs: 500 },
      { type: 'render', atMs: 1500 }
    ]
  }
}
describe('evalVideoScriptAt', () => {
  it('starts on the timeline with the cursor at the first clip, nothing placed yet', () => {
    const vp = evalVideoScriptAt(videoSampleScript(), 0)
    expect(vp.activePanel).toBe('timeline')
    expect(vp.cursorControl).toBe('clip-0')
    expect(vp.clipsPlaced).toBe(0)
    expect(vp.grade).toBe(0)
    expect(vp.playheadSec).toBe(0)
    expect(vp.gradeName).toBe('cinematic')
  })

  it('lays clips down progressively and records the transition boundary', () => {
    const vp = evalVideoScriptAt(videoSampleScript(), 350)
    expect(vp.clipsPlaced).toBe(2)
    expect(vp.cursorControl).toBe('clip-1')
    expect(vp.boundaries).toHaveLength(1)
    expect(vp.boundaries[0]).toEqual({ atSec: 4, kind: 'transition', name: 'fade' })
  })

  it('sweeps the grade mid-animation on the effects panel', () => {
    const vp = evalVideoScriptAt(videoSampleScript(), 600)
    expect(vp.activePanel).toBe('effects')
    expect(vp.grade).toBeGreaterThan(0)
    expect(vp.grade).toBeLessThan(100)
    expect(vp.activeControl).toBe('grade')
  })

  it('places the caption once its add-text step fires', () => {
    const vp = evalVideoScriptAt(videoSampleScript(), 850)
    expect(vp.activePanel).toBe('text')
    expect(vp.textsPlaced).toContain('text-0')
  })

  it('settles fully at the end: clips, caption, full grade, playhead at the duration, nothing active', () => {
    const vp = evalVideoScriptAt(videoSampleScript(), 1500)
    expect(vp.clipsPlaced).toBe(2)
    expect(vp.textsPlaced).toEqual(['text-0'])
    expect(vp.grade).toBeCloseTo(100, 5)
    expect(vp.playheadSec).toBeCloseTo(12, 5)
    expect(vp.activeControl).toBeNull()
  })

  it('is deterministic', () => {
    expect(evalVideoScriptAt(videoSampleScript(), 600)).toEqual(evalVideoScriptAt(videoSampleScript(), 600))
  })
})
describe('videoGradeFilter', () => {
  it('is none with no grade name or zero intensity', () => {
    expect(videoGradeFilter(null, 80)).toBe('none')
    expect(videoGradeFilter('cinematic', 0)).toBe('none')
  })

  it('desaturates a black-and-white grade', () => {
    expect(videoGradeFilter('bw', 80)).toMatch(/grayscale\(/)
    expect(videoGradeFilter('noir mono', 100)).toMatch(/grayscale\(/)
  })

  it('warms a cinematic/warm grade with sepia', () => {
    expect(videoGradeFilter('cinematic', 100)).toMatch(/sepia\(/)
    expect(videoGradeFilter('warm sunset', 100)).toMatch(/sepia\(/)
  })

  it('cools a cool/blue grade with a negative hue rotation', () => {
    expect(videoGradeFilter('cool blue', 100)).toMatch(/hue-rotate\(-[\d.]+deg\)/)
  })

  it('pumps saturation for a vivid grade', () => {
    expect(videoGradeFilter('vivid', 100)).toMatch(/saturate\(1\.5\)/)
  })

  it('falls back to a gentle contrast + saturation lift for an unknown grade', () => {
    const f = videoGradeFilter('moody', 100)
    expect(f).toMatch(/contrast\(/)
    expect(f).toMatch(/saturate\(/)
  })

  it('scales with intensity', () => {
    const half = videoGradeFilter('bw', 50)
    const full = videoGradeFilter('bw', 100)
    expect(half).toMatch(/grayscale\(0\.5\)/)
    expect(full).toMatch(/grayscale\(1\)/)
  })
})
