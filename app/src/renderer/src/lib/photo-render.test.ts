import { describe, it, expect } from 'vitest'
import { applyAdjustToPixels, buildToneLut, toneCurvePoints, adjustTouchesPixels } from './photo-render'
import { PHOTO_NEUTRAL_ADJUST } from './editor-preview'
import type { PhotoAdjust } from '@shared/types'

function adj(patch: Partial<PhotoAdjust>): PhotoAdjust {
  return { ...PHOTO_NEUTRAL_ADJUST, ...patch }
}
/** A solid WxH image of one RGB colour, alpha 255. */
function solid(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r
    d[i * 4 + 1] = g
    d[i * 4 + 2] = b
    d[i * 4 + 3] = 255
  }
  return d
}

describe('buildToneLut', () => {
  it('is identity for a neutral adjust', () => {
    const lut = buildToneLut(PHOTO_NEUTRAL_ADJUST)
    expect(lut[0]).toBe(0)
    expect(lut[128]).toBe(128)
    expect(lut[255]).toBe(255)
  })
  it('exposure brightens mid-grey, negative darkens', () => {
    expect(buildToneLut(adj({ exposure: 100 }))[128]).toBeGreaterThan(128)
    expect(buildToneLut(adj({ exposure: -100 }))[128]).toBeLessThan(128)
  })
  it('contrast pushes darks down and lights up around mid-grey', () => {
    const lut = buildToneLut(adj({ contrast: 100 }))
    expect(lut[64]).toBeLessThan(64)
    expect(lut[192]).toBeGreaterThan(192)
    expect(lut[128]).toBe(128)
  })
})

describe('toneCurvePoints', () => {
  it('is null when the four tonal sliders are neutral', () => {
    expect(toneCurvePoints(PHOTO_NEUTRAL_ADJUST)).toBeNull()
  })
  it('lifts the floor when blacks are positive (faded look)', () => {
    const pts = toneCurvePoints(adj({ blacks: 100 }))!
    expect(pts[0].x).toBe(0)
    expect(pts[0].y).toBeGreaterThan(0)
  })
})

describe('applyAdjustToPixels', () => {
  it('leaves pixels unchanged for a neutral adjust', () => {
    const d = solid(2, 2, 100, 120, 140)
    const before = Uint8ClampedArray.from(d)
    applyAdjustToPixels(d, 2, 2, PHOTO_NEUTRAL_ADJUST)
    expect(Array.from(d)).toEqual(Array.from(before))
  })
  it('exposure +100 brightens', () => {
    const d = solid(2, 2, 100, 100, 100)
    applyAdjustToPixels(d, 2, 2, adj({ exposure: 100 }))
    expect(d[0]).toBeGreaterThan(100)
  })
  it('saturation -100 desaturates toward grey (r≈g≈b)', () => {
    const d = solid(1, 1, 200, 50, 50)
    applyAdjustToPixels(d, 1, 1, adj({ saturation: -100 }))
    expect(Math.abs(d[0] - d[1])).toBeLessThanOrEqual(2)
    expect(Math.abs(d[1] - d[2])).toBeLessThanOrEqual(2)
  })
  it('warm temp raises red and lowers blue', () => {
    const d = solid(1, 1, 120, 120, 120)
    applyAdjustToPixels(d, 1, 1, adj({ temp: 100 }))
    expect(d[0]).toBeGreaterThan(120) // red up
    expect(d[2]).toBeLessThan(120) // blue down
  })
  it('positive vignette darkens a corner more than the centre', () => {
    const w = 5
    const h = 5
    const d = solid(w, h, 200, 200, 200)
    applyAdjustToPixels(d, w, h, adj({ vignette: 100 }))
    const centre = d[(2 * w + 2) * 4] // (2,2)
    const corner = d[0] // (0,0)
    expect(corner).toBeLessThan(centre)
  })
})

describe('adjustTouchesPixels', () => {
  it('is false for neutral, true when any tonal/colour field moves', () => {
    expect(adjustTouchesPixels(PHOTO_NEUTRAL_ADJUST)).toBe(false)
    expect(adjustTouchesPixels(adj({ exposure: 5 }))).toBe(true)
    expect(adjustTouchesPixels(adj({ vignette: -10 }))).toBe(true)
  })
})
