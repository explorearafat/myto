import { describe, it, expect } from 'vitest'
import {
  parseTimecode, secondsToSrtTime, clampVolume, parseProbe, aspectFilter, isAspectRatio, isFitMode,
  deriveOutputRel, escapeFilterPath, extOf,
  buildProbeArgs, buildTrimArgs, buildConcatListContent, buildConcatArgs,
  buildFramesIntervalArgs, buildFrameAtArgs, buildSilenceArgs, buildSubtitleBurnArgs,
  buildMixAudioArgs, buildResizeCropArgs,
  parseSilenceRanges, silenceToKeepRanges, parseProgress,
  segmentsToSrt, parseTranscriptJson, atempoChain,
  validateEditPlan, compileEditPlan, buildEditPlanArgs,
  FILTER_PRESETS, escapeDrawtext, drawtextFilter
} from './ffmpeg-core'

/**
 * Pure-core tests for the FFmpeg tools: argument vectors are asserted exactly (that is the
 * safety contract — no shell string ever forms), and edit-plan validation/compilation is
 * exercised across the happy path and every rejection. No ffmpeg binary is spawned here.
 */

describe('time + number parsing', () => {
  it('parses seconds, clock forms, and rejects junk', () => {
    expect(parseTimecode(12.5)).toBe(12.5)
    expect(parseTimecode('90')).toBe(90)
    expect(parseTimecode('01:30')).toBe(90)
    expect(parseTimecode('01:02:03.5')).toBe(3723.5)
    expect(parseTimecode('-5')).toBeNull()
    expect(parseTimecode('nope')).toBeNull()
    expect(parseTimecode({})).toBeNull()
  })
  it('formats SRT timestamps', () => {
    expect(secondsToSrtTime(0)).toBe('00:00:00,000')
    expect(secondsToSrtTime(3723.5)).toBe('01:02:03,500')
  })
  it('clamps volume into [0,4]', () => {
    expect(clampVolume(1)).toBe(1)
    expect(clampVolume(9)).toBe(4)
    expect(clampVolume(-1)).toBe(1)
    expect(clampVolume('2')).toBe(2)
    expect(clampVolume(undefined, 0.5)).toBe(0.5)
  })
})

describe('parseProbe', () => {
  it('normalises ffprobe JSON into MediaInfo with video/audio convenience', () => {
    const json = JSON.stringify({
      format: { duration: '12.5', size: '1048576', bit_rate: '800000', format_name: 'mov,mp4' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30000/1001' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
      ]
    })
    const info = parseProbe(json)
    expect(info.durationSec).toBe(12.5)
    expect(info.sizeBytes).toBe(1048576)
    expect(info.video?.width).toBe(1920)
    expect(info.video?.fps).toBeCloseTo(29.97, 2)
    expect(info.audio?.channels).toBe(2)
  })
  it('throws readable error on bad JSON', () => {
    expect(() => parseProbe('not json')).toThrow(/valid JSON/)
  })
})

// CORE_TEST_MARKER

describe('aspect + output path helpers', () => {
  it('builds crop/pad/stretch filters for a 9:16 reel', () => {
    expect(aspectFilter('9:16', 'crop')).toBe('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
    expect(aspectFilter('9:16', 'pad')).toContain('pad=1080:1920')
    expect(aspectFilter('1:1', 'stretch')).toBe('scale=1080:1080')
  })
  it('guards aspect/mode and reads extensions', () => {
    expect(isAspectRatio('9:16')).toBe(true)
    expect(isAspectRatio('5:7')).toBe(false)
    expect(isFitMode('crop')).toBe(true)
    expect(isFitMode('warp')).toBe(false)
    expect(extOf('a/b/clip.MP4')).toBe('mp4')
  })
  it('derives a project-scoped output that is never the input', () => {
    expect(deriveOutputRel('sub/clip.mov', 'reel', 'abc')).toBe('myto-edits/clip-reel-abc.mov')
    expect(deriveOutputRel('clip.mov', 'trim', 'x', 'mp4')).toBe('myto-edits/clip-trim-x.mp4')
  })
  it('escapes filter paths for Windows + colons + quotes', () => {
    expect(escapeFilterPath('C:\\a\\s.srt')).toBe('C\\:/a/s.srt')
  })
})

describe('argument builders produce exact vectors (no shell strings)', () => {
  it('probe', () => {
    expect(buildProbeArgs('in.mp4')).toEqual(
      ['-hide_banner', '-loglevel', 'error', '-print_format', 'json', '-show_format', '-show_streams', 'in.mp4']
    )
  })
  it('trim copies by default and re-encodes on request', () => {
    const copy = buildTrimArgs('in.mp4', 'out.mp4', 2, 5)
    expect(copy).toContain('-ss'); expect(copy).toContain('copy')
    expect(copy[copy.indexOf('-t') + 1]).toBe('3')
    expect(copy[copy.length - 1]).toBe('out.mp4')
    expect(buildTrimArgs('in.mp4', 'out.mp4', 2, 5, true)).toContain('libx264')
  })
  it('concat list content quotes paths; concat args use the demuxer', () => {
    expect(buildConcatListContent(['/a/one.mp4', '/a/two.mp4'])).toBe("file '/a/one.mp4'\nfile '/a/two.mp4'\n")
    expect(buildConcatArgs('list.txt', 'out.mp4')).toContain('concat')
    expect(buildConcatArgs('list.txt', 'out.mp4', true)).toContain('libx264')
  })
  it('frame extraction (interval + single)', () => {
    expect(buildFramesIntervalArgs('in.mp4', 'f-%03d.jpg', 2, 10)).toContain('fps=1/2')
    expect(buildFrameAtArgs('in.mp4', 'f.jpg', 7)[buildFrameAtArgs('in.mp4', 'f.jpg', 7).indexOf('-ss') + 1]).toBe('7')
  })
  it('silence detect, subtitle burn, resize, mix', () => {
    expect(buildSilenceArgs('in.mp4', -30, 0.5)).toContain('silencedetect=noise=-30dB:d=0.5')
    expect(buildSubtitleBurnArgs('in.mp4', 'out.mp4', '/s/c.srt').join(' ')).toContain("subtitles='/s/c.srt'")
    expect(buildResizeCropArgs('in.mp4', 'out.mp4', '9:16', 'crop')).toContain('-vf')
    expect(buildMixAudioArgs('v.mp4', 'a.mp3', 'o.mp4', 'replace', 1)).toContain('-shortest')
    expect(buildMixAudioArgs('v.mp4', 'a.mp3', 'o.mp4', 'duck', 0.5).join(' ')).toContain('sidechaincompress')
    expect(buildMixAudioArgs('v.mp4', 'a.mp3', 'o.mp4', 'mix', 0.3).join(' ')).toContain('amix=inputs=2')
  })
})

describe('output parsers', () => {
  it('parses silencedetect ranges and inverts them to keep-ranges', () => {
    const log = 'silence_start: 2.0\nsilence_end: 3.5 | silence_duration: 1.5\nsilence_start: 8.0\nsilence_end: 9.0'
    const ranges = parseSilenceRanges(log)
    expect(ranges).toEqual([{ start: 2, end: 3.5 }, { start: 8, end: 9 }])
    const keeps = silenceToKeepRanges(ranges, 12)
    expect(keeps).toEqual([{ start: 0, end: 2 }, { start: 3.5, end: 8 }, { start: 9, end: 12 }])
  })
  it('parses -progress ticks into percent', () => {
    const p = parseProgress('out_time=00:00:30.00\nspeed=2.0x\nprogress=continue', 60)
    expect(p?.outTimeSec).toBe(30)
    expect(p?.percent).toBe(50)
    expect(p?.speed).toBe('2.0x')
    expect(parseProgress('progress=end', 60)?.done).toBe(true)
    expect(parseProgress('garbage')).toBeNull()
  })
})

describe('transcription + srt', () => {
  it('renders segments to SRT', () => {
    const srt = segmentsToSrt([{ start: 0, end: 1.5, text: 'Hi' }, { start: 1.5, end: 3, text: 'there' }])
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nHi')
    expect(srt).toContain('2\n00:00:01,500 --> 00:00:03,000\nthere')
  })
  it('normalises OpenAI-style and whisper.cpp JSON', () => {
    expect(parseTranscriptJson(JSON.stringify({ segments: [{ start: 1, end: 2, text: ' a ' }] }))).toEqual([{ start: 1, end: 2, text: 'a' }])
    const cpp = JSON.stringify({ transcription: [{ offsets: { from: 1000, to: 2500 }, text: 'b' }] })
    expect(parseTranscriptJson(cpp)).toEqual([{ start: 1, end: 2.5, text: 'b' }])
  })
  it('chains atempo past the per-filter 2x limit', () => {
    expect(atempoChain(2)).toBe('atempo=2')
    expect(atempoChain(4)).toBe('atempo=2.0,atempo=2')
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5')
  })
})

// EDITPLAN_TEST_MARKER

describe('edit-plan validation', () => {
  it('accepts a full reel plan', () => {
    const res = validateEditPlan({
      input: 'raw.mp4',
      output: 'reel.mp4',
      operations: [
        { op: 'segments', keep: [{ start: 0, end: 2 }, { start: '00:05', end: '00:08' }] },
        { op: 'resize', aspect: '9:16' },
        { op: 'subtitles', segments: [{ start: 0, end: 1, text: 'hi' }] },
        { op: 'volume', factor: 0.8 }
      ]
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      // "00:05"/"00:08" are MM:SS → 5s/8s (clock parsing)
      expect(res.plan.operations[0]).toEqual({ op: 'segments', keep: [{ start: 0, end: 2 }, { start: 5, end: 8 }] })
      // resize defaults mode to 'crop'
      expect(res.plan.operations[1]).toEqual({ op: 'resize', aspect: '9:16', mode: 'crop' })
    }
  })
  it('rejects missing input, empty operations, and bad ops', () => {
    expect(validateEditPlan(null)).toMatchObject({ ok: false })
    expect(validateEditPlan({ operations: [] })).toMatchObject({ ok: false, error: /input/ })
    expect(validateEditPlan({ input: 'a.mp4', operations: [] })).toMatchObject({ ok: false, error: /non-empty/ })
    expect(validateEditPlan({ input: 'a.mp4', operations: [{ op: 'trim', start: 5, end: 2 }] })).toMatchObject({ ok: false, error: /trim/ })
    expect(validateEditPlan({ input: 'a.mp4', operations: [{ op: 'resize', aspect: '5:7' }] })).toMatchObject({ ok: false, error: /aspect/ })
    expect(validateEditPlan({ input: 'a.mp4', operations: [{ op: 'subtitles' }] })).toMatchObject({ ok: false, error: /subtitles/ })
    expect(validateEditPlan({ input: 'a.mp4', operations: [{ op: 'wat' }] })).toMatchObject({ ok: false, error: /unknown/ })
  })
})

describe('edit-plan compilation', () => {
  it('compiles keep-ranges → concat → resize → subtitles → volume into one graph', () => {
    const res = validateEditPlan({
      input: 'raw.mp4',
      operations: [
        { op: 'segments', keep: [{ start: 0, end: 2 }, { start: 5, end: 8 }] },
        { op: 'resize', aspect: '9:16', mode: 'crop' },
        { op: 'subtitles', srt: 'x' },
        { op: 'volume', factor: 0.5 }
      ]
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const g = compileEditPlan(res.plan, '/subs/c.srt')
    expect(g.filterComplex).toContain('concat=n=2:v=1:a=1[vc][ac]')
    expect(g.filterComplex).toContain('crop=1080:1920')
    expect(g.filterComplex).toContain("subtitles='/subs/c.srt'")
    expect(g.filterComplex).toContain('volume=0.5')
    expect(g.audio).not.toBeNull()
  })
  it('mute drops the audio map (-an) and omits the aac codec', () => {
    const res = validateEditPlan({ input: 'a.mp4', operations: [{ op: 'mute' }] })
    if (!res.ok) throw new Error('expected ok')
    const args = buildEditPlanArgs('/in/a.mp4', '/out/a.mp4', res.plan)
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(args[args.length - 1]).toBe('/out/a.mp4')
  })
  it('a filterless plan still maps input pads and re-encodes', () => {
    const res = validateEditPlan({ input: 'a.mp4', operations: [{ op: 'speed', factor: 1.5 }] })
    if (!res.ok) throw new Error('expected ok')
    const args = buildEditPlanArgs('/in/a.mp4', '/out/a.mp4', res.plan)
    expect(args).toContain('-filter_complex')
    expect(args.join(' ')).toContain('setpts=PTS/1.5')
    expect(args).toContain('libx264')
  })
})

describe('color grade + look presets', () => {
  it('validates and compiles a colorGrade into eq + colorbalance', () => {
    const res = validateEditPlan({
      input: 'a.mp4',
      operations: [{ op: 'colorGrade', contrast: 1.2, saturation: 1.1, temperature: 60, tint: -20 }]
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const g = compileEditPlan(res.plan)
    expect(g.filterComplex).toContain('eq=contrast=1.2:saturation=1.1')
    expect(g.filterComplex).toContain('colorbalance=')
    // warm temperature → red up, blue down
    expect(g.filterComplex).toMatch(/rm=0\.18/)
    expect(g.filterComplex).toMatch(/bm=-0\.18/)
  })

  it('clamps colorGrade fields into range and rejects an all-empty grade', () => {
    const res = validateEditPlan({ input: 'a.mp4', operations: [{ op: 'colorGrade', contrast: 99 }] })
    if (!res.ok) throw new Error('expected ok')
    const op = res.plan.operations[0]
    expect(op.op === 'colorGrade' && op.contrast).toBe(3)
    expect(validateEditPlan({ input: 'a.mp4', operations: [{ op: 'colorGrade' }] })).toMatchObject({
      ok: false,
      error: /colorGrade/
    })
  })

  it('compiles a known filter preset and rejects an unknown one', () => {
    const res = validateEditPlan({ input: 'a.mp4', operations: [{ op: 'filter', name: 'cinematic' }] })
    if (!res.ok) throw new Error('expected ok')
    const g = compileEditPlan(res.plan)
    expect(g.filterComplex).toContain(FILTER_PRESETS.cinematic)
    expect(validateEditPlan({ input: 'a.mp4', operations: [{ op: 'filter', name: 'nope' }] })).toMatchObject({
      ok: false,
      error: /filter/
    })
  })

  it('the "none" preset is the identity (no filter emitted)', () => {
    const res = validateEditPlan({ input: 'a.mp4', operations: [{ op: 'filter', name: 'none' }] })
    if (!res.ok) throw new Error('expected ok')
    expect(compileEditPlan(res.plan).filterComplex).toBe('')
  })
})

describe('text overlays (drawtext)', () => {
  it('emits drawtext only when a font path is supplied', () => {
    const res = validateEditPlan({
      input: 'a.mp4',
      operations: [{ op: 'text', text: 'Summer', start: 0, end: 3, y: 'bottom', box: true }]
    })
    if (!res.ok) throw new Error('expected ok')
    expect(compileEditPlan(res.plan).filterComplex).not.toContain('drawtext')
    const g = compileEditPlan(res.plan, undefined, '/fonts/Inter.ttf')
    expect(g.filterComplex).toContain('drawtext=')
    expect(g.filterComplex).toContain("fontfile='/fonts/Inter.ttf'")
    expect(g.filterComplex).toContain("text='Summer'")
    expect(g.filterComplex).toContain("enable='between(t,0,3)'")
    expect(g.filterComplex).toContain('box=1')
  })

  it('escapes drawtext metacharacters so the text cannot break the filter', () => {
    expect(escapeDrawtext("a: 50% done's")).toBe("a\\: 50\\% done’s")
  })

  it('drawtextFilter anchors keyword positions', () => {
    const f = drawtextFilter({ op: 'text', text: 'Hi', x: 'right', y: 'top' }, '/f.ttf')
    expect(f).toContain('x=w-tw-40')
    expect(f).toContain('y=40')
  })
})

describe('transition (xfade)', () => {
  it('turns ≥2 keep-ranges into an xfade/acrossfade chain instead of concat', () => {
    const res = validateEditPlan({
      input: 'a.mp4',
      operations: [
        { op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] },
        { op: 'transition', name: 'fade', durationSec: 1 }
      ]
    })
    if (!res.ok) throw new Error('expected ok')
    const g = compileEditPlan(res.plan)
    expect(g.filterComplex).toContain('xfade=transition=fade:duration=1:offset=3')
    expect(g.filterComplex).toContain('acrossfade=d=1')
    expect(g.filterComplex).not.toContain('concat=n=')
    expect(g.audio).toBe('at1')
  })

  it('rejects an unknown transition name', () => {
    expect(
      validateEditPlan({ input: 'a.mp4', operations: [{ op: 'transition', name: 'warp' }] })
    ).toMatchObject({ ok: false, error: /transition/ })
  })

  it('a single keep-range ignores the transition and falls back to a plain cut', () => {
    const res = validateEditPlan({
      input: 'a.mp4',
      operations: [
        { op: 'trim', start: 0, end: 5 },
        { op: 'transition', name: 'fade', durationSec: 1 }
      ]
    })
    if (!res.ok) throw new Error('expected ok')
    const g = compileEditPlan(res.plan)
    expect(g.filterComplex).not.toContain('xfade')
  })
})


