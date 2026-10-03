import { describe, it, expect } from 'vitest'
import { photoScript, videoScript, BASIC_CONTROLS } from './editor-script-core'
import { PHOTO_NEUTRAL } from './photo-core'
import type { EditPlan } from './ffmpeg-core'
import type { PhotoAdjust, EditorStep, EditorClip, EditorTextClip, EditorAudioClip } from '../../shared/types'

function adj(over: Partial<PhotoAdjust> = {}): PhotoAdjust {
  return { ...PHOTO_NEUTRAL, ...over }
}

/** Pull every step of one type for terse assertions. */
function ofType<T extends EditorStep['type']>(steps: EditorStep[], type: T): Extract<EditorStep, { type: T }>[] {
  return steps.filter((s): s is Extract<EditorStep, { type: T }> => s.type === type)
}

describe('photoScript', () => {
  it('a neutral adjust still produces exactly one render step', () => {
    const script = photoScript(PHOTO_NEUTRAL)
    expect(script.kind).toBe('photo')
    expect(ofType(script.steps, 'set-slider')).toHaveLength(0)
    const render = ofType(script.steps, 'render')
    expect(render).toHaveLength(1)
    expect(script.totalMs).toBe(render[0].atMs)
    expect(script.target).toEqual(PHOTO_NEUTRAL)
  })

  it('emits cursor-move + set-slider per non-neutral basic control, from a 0 baseline', () => {
    const script = photoScript(adj({ exposure: 40, contrast: -20 }))
    const sliders = ofType(script.steps, 'set-slider')
    expect(sliders.map((s) => s.control)).toEqual(['exposure', 'contrast'])
    expect(sliders.every((s) => s.from === 0)).toBe(true)
    expect(sliders[0].to).toBe(40)
    expect(sliders[1].to).toBe(-20)
    // one cursor-move precedes each slide
    expect(ofType(script.steps, 'cursor-move')).toHaveLength(2)
  })

  it('visits basic controls in panel order regardless of input key order', () => {
    const script = photoScript(adj({ saturation: 10, exposure: 10, temp: 10 }))
    const order = ofType(script.steps, 'set-slider').map((s) => s.control)
    expect(order).toEqual(['exposure', 'temp', 'saturation'])
    // and that order is the canonical BASIC_CONTROLS order
    const idx = order.map((c) => BASIC_CONTROLS.indexOf(c as keyof PhotoAdjust))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('switches panels only when the panel actually changes', () => {
    const script = photoScript(adj({ exposure: 10, contrast: 10 }))
    const panels = ofType(script.steps, 'panel-switch')
    expect(panels).toHaveLength(1)
    expect(panels[0].panel).toBe('basic')
  })

  it('steps are monotonically non-decreasing on the clock and end at totalMs', () => {
    const script = photoScript(adj({ exposure: 50, vibrance: 30, vignette: 20 }))
    let last = -1
    for (const s of script.steps) {
      expect(s.atMs).toBeGreaterThanOrEqual(last)
      last = s.atMs
    }
    const render = ofType(script.steps, 'render')[0]
    expect(render.atMs).toBe(script.totalMs)
  })

  it('draws each present curve channel after switching to the curve panel', () => {
    const script = photoScript(
      adj({ curve: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }], g: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] } })
    )
    const draws = ofType(script.steps, 'draw-curve')
    expect(draws.map((d) => d.channel)).toEqual(['rgb', 'g'])
    expect(ofType(script.steps, 'panel-switch').some((p) => p.panel === 'curve')).toBe(true)
  })

  it('turns each non-zero HSL field with one cursor-move per band', () => {
    const script = photoScript(
      adj({ hsl: { red: { hue: 20, sat: 10, lum: 0 }, blue: { hue: 0, sat: 0, lum: -15 } } })
    )
    const hsl = ofType(script.steps, 'set-hsl')
    expect(hsl.map((h) => `${h.band}.${h.field}`)).toEqual(['red.hue', 'red.sat', 'blue.lum'])
    // one cursor-move for red, one for blue
    const moves = ofType(script.steps, 'cursor-move').filter((m) => m.control.startsWith('hsl-'))
    expect(moves.map((m) => m.control)).toEqual(['hsl-red', 'hsl-blue'])
  })

  it('handles crop + rotate on the crop panel with a rotate slider', () => {
    const script = photoScript(adj({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, rotate: 90 }))
    expect(ofType(script.steps, 'panel-switch').some((p) => p.panel === 'crop')).toBe(true)
    const rotate = ofType(script.steps, 'set-slider').find((s) => s.control === 'rotate')
    expect(rotate?.to).toBe(90)
  })

  it('is deterministic — identical input yields identical scripts', () => {
    const a = photoScript(adj({ exposure: 25, temp: -10, clarity: 40 }))
    const b = photoScript(adj({ exposure: 25, temp: -10, clarity: 40 }))
    expect(a).toEqual(b)
  })
})

/** Pull the clips of one track kind out of a built timeline, narrowed to that clip type. */
function trackClips(script: ReturnType<typeof videoScript>, kind: 'video'): EditorClip[]
function trackClips(script: ReturnType<typeof videoScript>, kind: 'text'): EditorTextClip[]
function trackClips(script: ReturnType<typeof videoScript>, kind: 'audio'): EditorAudioClip[]
function trackClips(
  script: ReturnType<typeof videoScript>,
  kind: 'video' | 'text' | 'audio'
): Array<EditorClip | EditorTextClip | EditorAudioClip> {
  return script.timeline?.tracks.find((t) => t.kind === kind)?.clips ?? []
}

describe('videoScript', () => {
  it('derives a video clip per keep-range and lays them on the timeline in order', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [{ op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] }]
    }
    const script = videoScript(plan, 20)
    expect(script.kind).toBe('video')

    // Two clips, laid end-to-end on the output timeline (4s then 6s = 10s total).
    const clips = trackClips(script, 'video')
    expect(clips).toHaveLength(2)
    expect(clips[0]).toMatchObject({ id: 'clip-0', startSec: 0, endSec: 4, sourceStartSec: 0, sourceEndSec: 4 })
    expect(clips[1]).toMatchObject({ id: 'clip-1', startSec: 4, endSec: 10, sourceStartSec: 10, sourceEndSec: 16 })
    expect(script.timeline?.durationSec).toBe(10)

    // One add-clip per range, each preceded by a cursor-move onto that clip.
    const adds = ofType(script.steps, 'add-clip')
    expect(adds.map((a) => a.clip.id)).toEqual(['clip-0', 'clip-1'])
    const clipMoves = ofType(script.steps, 'cursor-move').filter((m) => m.control.startsWith('clip-'))
    expect(clipMoves.map((m) => m.control)).toEqual(['clip-0', 'clip-1'])
  })

  it('marks each inter-clip boundary as a plain split when no transition is requested', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [{ op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] }]
    }
    const script = videoScript(plan, 20)
    const splits = ofType(script.steps, 'split')
    expect(splits).toHaveLength(1)
    expect(splits[0]).toMatchObject({ track: 'video', atSec: 4 })
    expect(ofType(script.steps, 'transition')).toHaveLength(0)
  })

  it('marks each inter-clip boundary as a transition when a transition op is present', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [
        { op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] },
        { op: 'transition', name: 'fade', durationSec: 1 }
      ]
    }
    const script = videoScript(plan, 20)
    const trans = ofType(script.steps, 'transition')
    expect(trans).toHaveLength(1)
    expect(trans[0]).toMatchObject({ name: 'fade', atSec: 4 })
    expect(ofType(script.steps, 'split')).toHaveLength(0)
  })

  it('speeds up a clip: output duration shrinks and the clip carries its speed', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [
        { op: 'trim', start: 0, end: 10 },
        { op: 'speed', factor: 2 }
      ]
    }
    const script = videoScript(plan, 20)
    const clips = trackClips(script, 'video')
    expect(clips).toHaveLength(1)
    expect(clips[0].endSec).toBe(5) // 10s source at 2x = 5s out
    expect(clips[0].speed).toBe(2)
    expect(script.timeline?.durationSec).toBe(5)
  })

  it('places text ops onto the text track and emits an add-text per caption', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [
        { op: 'trim', start: 0, end: 10 },
        { op: 'text', text: 'Summer', start: 0, end: 3, x: 'center', y: 'bottom' }
      ]
    }
    const script = videoScript(plan, 20)
    const texts = trackClips(script, 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ id: 'text-0', text: 'Summer', startSec: 0, endSec: 3, x: 0.5, y: 0.85 })

    const adds = ofType(script.steps, 'add-text')
    expect(adds.map((a) => a.clip.text)).toEqual(['Summer'])
    // captions are placed on the dedicated text panel
    expect(ofType(script.steps, 'panel-switch').some((p) => p.panel === 'text')).toBe(true)
  })

  it('derives a grade gesture and stamps the grade onto every clip', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [
        { op: 'trim', start: 0, end: 10 },
        { op: 'filter', name: 'cinematic' }
      ]
    }
    const script = videoScript(plan, 20)
    expect(trackClips(script, 'video').every((c) => c.grade === 'cinematic')).toBe(true)
    const grade = ofType(script.steps, 'set-slider').find((s) => s.control === 'grade')
    expect(grade).toMatchObject({ from: 0, to: 100 })
    expect(ofType(script.steps, 'panel-switch').some((p) => p.panel === 'effects')).toBe(true)
  })

  it('builds one audio block carrying volume percent, and flags mute', () => {
    const loud: EditPlan = {
      input: 'raw.mp4',
      operations: [{ op: 'trim', start: 0, end: 8 }, { op: 'volume', factor: 0.8 }]
    }
    const audio = trackClips(videoScript(loud, 20), 'audio')
    expect(audio).toHaveLength(1)
    expect(audio[0]).toMatchObject({ id: 'audio-0', startSec: 0, endSec: 8, volume: 80 })

    const muted: EditPlan = {
      input: 'raw.mp4',
      operations: [{ op: 'trim', start: 0, end: 8 }, { op: 'mute' }]
    }
    expect(trackClips(videoScript(muted, 20), 'audio')[0]).toMatchObject({ muted: true })
  })

  it('falls back to the probe duration when no segments/trim bound the clip', () => {
    const plan: EditPlan = { input: 'raw.mp4', operations: [{ op: 'filter', name: 'warm' }] }
    const clips = trackClips(videoScript(plan, 8), 'video')
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ startSec: 0, endSec: 8 })
  })

  it('sweeps the playhead end-to-end and finishes with exactly one render at totalMs', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [{ op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] }]
    }
    const script = videoScript(plan, 20)
    const sweep = ofType(script.steps, 'playhead')
    expect(sweep).toHaveLength(1)
    expect(sweep[0]).toMatchObject({ from: 0, to: 10 })
    const render = ofType(script.steps, 'render')
    expect(render).toHaveLength(1)
    expect(render[0].atMs).toBe(script.totalMs)
  })

  it('steps are monotonically non-decreasing on the clock', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [
        { op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] },
        { op: 'transition', name: 'fade', durationSec: 1 },
        { op: 'filter', name: 'cinematic' },
        { op: 'text', text: 'Hi', start: 1, end: 2 }
      ]
    }
    const script = videoScript(plan, 20)
    let last = -1
    for (const s of script.steps) {
      expect(s.atMs).toBeGreaterThanOrEqual(last)
      last = s.atMs
    }
  })

  it('is deterministic — identical plan yields identical scripts', () => {
    const plan: EditPlan = {
      input: 'raw.mp4',
      operations: [
        { op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] },
        { op: 'transition', name: 'fade', durationSec: 1 },
        { op: 'text', text: 'Summer', start: 0, end: 3, x: 'center', y: 'bottom' }
      ]
    }
    expect(videoScript(plan, 20)).toEqual(videoScript(plan, 20))
  })
})
