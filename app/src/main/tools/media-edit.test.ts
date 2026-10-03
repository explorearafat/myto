import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeVideoTool, trimClipTool, transcribeAudioTool, detectSilenceTool,
  addSubtitlesTool, resizeOrCropTool, applyEditPlanTool, runFfmpegTool, mediaEditTools
} from './media-edit'
import type { ToolContext, ToolGate } from './registry'

/**
 * Tool-level tests for the video/photo editing tools: the sandbox refusals (an input
 * outside the folder, an output that would overwrite the input, run_ffmpeg args that are
 * absolute or climb out), the degrade-to-note path when the FFmpeg runtime callback is
 * absent (every tool stays safe in a non-Electron context), and the happy-path result
 * strings with a FAKED runtime (no ffmpeg binary is ever spawned). Pure arg/plan logic is
 * covered separately in ffmpeg-core.test.ts.
 */

/** A probe JSON the fake ctx.probeMedia hands back (12 s, 1080p h264 + stereo aac). */
const PROBE_JSON = JSON.stringify({
  format: { duration: '12', size: '1048576', bit_rate: '800000', format_name: 'mov,mp4' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ]
})

/** A minimal ToolGate in Cowork mode rooted at `dir` (null = no folder → tools gate off). */
function gate(dir: string | null): ToolGate {
  return { settings: { tools: { enabled: true } }, mode: 'cowork', workspaceDir: dir } as unknown as ToolGate
}

/**
 * A fake {@link ToolContext}: a happy FFmpeg runtime (never spawns — resolves exit 0 with no
 * output) plus status/media sinks. `over` replaces any field, e.g. `{ runFfmpeg: undefined }`
 * to exercise the runtime-absent note, or a scripted runFfmpeg to feed silence/failure output.
 */
function makeCtx(dir: string | null, over: Partial<ToolContext> = {}): ToolContext {
  const base: Partial<ToolContext> = {
    ...gate(dir),
    signal: new AbortController().signal,
    onStatus: () => {},
    emitMedia: () => {},
    emitToolImages: () => {},
    runFfmpeg: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
    probeMedia: async () => PROBE_JSON,
    transcribeAudio: async () => JSON.stringify({ segments: [{ start: 0, end: 1, text: 'hi' }] })
  }
  return { ...base, ...over } as unknown as ToolContext
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'myto-media-'))
  // A real input file so resolveInWorkspaceReal (symlink-safe, fail-closed) resolves it.
  await writeFile(join(dir, 'clip.mp4'), 'not-real-video-bytes')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('availability gate', () => {
  it('advertises 11 tools, all gated by a Cowork folder', () => {
    expect(mediaEditTools).toHaveLength(11)
    for (const t of mediaEditTools) {
      expect(t.available(gate(dir))).toBe(true)
      expect(t.available(gate(null))).toBe(false)
    }
  })
})

describe('sandbox refusals', () => {
  it('refuses an input outside the working folder', async () => {
    const out = await trimClipTool.run({ path: '../secret.mp4', start: 0, end: 5 }, makeCtx(dir))
    expect(out).toMatch(/outside the working folder/)
  })
  it('refuses an output that would overwrite the input', async () => {
    const out = await trimClipTool.run(
      { path: 'clip.mp4', start: '00:00', end: '00:05', output: 'clip.mp4' },
      makeCtx(dir)
    )
    expect(out).toMatch(/never overwrites the source/)
  })
  it('run_ffmpeg rejects absolute paths, climbs, non-strings, and overflow', async () => {
    const ctx = makeCtx(dir)
    expect(await runFfmpegTool.run({ args: ['-i', '/abs/x.mp4'] }, ctx)).toMatch(/absolute path|climbs out/)
    expect(await runFfmpegTool.run({ args: ['-i', '../up.mp4'] }, ctx)).toMatch(/absolute|climbs out/)
    expect(await runFfmpegTool.run({ args: ['-i', 5] }, ctx)).toMatch(/array of strings/)
    expect(await runFfmpegTool.run({ args: [] }, ctx)).toMatch(/between 1 and 100/)
  })
})

describe('runtime absent → a plain note, never a throw', () => {
  const bare = (): ToolContext =>
    makeCtx(dir, { runFfmpeg: undefined, probeMedia: undefined, transcribeAudio: undefined })
  it('probe_video, trim_clip, transcribe_audio, run_ffmpeg all degrade', async () => {
    expect(await probeVideoTool.run({ path: 'clip.mp4' }, bare())).toMatch(/bundled FFmpeg runtime/)
    expect(await trimClipTool.run({ path: 'clip.mp4', start: 0, end: 5 }, bare())).toMatch(/bundled FFmpeg runtime/)
    expect(await transcribeAudioTool.run({ path: 'clip.mp4' }, bare())).toMatch(/bundled FFmpeg runtime/)
    expect(await runFfmpegTool.run({ args: ['-i', 'clip.mp4', 'myto-edits/o.mp4'] }, bare())).toMatch(/bundled FFmpeg runtime/)
  })
})

describe('happy paths with a faked runtime', () => {
  it('probe_video describes streams', async () => {
    const out = await probeVideoTool.run({ path: 'clip.mp4' }, makeCtx(dir))
    expect(out).toContain('clip.mp4')
    expect(out).toContain('1920×1080')
  })
  it('trim_clip writes under myto-edits and reports the duration', async () => {
    const out = await trimClipTool.run({ path: 'clip.mp4', start: '00:02', end: '00:05' }, makeCtx(dir))
    expect(out).toMatch(/^Trimmed/)
    expect(out).toContain('myto-edits/')
  })
  it('detect_silence reports gaps and the keep-ranges to feed apply_edit_plan', async () => {
    const ctx = makeCtx(dir, {
      runFfmpeg: async () => ({ exitCode: 0, stderr: 'silence_start: 2.0\nsilence_end: 3.5\n', stdout: '' })
    })
    const out = await detectSilenceTool.run({ path: 'clip.mp4' }, ctx)
    expect(out).toContain('1 silent gap')
    expect(out).toContain('apply_edit_plan')
  })
  it('add_subtitles burns an SRT', async () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello'
    const out = await addSubtitlesTool.run({ path: 'clip.mp4', srt }, makeCtx(dir))
    expect(out).toMatch(/^Burned subtitles/)
  })
  it('resize_or_crop reframes to an aspect ratio', async () => {
    const out = await resizeOrCropTool.run({ path: 'clip.mp4', aspect_ratio: '9:16' }, makeCtx(dir))
    expect(out).toContain('Reframed to 9:16')
  })
  it('apply_edit_plan renders a multi-op plan in one pass', async () => {
    const out = await applyEditPlanTool.run(
      { input: 'clip.mp4', operations: [{ op: 'segments', keep: [{ start: 0, end: 5 }] }, { op: 'resize', aspect: '9:16' }] },
      makeCtx(dir)
    )
    expect(out).toContain('Rendered edit')
    expect(out).toContain('segments → resize')
  })
  it('run_ffmpeg (escape hatch) runs a relative-path arg vector', async () => {
    const out = await runFfmpegTool.run(
      { args: ['-i', 'clip.mp4', '-vf', 'hflip', 'myto-edits/flip.mp4'], output: 'myto-edits/flip.mp4' },
      makeCtx(dir)
    )
    expect(out).toMatch(/ffmpeg finished/)
  })
  it('surfaces a readable error tail when ffmpeg exits non-zero', async () => {
    const ctx = makeCtx(dir, {
      runFfmpeg: async () => ({ exitCode: 1, stderr: 'x\ny\nFatal: boom', stdout: '' })
    })
    const out = await trimClipTool.run({ path: 'clip.mp4', start: 0, end: 5 }, ctx)
    expect(out).toMatch(/trim_clip failed:/)
    expect(out).toContain('boom')
  })
})
