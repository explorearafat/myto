import { describe, it, expect } from 'vitest'
import {
  PHOTO_NEUTRAL,
  HSL_BANDS,
  clampAmount,
  clamp01,
  validatePhotoAdjust,
  curvePointsToString,
  toneCurvePoints,
  aggregateHsl,
  buildPhotoFilterChain,
  buildPhotoEditArgs
} from './photo-core'
import type { PhotoAdjust } from '../../shared/types'

/** A fresh neutral adjust clone we can spread partial overrides onto in each test. */
function adj(over: Partial<PhotoAdjust> = {}): PhotoAdjust {
  return { ...PHOTO_NEUTRAL, ...over }
}

describe('clampAmount / clamp01', () => {
  it('clamps to [-100,100] and coerces non-finite to 0', () => {
    expect(clampAmount(50)).toBe(50)
    expect(clampAmount(999)).toBe(100)
    expect(clampAmount(-999)).toBe(-100)
    expect(clampAmount('30')).toBe(30)
    expect(clampAmount('nope')).toBe(0)
    expect(clampAmount(NaN)).toBe(0)
    expect(clampAmount(undefined)).toBe(0)
  })
  it('clamp01 pins to the unit interval', () => {
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
  })
})

describe('validatePhotoAdjust', () => {
  it('rejects a non-object', () => {
    const r = validatePhotoAdjust('nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/JSON object/)
  })

  it('coerces + clamps all amount fields, defaulting missing ones to neutral', () => {
    const r = validatePhotoAdjust({ exposure: 200, contrast: -200, saturation: 15 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.adjust.exposure).toBe(100)
    expect(r.adjust.contrast).toBe(-100)
    expect(r.adjust.saturation).toBe(15)
    expect(r.adjust.vibrance).toBe(0) // untouched → neutral
  })

  it('keeps a crop only when it selects a real sub-region', () => {
    const full = validatePhotoAdjust({ crop: { x: 0, y: 0, w: 1, h: 1 } })
    expect(full.ok && full.adjust.crop).toBeUndefined()
    const sub = validatePhotoAdjust({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } })
    expect(sub.ok && sub.adjust.crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 })
  })

  it('normalizes rotate into [0,360)', () => {
    const r = validatePhotoAdjust({ rotate: -90 })
    expect(r.ok && r.adjust.rotate).toBe(270)
    const r2 = validatePhotoAdjust({ rotate: 450 })
    expect(r2.ok && r2.adjust.rotate).toBe(90)
  })

  it('validates and sorts curve points, dropping empty channels', () => {
    const r = validatePhotoAdjust({
      curve: { rgb: [{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.6 }], r: [] }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.adjust.curve?.rgb).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }])
    expect(r.adjust.curve?.r).toBeUndefined()
  })

  it('keeps only HSL bands with a non-zero adjustment', () => {
    const r = validatePhotoAdjust({
      hsl: { red: { hue: 10, sat: 0, lum: 0 }, blue: { hue: 0, sat: 0, lum: 0 } }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.adjust.hsl?.red).toEqual({ hue: 10, sat: 0, lum: 0 })
    expect(r.adjust.hsl?.blue).toBeUndefined()
  })
})

describe('curvePointsToString', () => {
  it('renders x/y pairs space-joined and rounds to 4dp', () => {
    expect(curvePointsToString([{ x: 0, y: 0 }, { x: 0.33333333, y: 0.5 }, { x: 1, y: 1 }])).toBe(
      '0/0 0.3333/0.5 1/1'
    )
  })
})

describe('toneCurvePoints', () => {
  it('returns null when the four tonal sliders are neutral', () => {
    expect(toneCurvePoints(adj())).toBeNull()
  })
  it('builds a strictly-increasing lifted-black curve', () => {
    const pts = toneCurvePoints(adj({ blacks: 100 }))
    expect(pts).not.toBeNull()
    if (!pts) return
    expect(pts[0]).toEqual({ x: 0, y: 0.12 }) // lifted floor
    for (let i = 1; i < pts.length; i++) expect(pts[i].x).toBeGreaterThan(pts[i - 1].x)
  })
  it('crushes blacks by moving the input black point right', () => {
    const pts = toneCurvePoints(adj({ blacks: -100 }))
    if (!pts) return
    expect(pts[0]).toEqual({ x: 0.12, y: 0 })
  })
})

describe('aggregateHsl', () => {
  it('averages hue (±30°) and saturation (×) across touched bands', () => {
    const { hueDeg, satMult } = aggregateHsl({
      red: { hue: 100, sat: 100, lum: 0 },
      blue: { hue: 0, sat: 0, lum: 0 }
    })
    expect(hueDeg).toBe(15) // avg hue 50 → 15°
    expect(satMult).toBe(1.5) // avg sat 50 → ×1.5
  })
  it('is neutral when no band is set', () => {
    expect(aggregateHsl({})).toEqual({ hueDeg: 0, satMult: 1 })
  })
})

describe('buildPhotoFilterChain', () => {
  it('is empty for a neutral adjust', () => {
    expect(buildPhotoFilterChain(PHOTO_NEUTRAL)).toBe('')
  })

  it('emits eq for exposure/contrast/saturation', () => {
    const chain = buildPhotoFilterChain(adj({ exposure: 50, contrast: 50, saturation: 100 }))
    expect(chain).toContain('eq=')
    expect(chain).toContain('brightness=0.2')
    expect(chain).toContain('contrast=1.25')
    expect(chain).toContain('saturation=2')
  })

  it('emits a master tone curve for the tonal sliders', () => {
    expect(buildPhotoFilterChain(adj({ highlights: 50 }))).toContain("curves=m='")
  })

  it('emits colorbalance for temp/tint and vibrance for vibrance', () => {
    const chain = buildPhotoFilterChain(adj({ temp: 100, tint: -100, vibrance: 50 }))
    expect(chain).toContain('colorbalance=rm=0.3')
    expect(chain).toContain('bm=-0.3')
    expect(chain).toContain('vibrance=intensity=0.5')
  })

  it('maps HSL to a global hue filter', () => {
    const chain = buildPhotoFilterChain(adj({ hsl: { green: { hue: 100, sat: 100, lum: 0 } } }))
    expect(chain).toContain('hue=h=30:s=2')
  })

  it('emits clarity + sharpen as separate unsharp passes', () => {
    const chain = buildPhotoFilterChain(adj({ clarity: 100, sharpen: 100 }))
    expect(chain).toContain('unsharp=lx=9:ly=9:la=0.8')
    expect(chain).toContain('unsharp=lx=5:ly=5:la=1.2')
  })

  it('darkens corners when vignette>0 and brightens (backward) when <0', () => {
    expect(buildPhotoFilterChain(adj({ vignette: 100 }))).toMatch(/vignette=angle=[\d.]+$/)
    expect(buildPhotoFilterChain(adj({ vignette: -100 }))).toContain('mode=backward')
  })

  it('applies geometry first: crop then transpose for 90°', () => {
    const chain = buildPhotoFilterChain(adj({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, rotate: 90 }))
    expect(chain.startsWith('crop=iw*0.5:ih*0.5:iw*0.1:ih*0.1,transpose=1')).toBe(true)
  })

  it('uses two transposes for 180° and a radian rotate for arbitrary angles', () => {
    expect(buildPhotoFilterChain(adj({ rotate: 180 }))).toContain('transpose=2,transpose=2')
    expect(buildPhotoFilterChain(adj({ rotate: 45 }))).toContain('rotate=')
  })
})

describe('buildPhotoEditArgs', () => {
  it('wraps the chain in a one-frame re-encode with -vf', () => {
    const args = buildPhotoEditArgs('/in.png', '/out.png', adj({ exposure: 50 }))
    expect(args).toContain('-i')
    expect(args[args.indexOf('-i') + 1]).toBe('/in.png')
    expect(args).toContain('-vf')
    expect(args).toContain('-frames:v')
    expect(args[args.length - 1]).toBe('/out.png')
  })

  it('omits -vf entirely for a neutral adjust', () => {
    const args = buildPhotoEditArgs('/in.png', '/out.png', PHOTO_NEUTRAL)
    expect(args).not.toContain('-vf')
  })

  it('adds -q:v for lossy jpg/webp outputs only', () => {
    expect(buildPhotoEditArgs('/in.jpg', '/out.jpg', adj({ exposure: 10 }))).toContain('-q:v')
    expect(buildPhotoEditArgs('/in.png', '/out.png', adj({ exposure: 10 }))).not.toContain('-q:v')
  })

  it('exposes all eight HSL bands in hue order', () => {
    expect(HSL_BANDS).toEqual(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'])
  })
})
