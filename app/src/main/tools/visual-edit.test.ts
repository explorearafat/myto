import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editPhotoTool, editVideoTool, visualEditTools } from './visual-edit'
import type { ToolContext, ToolGate } from './registry'
import type { EditorEvent } from '../../shared/types'

/**
 * Tool-level tests for `edit_photo`: the availability gate, sandbox/type refusals, the
 * degrade-to-note path when the FFmpeg runtime is absent, and the happy path with a FAKED
 * runtime (no ffmpeg binary spawned) asserting the open→script→progress→baked event order.
 * Pure adjust→filter + adjust→choreography logic is covered in photo-core/editor-script-core.
 */

const PROBE_JSON = JSON.stringify({
  format: { duration: '0', size: '2048', format_name: 'image2' },
  streams: [{ index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 1600, height: 1200 }]
})

function gate(dir: string | null): ToolGate {
  return { settings: { tools: { enabled: true } }, mode: 'cowork', workspaceDir: dir } as unknown as ToolGate
}

/** A fake ToolContext: a happy runtime (exit 0, no file written) + event/media sinks captured. */
function makeCtx(dir: string | null, over: Partial<ToolContext> = {}): ToolContext {
  const base: Partial<ToolContext> = {
    ...gate(dir),
    signal: new AbortController().signal,
    onStatus: () => {},
    emitMedia: () => {},
    onEditorEvent: () => {},
    runFfmpeg: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
    probeMedia: async () => PROBE_JSON
  }
  return { ...base, ...over } as unknown as ToolContext
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'myto-visual-'))
  await writeFile(join(dir, 'photo.jpg'), 'not-real-jpeg-bytes')
  await writeFile(join(dir, 'clip.mp4'), 'not-real-video-bytes')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('availability gate', () => {
  it('advertises edit_photo, gated by a Build folder', () => {
    expect(visualEditTools.map((t) => t.name)).toContain('edit_photo')
    expect(editPhotoTool.available(gate(dir))).toBe(true)
    expect(editPhotoTool.available(gate(null))).toBe(false)
  })
})

describe('refusals', () => {
  it('refuses a missing path argument', async () => {
    expect(await editPhotoTool.run({ adjust: { exposure: 10 } }, makeCtx(dir))).toMatch(/needs a "path"/)
  })
  it('refuses an input outside the working folder', async () => {
    const out = await editPhotoTool.run({ path: '../secret.jpg', adjust: { exposure: 10 } }, makeCtx(dir))
    expect(out).toMatch(/outside the working folder/)
  })
  it('refuses a non-image (points at edit_video)', async () => {
    const out = await editPhotoTool.run({ path: 'clip.mp4', adjust: { exposure: 10 } }, makeCtx(dir))
    expect(out).toMatch(/only edits images/)
    expect(out).toMatch(/edit_video/)
  })
  it('refuses a non-object adjust', async () => {
    const out = await editPhotoTool.run({ path: 'photo.jpg', adjust: 'bright' }, makeCtx(dir))
    expect(out).toMatch(/JSON object/)
  })
  it('refuses an output that would overwrite the input', async () => {
    const out = await editPhotoTool.run({ path: 'photo.jpg', adjust: { exposure: 10 }, output: 'photo.jpg' }, makeCtx(dir))
    expect(out).toMatch(/never overwrites the source/)
  })
})

describe('runtime absent → a plain note, never a throw', () => {
  it('degrades when runFfmpeg is missing', async () => {
    const ctx = makeCtx(dir, { runFfmpeg: undefined })
    const out = await editPhotoTool.run({ path: 'photo.jpg', adjust: { exposure: 10 } }, ctx)
    expect(out).toMatch(/bundled FFmpeg runtime/)
  })
})

describe('happy path with a faked runtime', () => {
  it('emits open → script → progress → baked in order and reports the output', async () => {
    const events: EditorEvent[] = []
    const ctx = makeCtx(dir, { onEditorEvent: (e) => events.push(e) })
    const out = await editPhotoTool.run(
      { path: 'photo.jpg', adjust: { exposure: 25, contrast: 15, temp: 20 } },
      ctx
    )
    const phases = events.map((e) => e.phase)
    expect(phases[0]).toBe('open')
    expect(phases[1]).toBe('script')
    expect(phases).toContain('progress')
    expect(phases[phases.length - 1]).toBe('baked')
    expect(out).toMatch(/^Edited/)
    expect(out).toContain('myto-edits/')
    expect(out).toMatch(/before\/after/)
  })

  it('the open event carries the title + probed dimensions, the script a photo choreography', async () => {
    const events: EditorEvent[] = []
    const ctx = makeCtx(dir, { onEditorEvent: (e) => events.push(e) })
    await editPhotoTool.run({ path: 'photo.jpg', adjust: { exposure: 25 } }, ctx)
    const open = events.find((e) => e.phase === 'open')
    expect(open).toBeDefined()
    if (open && open.phase === 'open') {
      expect(open.kind).toBe('photo')
      expect(open.title).toBe('photo.jpg')
      expect(open.width).toBe(1600)
      expect(open.height).toBe(1200)
    }
    const script = events.find((e) => e.phase === 'script')
    if (script && script.phase === 'script') {
      expect(script.script.kind).toBe('photo')
      expect(script.script.steps.some((s) => s.type === 'set-slider' && s.control === 'exposure')).toBe(true)
    }
  })

  it('bakes and returns the summary even without an editor-event sink', async () => {
    const ctx = makeCtx(dir, { onEditorEvent: undefined })
    const out = await editPhotoTool.run({ path: 'photo.jpg', adjust: { vibrance: 30 } }, ctx)
    expect(out).toMatch(/^Edited/)
  })

  it('surfaces a bake failure as an error event + a failed result', async () => {
    const events: EditorEvent[] = []
    const ctx = makeCtx(dir, {
      onEditorEvent: (e) => events.push(e),
      runFfmpeg: async () => ({ exitCode: 1, stderr: 'Invalid data found', stdout: '' })
    })
    const out = await editPhotoTool.run({ path: 'photo.jpg', adjust: { exposure: 10 } }, ctx)
    expect(out).toMatch(/edit_photo failed/)
    expect(events.some((e) => e.phase === 'error')).toBe(true)
  })
})

// ── edit_video ────────────────────────────────────────────────────────────────

const VIDEO_PROBE_JSON = JSON.stringify({
  format: { duration: '20', size: '4096', format_name: 'mov,mp4' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ]
})
/** A ctx whose probe reports a real 20s video (edit_video derives its timeline from this). */
function videoCtx(d: string | null, over: Partial<ToolContext> = {}): ToolContext {
  return makeCtx(d, { probeMedia: async () => VIDEO_PROBE_JSON, ...over })
}

describe('edit_video — gate + refusals', () => {
  it('advertises edit_video, gated by a Build folder', () => {
    expect(visualEditTools.map((t) => t.name)).toContain('edit_video')
    expect(editVideoTool.available(gate(dir))).toBe(true)
    expect(editVideoTool.available(gate(null))).toBe(false)
  })
  it('refuses an empty operations list', async () => {
    const out = await editVideoTool.run({ input: 'clip.mp4', operations: [] }, videoCtx(dir))
    expect(out).toMatch(/edit_video:/)
    expect(out).toMatch(/non-empty/)
  })
  it('refuses an input outside the working folder', async () => {
    const out = await editVideoTool.run({ input: '../secret.mp4', operations: [{ op: 'mute' }] }, videoCtx(dir))
    expect(out).toMatch(/outside the working folder/)
  })
  it('refuses a non-video (points at edit_photo)', async () => {
    const out = await editVideoTool.run({ input: 'photo.jpg', operations: [{ op: 'mute' }] }, videoCtx(dir))
    expect(out).toMatch(/only edits video/)
    expect(out).toMatch(/edit_photo/)
  })
  it('refuses an output that would overwrite the input', async () => {
    const out = await editVideoTool.run(
      { input: 'clip.mp4', operations: [{ op: 'mute' }], output: 'clip.mp4' },
      videoCtx(dir)
    )
    expect(out).toMatch(/never overwrites the source/)
  })
  it('degrades to a plain note when the FFmpeg runtime is absent', async () => {
    const out = await editVideoTool.run({ input: 'clip.mp4', operations: [{ op: 'mute' }] }, videoCtx(dir, { runFfmpeg: undefined }))
    expect(out).toMatch(/bundled FFmpeg runtime/)
  })
})

describe('edit_video — happy path with a faked runtime', () => {
  it('emits open → script → progress → baked in order and reports the output', async () => {
    const events: EditorEvent[] = []
    const ctx = videoCtx(dir, { onEditorEvent: (e) => events.push(e) })
    const out = await editVideoTool.run(
      { input: 'clip.mp4', operations: [{ op: 'trim', start: 0, end: 15 }, { op: 'filter', name: 'cinematic' }] },
      ctx
    )
    const phases = events.map((e) => e.phase)
    expect(phases[0]).toBe('open')
    expect(phases[1]).toBe('script')
    expect(phases).toContain('progress')
    expect(phases[phases.length - 1]).toBe('baked')
    expect(out).toMatch(/^Edited/)
    expect(out).toContain('myto-edits/')
  })

  it('the open event is a video with the probed duration; the script carries a timeline', async () => {
    const events: EditorEvent[] = []
    const ctx = videoCtx(dir, { onEditorEvent: (e) => events.push(e) })
    await editVideoTool.run(
      { input: 'clip.mp4', operations: [{ op: 'segments', keep: [{ start: 0, end: 4 }, { start: 10, end: 16 }] }, { op: 'transition', name: 'fade', durationSec: 1 }] },
      ctx
    )
    const open = events.find((e) => e.phase === 'open')
    if (open && open.phase === 'open') {
      expect(open.kind).toBe('video')
      expect(open.title).toBe('clip.mp4')
      expect(open.durationSec).toBe(20)
    }
    const script = events.find((e) => e.phase === 'script')
    if (script && script.phase === 'script') {
      expect(script.script.kind).toBe('video')
      expect(script.script.timeline?.tracks.find((t) => t.kind === 'video')?.clips).toHaveLength(2)
      expect(script.script.steps.some((s) => s.type === 'transition')).toBe(true)
    }
  })

  it('the baked event carries the workspace path + a file:// url for the Preview pane', async () => {
    const events: EditorEvent[] = []
    const ctx = videoCtx(dir, { onEditorEvent: (e) => events.push(e) })
    await editVideoTool.run({ input: 'clip.mp4', operations: [{ op: 'mute' }] }, ctx)
    const baked = events.find((e) => e.phase === 'baked')
    expect(baked).toBeDefined()
    if (baked && baked.phase === 'baked') {
      expect(baked.kind).toBe('video')
      expect(baked.outputPath).toMatch(/myto-edits\/.*\.mp4$/)
      expect(baked.url).toMatch(/^file:\/\//)
    }
  })

  it('bakes and returns the summary even without an editor-event sink', async () => {
    const ctx = videoCtx(dir, { onEditorEvent: undefined })
    const out = await editVideoTool.run({ input: 'clip.mp4', operations: [{ op: 'speed', factor: 1.5 }] }, ctx)
    expect(out).toMatch(/^Edited/)
  })

  it('surfaces a bake failure as an error event + a failed result', async () => {
    const events: EditorEvent[] = []
    const ctx = videoCtx(dir, {
      onEditorEvent: (e) => events.push(e),
      runFfmpeg: async () => ({ exitCode: 1, stderr: 'Conversion failed', stdout: '' })
    })
    const out = await editVideoTool.run({ input: 'clip.mp4', operations: [{ op: 'mute' }] }, ctx)
    expect(out).toMatch(/edit_video failed/)
    expect(events.some((e) => e.phase === 'error')).toBe(true)
  })
})
