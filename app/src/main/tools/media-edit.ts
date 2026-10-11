/**
 * The video/photo editing TOOLS — the model-facing half that turns small typed fields
 * into FFmpeg runs. Pure argument/plan logic lives in ./ffmpeg-core.ts (unit-tested, no
 * Electron); the actual process spawning lives in ../ffmpeg-runtime.ts behind the ctx
 * callbacks wired in provider-ipc.ts. These tools only: resolve the model's paths through
 * the workspace sandbox, pick a safe UNIQUE output path under `myto-edits/` (never the
 * input), call the right core builder, run it via ctx.runFfmpeg, and hand back a CONCISE
 * structured result (never raw logs). The model never composes a shell string — it fills
 * fields, the core returns an arg ARRAY, the runtime spawns with no shell. Every tool is
 * gated by {@link fsAvailable}, so it is neither advertised nor runnable outside an agentic
 * mode with a chosen working folder. When a runtime callback is absent (unit tests), each
 * tool degrades to a plain "needs the app runtime" note instead of throwing.
 */
import { readFile, stat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { toErrorMessage } from '../providers/http'
import type { ToolDef, ToolContext } from './registry'
import type { ChatImage, ToolSideEffect } from '../../shared/types'
import { fsAvailable, resolveInWorkspace, resolveInWorkspaceReal } from './fs'
import {
  OUTPUT_DIR, parseProbe, parseTimecode, clampVolume, isAspectRatio, isFitMode,
  deriveOutputRel, extOf, segmentsToSrt, parseTranscriptJson,
  parseSilenceRanges, silenceToKeepRanges, validateEditPlan,
  buildTrimArgs, buildConcatListContent, buildConcatArgs,
  buildFramesIntervalArgs, buildFrameAtArgs, buildSilenceArgs,
  buildSubtitleBurnArgs, buildMixAudioArgs, buildResizeCropArgs, buildEditPlanArgs,
  type MediaInfo, type Segment, type FfmpegProgress
} from './ffmpeg-core'

/** Tools that spawn a process / touch the filesystem flag 'exec' so Cowork prompts for them. */
const EXEC: ToolSideEffect = 'exec'
/** Largest output re-shown inline as a preview (bytes); bigger files rely on "open folder". */
const INLINE_PREVIEW_CAP = 32 * 1024 * 1024
/** Default + hard cap on frames returned to the vision model, and their longest edge (px). */
const DEFAULT_FRAMES = 6
const MAX_FRAMES = 12
const FRAME_MAX_DIM = 1024

// ── Small input + formatting helpers ──────────────────────────────────────────

/** The call's input as a plain record (never an array/null), so field reads are safe. */
function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}
/** A trimmed non-empty string, or null. */
function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
/** A short unique token for output names (timestamp + a little entropy). */
function uniqToken(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}
function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}
function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(ss).padStart(2, '0')}`
}

const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v'
}
const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'
}
/** Map a file extension to a renderable media kind, or null for anything else (e.g. audio). */
function mediaKindFor(ext: string): { kind: 'video' | 'image'; mediaType: string } | null {
  const e = ext.toLowerCase()
  if (VIDEO_TYPES[e]) return { kind: 'video', mediaType: VIDEO_TYPES[e] }
  if (IMAGE_TYPES[e]) return { kind: 'image', mediaType: IMAGE_TYPES[e] }
  return null
}

// ── Sandbox path resolution ───────────────────────────────────────────────────

/** Resolve an existing input path through the sandbox (symlink-safe), or a refusal string. */
async function resolveInput(
  ctx: ToolContext, rel: string | null, tool: string
): Promise<{ abs: string; rel: string } | string> {
  if (!rel) return `${tool} needs a "path" relative to the working folder.`
  const abs = ctx.workspaceDir ? await resolveInWorkspaceReal(ctx.workspaceDir, rel) : null
  if (!abs) return `${tool}: "${rel}" is outside the working folder, or does not exist, and was refused.`
  return { abs, rel }
}

/** Pick a safe output path under the workspace (explicit relative path, else derived) and mkdir its parent. */
async function chooseOutput(
  ctx: ToolContext, inputRel: string, inputAbs: string, suffix: string, explicit: string | null, ext?: string
): Promise<{ abs: string; rel: string } | string> {
  const rel = explicit ?? deriveOutputRel(inputRel, suffix, uniqToken(), ext)
  const abs = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, rel) : null
  if (!abs) return `The output path "${rel}" is outside the working folder and was refused.`
  if (abs === inputAbs) return 'The output path must differ from the input — Myto never overwrites the source.'
  try { await mkdir(dirname(abs), { recursive: true }) } catch { /* a real failure surfaces on write */ }
  return { abs, rel }
}

/** The note a tool returns when it needs the app's FFmpeg runtime but it is absent (e.g. unit tests). */
function needsRuntime(tool: string): string {
  return `${tool} needs Myto's bundled FFmpeg runtime, which isn't available in this context.`
}

/** Write a short-lived temp file (an SRT or a concat list) that ffmpeg reads; the caller removes it. */
async function writeTemp(content: string, ext: string): Promise<string> {
  const p = join(tmpdir(), `myto-${uniqToken()}.${ext}`)
  await writeFile(p, content, 'utf8')
  return p
}

// ── Run / probe / verify / surface ────────────────────────────────────────────

/** Run an ffmpeg arg vector, streaming throttled percent to the status line; throws on failure. */
async function runEncode(
  ctx: ToolContext, args: string[], label: string, totalDurationSec?: number
): Promise<void> {
  if (!ctx.runFfmpeg) throw new Error('ffmpeg runtime unavailable')
  let last = 0
  const res = await ctx.runFfmpeg(args, {
    totalDurationSec,
    signal: ctx.signal,
    onProgress: (p: FfmpegProgress) => {
      const now = Date.now()
      if (!p.done && now - last < 400) return // throttle: at most ~2–3 status ticks/sec
      last = now
      const pct = p.percent != null ? ` ${p.percent}%` : ''
      const spd = p.speed ? ` (${p.speed})` : ''
      ctx.onStatus?.(p.done ? `${label} — done` : `${label}${pct}${spd}`)
    }
  })
  if (res.exitCode !== 0) {
    const tail = res.stderr.trim().split('\n').slice(-4).join(' ')
    throw new Error(tail || `ffmpeg exited with code ${res.exitCode}`)
  }
}

/** Probe a file into MediaInfo, or null when the probe is unavailable/failed (best-effort verify). */
async function tryProbe(ctx: ToolContext, abs: string): Promise<MediaInfo | null> {
  if (!ctx.probeMedia) return null
  try { return parseProbe(await ctx.probeMedia(abs, ctx.signal)) } catch { return null }
}

/** Surface a finished output file to the user inline (small renderable files only); best-effort. */
async function emitOutput(ctx: ToolContext, abs: string, rel: string, prompt: string): Promise<void> {
  if (!ctx.emitMedia) return
  const kind = mediaKindFor(extOf(abs))
  if (!kind) return
  try {
    const s = await stat(abs)
    if (s.size > INLINE_PREVIEW_CAP) return
    const bytes = await readFile(abs)
    // `localPath` rides along so the reply can offer an "Open folder" action;
    // the main process re-validates it against the working folder first.
    ctx.emitMedia([{ kind: kind.kind, mediaType: kind.mediaType, dataBase64: bytes.toString('base64'), prompt, localPath: rel }])
  } catch { /* preview is best-effort; the path is always in the result text */ }
}

/** A one-line "<rel> — dur, size, WxH" result, probing the output when possible, else just its size. */
async function describeOutput(ctx: ToolContext, rel: string, abs: string): Promise<string> {
  const info = await tryProbe(ctx, abs)
  if (info) {
    const dim = info.video ? `, ${info.video.width ?? '?'}×${info.video.height ?? '?'}` : ''
    return `${rel} — ${fmtDur(info.durationSec)}, ${fmtBytes(info.sizeBytes)}${dim}`
  }
  try { const s = await stat(abs); return `${rel} — ${fmtBytes(s.size)}` } catch { return rel }
}

/** A multi-line human description of a probed file for probe_video. */
function describeMedia(info: MediaInfo, rel: string): string {
  const kbps = info.bitRate ? `, ${Math.round(info.bitRate / 1000)} kbps` : ''
  const lines = [`${rel}: ${info.format}, ${fmtDur(info.durationSec)}, ${fmtBytes(info.sizeBytes)}${kbps}`]
  if (info.video) lines.push(`  video: ${info.video.width ?? '?'}×${info.video.height ?? '?'}, ${info.video.fps ?? '?'} fps, ${info.video.codec}`)
  if (info.audio) lines.push(`  audio: ${info.audio.codec}, ${info.audio.channels ?? '?'} ch, ${info.audio.sampleRate ?? '?'} Hz`)
  const extra = info.streams.length - (info.video ? 1 : 0) - (info.audio ? 1 : 0)
  if (extra > 0) lines.push(`  +${extra} more stream${extra === 1 ? '' : 's'}`)
  return lines.join('\n')
}

/** Build SRT text from an add_subtitles input: an "srt" string, else a "segments" array. */
function buildSrtFrom(o: Record<string, unknown>): string | null {
  const srt = readStr(o.srt)
  if (srt) return srt
  if (Array.isArray(o.segments) && o.segments.length) {
    const segs: Segment[] = o.segments
      .map((s): Segment => {
        const so = obj(s)
        return { start: Number(so.start ?? 0), end: Number(so.end ?? 0), text: String(so.text ?? '') }
      })
      .filter((s) => s.text.trim() && s.end > s.start)
    if (segs.length) return segmentsToSrt(segs)
  }
  return null
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export const probeVideoTool: ToolDef = {
  name: 'probe_video',
  description: 'Inspect a video/audio file: duration, size, format, and each video/audio stream. Run this first.',
  usage: '{"path": "clips/raw.mp4"}',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  available: fsAvailable,
  async run(input, ctx) {
    const r = await resolveInput(ctx, readStr(obj(input).path), 'probe_video')
    if (typeof r === 'string') return r
    if (!ctx.probeMedia) return needsRuntime('probe_video')
    ctx.onStatus?.(`Probing ${r.rel}`)
    try {
      return describeMedia(parseProbe(await ctx.probeMedia(r.abs, ctx.signal)), r.rel)
    } catch (err) {
      return `probe_video failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const trimClipTool: ToolDef = {
  name: 'trim_clip',
  description: 'Keep only [start, end) of a clip. Fast stream-copy by default; set "reencode": true for frame-accurate cuts.',
  usage: '{"path": "raw.mp4", "start": "00:05", "end": "00:12"}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, start: {}, end: {}, output: { type: 'string' }, reencode: { type: 'boolean' } },
    required: ['path', 'start', 'end']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const r = await resolveInput(ctx, readStr(o.path), 'trim_clip')
    if (typeof r === 'string') return r
    const start = parseTimecode(o.start)
    const end = parseTimecode(o.end)
    if (start == null || end == null || end <= start) {
      return 'trim_clip needs "start" and "end" (seconds or MM:SS) with end > start.'
    }
    if (!ctx.runFfmpeg) return needsRuntime('trim_clip')
    const out = await chooseOutput(ctx, r.rel, r.abs, 'trim', readStr(o.output))
    if (typeof out === 'string') return out
    try {
      await runEncode(ctx, buildTrimArgs(r.abs, out.abs, start, end, o.reencode === true), 'Trimming', end - start)
      await emitOutput(ctx, out.abs, out.rel, `trim ${r.rel}`)
      return `Trimmed ${fmtDur(end - start)} → ${await describeOutput(ctx, out.rel, out.abs)}`
    } catch (err) {
      return `trim_clip failed: ${toErrorMessage(err)}`
    }
  }
}

export const concatClipsTool: ToolDef = {
  name: 'concat_clips',
  description: 'Join clips end-to-end into one file, in order. Set "reencode": true when the inputs differ in codec/size/fps.',
  usage: '{"paths": ["a.mp4", "b.mp4"], "reencode": true}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' } }, output: { type: 'string' }, reencode: { type: 'boolean' } },
    required: ['paths']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const rawPaths = Array.isArray(o.paths) ? o.paths : []
    if (rawPaths.length < 2) return 'concat_clips needs a "paths" array of at least two clips, in play order.'
    const abs: string[] = []
    for (const p of rawPaths) {
      const rr = await resolveInput(ctx, readStr(p), 'concat_clips')
      if (typeof rr === 'string') return rr
      abs.push(rr.abs)
    }
    if (!ctx.runFfmpeg) return needsRuntime('concat_clips')
    const out = await chooseOutput(ctx, readStr(rawPaths[0]) ?? 'clip', '', 'concat', readStr(o.output))
    if (typeof out === 'string') return out
    let list = ''
    try {
      list = await writeTemp(buildConcatListContent(abs), 'txt')
      await runEncode(ctx, buildConcatArgs(list, out.abs, o.reencode === true), 'Joining clips')
      await emitOutput(ctx, out.abs, out.rel, `concat ${abs.length} clips`)
      return `Joined ${abs.length} clips → ${await describeOutput(ctx, out.rel, out.abs)}`
    } catch (err) {
      return `concat_clips failed: ${toErrorMessage(err)}`
    } finally {
      if (list) await rm(list, { force: true }).catch(() => {})
    }
  }
}

/** Read a produced JPEG frame into a vision ChatImage, or null if it couldn't be read. */
async function readFrame(abs: string): Promise<ChatImage | null> {
  try {
    const b = await readFile(abs)
    return { mediaType: 'image/jpeg', dataBase64: b.toString('base64') }
  } catch {
    return null
  }
}

export const extractFramesTool: ToolDef = {
  name: 'extract_frames',
  description: 'Grab still frames for YOU to see (vision): at a fixed "interval_seconds", or exact "timestamps". Capped in count + resolution.',
  usage: '{"path": "raw.mp4", "timestamps": ["00:01", "00:30"]}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' }, interval_seconds: { type: 'number' },
      timestamps: { type: 'array' }, max_frames: { type: 'number' }
    },
    required: ['path']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const r = await resolveInput(ctx, readStr(o.path), 'extract_frames')
    if (typeof r === 'string') return r
    if (!ctx.runFfmpeg || !ctx.workspaceDir) return needsRuntime('extract_frames')
    const cap = Math.max(1, Math.min(MAX_FRAMES, Math.floor(Number(o.max_frames)) || DEFAULT_FRAMES))
    const dirRel = `${OUTPUT_DIR}/frames-${uniqToken()}`
    const dirAbs = resolveInWorkspace(ctx.workspaceDir, dirRel)
    if (!dirAbs) return 'extract_frames: could not create an output folder in the working folder.'
    try {
      await mkdir(dirAbs, { recursive: true })
      const timestamps = Array.isArray(o.timestamps) ? o.timestamps : []
      if (timestamps.length) {
        const picks = timestamps.slice(0, cap)
        for (let i = 0; i < picks.length; i++) {
          const at = parseTimecode(picks[i])
          if (at == null) continue
          ctx.onStatus?.(`Grabbing frame ${i + 1}/${picks.length}`)
          const frameAbs = join(dirAbs, `frame-${String(i + 1).padStart(3, '0')}.jpg`)
          await runEncode(ctx, buildFrameAtArgs(r.abs, frameAbs, at, FRAME_MAX_DIM), `Frame ${i + 1}`)
        }
      } else {
        let interval = Number(o.interval_seconds)
        if (!(interval > 0)) {
          const info = await tryProbe(ctx, r.abs)
          interval = info && info.durationSec > 0 ? Math.max(1, Math.floor(info.durationSec / cap)) : 5
        }
        ctx.onStatus?.(`Sampling a frame every ${interval}s`)
        await runEncode(ctx, buildFramesIntervalArgs(r.abs, join(dirAbs, 'frame-%03d.jpg'), interval, cap, FRAME_MAX_DIM), 'Extracting frames')
      }
      const files = (await readdir(dirAbs).catch(() => [])).filter((f) => /\.jpg$/i.test(f)).sort().slice(0, cap)
      const images: ChatImage[] = []
      for (const f of files) {
        const im = await readFrame(join(dirAbs, f))
        if (im) images.push(im)
      }
      if (images.length) ctx.emitToolImages?.(images, `${r.rel} — ${images.length} frame(s)`)
      return images.length
        ? `Extracted ${images.length} frame(s) from ${r.rel} (shown above) → ${dirRel}/`
        : `Extracted frames to ${dirRel}/ (not previewable here).`
    } catch (err) {
      return `extract_frames failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const transcribeAudioTool: ToolDef = {
  name: 'transcribe_audio',
  description: 'Transcribe speech to timestamped captions (SRT). Needs a local whisper.cpp or a transcription API configured.',
  usage: '{"path": "raw.mp4"}',
  sideEffect: EXEC,
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  available: fsAvailable,
  async run(input, ctx) {
    const r = await resolveInput(ctx, readStr(obj(input).path), 'transcribe_audio')
    if (typeof r === 'string') return r
    if (!ctx.transcribeAudio) return needsRuntime('transcribe_audio')
    ctx.onStatus?.(`Transcribing ${r.rel}`)
    try {
      const segs = parseTranscriptJson(await ctx.transcribeAudio(r.abs, ctx.signal))
      if (!segs.length) return `No speech found in ${r.rel}.`
      const srt = segmentsToSrt(segs)
      const capped = srt.length > 8000 ? `${srt.slice(0, 8000)}\n…[truncated]` : srt
      const until = fmtDur(segs[segs.length - 1].end)
      return `Transcribed ${segs.length} caption line(s) (through ${until}). SRT below — pass it to add_subtitles {"srt": …} or an edit plan's subtitles op.\n\n${capped}`
    } catch (err) {
      // The clear "not configured" message (naming the env vars) is thrown by the runtime and surfaces here.
      return `transcribe_audio failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const detectSilenceTool: ToolDef = {
  name: 'detect_silence',
  description: 'Find silent gaps (for "cut the silences"). Returns the silent ranges AND the loud keep-ranges to feed apply_edit_plan.',
  usage: '{"path": "raw.mp4", "threshold_db": -30, "min_duration": 0.5}',
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, threshold_db: { type: 'number' }, min_duration: { type: 'number' } },
    required: ['path']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const r = await resolveInput(ctx, readStr(o.path), 'detect_silence')
    if (typeof r === 'string') return r
    if (!ctx.runFfmpeg) return needsRuntime('detect_silence')
    const threshold = Number.isFinite(Number(o.threshold_db)) ? Number(o.threshold_db) : -30
    const minDur = Number(o.min_duration) > 0 ? Number(o.min_duration) : 0.5
    ctx.onStatus?.(`Scanning ${r.rel} for silence`)
    try {
      const res = await ctx.runFfmpeg(buildSilenceArgs(r.abs, threshold, minDur), { signal: ctx.signal })
      const silences = parseSilenceRanges(res.stderr)
      if (!silences.length) return `No silence ≥ ${minDur}s below ${threshold} dB found in ${r.rel}.`
      const info = await tryProbe(ctx, r.abs)
      const fmt = (rs: { start: number; end: number }[]): string => rs.map((x) => `${x.start.toFixed(2)}–${x.end.toFixed(2)}`).join(', ')
      let out = `Found ${silences.length} silent gap(s): ${fmt(silences)}.`
      if (info && info.durationSec > 0) {
        const keeps = silenceToKeepRanges(silences, info.durationSec)
        const keepJson = keeps.map((k) => `{"start":${k.start.toFixed(2)},"end":${k.end.toFixed(2)}}`).join(',')
        out += `\nKeep-ranges (loud parts): ${fmt(keeps)}.\nTo cut the silences, call apply_edit_plan with an op {"op":"segments","keep":[${keepJson}]}.`
      }
      return out
    } catch (err) {
      return `detect_silence failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const addSubtitlesTool: ToolDef = {
  name: 'add_subtitles',
  description: 'Burn captions onto a video from SRT text or a segments array. Optional libass "style" (e.g. "FontSize=24,Outline=2").',
  usage: '{"path": "reel.mp4", "srt": "1\\n00:00:00,000 --> 00:00:02,000\\nHello"}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, srt: { type: 'string' }, segments: { type: 'array' }, style: { type: 'string' }, output: { type: 'string' } },
    required: ['path']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const r = await resolveInput(ctx, readStr(o.path), 'add_subtitles')
    if (typeof r === 'string') return r
    const srt = buildSrtFrom(o)
    if (!srt) return 'add_subtitles needs "srt" text or a non-empty "segments" array ([{start,end,text}]).'
    if (!ctx.runFfmpeg) return needsRuntime('add_subtitles')
    const out = await chooseOutput(ctx, r.rel, r.abs, 'subs', readStr(o.output))
    if (typeof out === 'string') return out
    let sub = ''
    try {
      sub = await writeTemp(srt, 'srt')
      const info = await tryProbe(ctx, r.abs)
      await runEncode(ctx, buildSubtitleBurnArgs(r.abs, out.abs, sub, readStr(o.style) ?? undefined), 'Burning subtitles', info?.durationSec)
      await emitOutput(ctx, out.abs, out.rel, `subtitles ${r.rel}`)
      return `Burned subtitles → ${await describeOutput(ctx, out.rel, out.abs)}`
    } catch (err) {
      return `add_subtitles failed: ${toErrorMessage(err)}`
    } finally {
      if (sub) await rm(sub, { force: true }).catch(() => {})
    }
  }
}

export const mixAudioTool: ToolDef = {
  name: 'mix_audio',
  description: 'Add/replace a video\'s audio with another track. mode: "mix" (blend), "replace", or "duck" (lower music under speech).',
  usage: '{"video_path": "reel.mp4", "audio_path": "music.mp3", "mode": "duck", "volume": 0.6}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: {
      video_path: { type: 'string' }, audio_path: { type: 'string' },
      mode: { type: 'string', enum: ['mix', 'replace', 'duck'] }, volume: { type: 'number' }, output: { type: 'string' }
    },
    required: ['video_path', 'audio_path']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const rv = await resolveInput(ctx, readStr(o.video_path), 'mix_audio (video_path)')
    if (typeof rv === 'string') return rv
    const ra = await resolveInput(ctx, readStr(o.audio_path), 'mix_audio (audio_path)')
    if (typeof ra === 'string') return ra
    const mode = o.mode === 'replace' || o.mode === 'duck' ? o.mode : 'mix'
    if (!ctx.runFfmpeg) return needsRuntime('mix_audio')
    const out = await chooseOutput(ctx, rv.rel, rv.abs, 'audio', readStr(o.output))
    if (typeof out === 'string') return out
    try {
      const info = await tryProbe(ctx, rv.abs)
      await runEncode(ctx, buildMixAudioArgs(rv.abs, ra.abs, out.abs, mode, clampVolume(o.volume, 1)), 'Mixing audio', info?.durationSec)
      await emitOutput(ctx, out.abs, out.rel, `${mode} audio`)
      return `Mixed audio (${mode}) → ${await describeOutput(ctx, out.rel, out.abs)}`
    } catch (err) {
      return `mix_audio failed: ${toErrorMessage(err)}`
    }
  }
}

export const resizeOrCropTool: ToolDef = {
  name: 'resize_or_crop',
  description: 'Reframe a video to an aspect ratio (9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 2:1). mode: "crop" (fill), "pad" (bars), "stretch".',
  usage: '{"path": "raw.mp4", "aspect_ratio": "9:16", "mode": "crop"}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' }, aspect_ratio: { type: 'string' },
      mode: { type: 'string', enum: ['crop', 'pad', 'stretch'] }, output: { type: 'string' }
    },
    required: ['path', 'aspect_ratio']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const r = await resolveInput(ctx, readStr(o.path), 'resize_or_crop')
    if (typeof r === 'string') return r
    if (!isAspectRatio(o.aspect_ratio)) return 'resize_or_crop needs "aspect_ratio" ∈ 9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 2:1.'
    const mode = isFitMode(o.mode) ? o.mode : 'crop'
    if (!ctx.runFfmpeg) return needsRuntime('resize_or_crop')
    const out = await chooseOutput(ctx, r.rel, r.abs, o.aspect_ratio.replace(':', 'x'), readStr(o.output))
    if (typeof out === 'string') return out
    try {
      const info = await tryProbe(ctx, r.abs)
      await runEncode(ctx, buildResizeCropArgs(r.abs, out.abs, o.aspect_ratio, mode), `Reframing to ${o.aspect_ratio}`, info?.durationSec)
      await emitOutput(ctx, out.abs, out.rel, `${o.aspect_ratio} ${mode}`)
      return `Reframed to ${o.aspect_ratio} (${mode}) → ${await describeOutput(ctx, out.rel, out.abs)}`
    } catch (err) {
      return `resize_or_crop failed: ${toErrorMessage(err)}`
    }
  }
}

export const applyEditPlanTool: ToolDef = {
  name: 'apply_edit_plan',
  description: 'Run a whole edit as ONE render: cut to segments, change speed, reframe, burn subtitles, set volume/mute. Preferred for multi-step edits.',
  usage: '{"input": "raw.mp4", "operations": [{"op":"segments","keep":[{"start":0,"end":5}]},{"op":"resize","aspect":"9:16"}]}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: { input: { type: 'string' }, output: { type: 'string' }, operations: { type: 'array' }, plan: { type: 'object' } },
    required: ['operations']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const res = validateEditPlan(o.plan && typeof o.plan === 'object' ? o.plan : o)
    if (!res.ok) return `apply_edit_plan: ${res.error}.`
    const r = await resolveInput(ctx, res.plan.input, 'apply_edit_plan')
    if (typeof r === 'string') return r
    if (!ctx.runFfmpeg) return needsRuntime('apply_edit_plan')
    const out = await chooseOutput(ctx, r.rel, r.abs, 'edit', res.plan.output ?? null, 'mp4')
    if (typeof out === 'string') return out
    const subOp = res.plan.operations.find((op) => op.op === 'subtitles')
    let sub = ''
    try {
      let subAbs: string | undefined
      if (subOp && subOp.op === 'subtitles') {
        const srt = subOp.srt ?? (subOp.segments ? segmentsToSrt(subOp.segments) : '')
        if (srt.trim()) { sub = await writeTemp(srt, 'srt'); subAbs = sub }
      }
      const info = await tryProbe(ctx, r.abs)
      await runEncode(ctx, buildEditPlanArgs(r.abs, out.abs, res.plan, subAbs), 'Rendering edit', info?.durationSec)
      await emitOutput(ctx, out.abs, out.rel, 'edit plan')
      const ops = res.plan.operations.map((op) => op.op).join(' → ')
      return `Rendered edit (${ops}) → ${await describeOutput(ctx, out.rel, out.abs)}`
    } catch (err) {
      return `apply_edit_plan failed: ${toErrorMessage(err)}`
    } finally {
      if (sub) await rm(sub, { force: true }).catch(() => {})
    }
  }
}

export const runFfmpegTool: ToolDef = {
  name: 'run_ffmpeg',
  description: 'Escape hatch: run ffmpeg with your own argument ARRAY (no shell). Paths must be RELATIVE and inside the working folder. Prefer the specific tools.',
  usage: '{"args": ["-i","raw.mp4","-vf","hflip","myto-edits/flipped.mp4"], "output": "myto-edits/flipped.mp4"}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: { args: { type: 'array', items: { type: 'string' } }, output: { type: 'string' } },
    required: ['args']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    if (!Array.isArray(o.args) || o.args.some((a) => typeof a !== 'string')) {
      return 'run_ffmpeg needs an "args" array of strings (one token per element — never a single shell string).'
    }
    const args = o.args as string[]
    if (!args.length || args.length > 100) return 'run_ffmpeg: give between 1 and 100 arguments.'
    // Sandbox: reject any arg that is an absolute path or climbs out of the folder with "..".
    // Combined with cwd = workspace below, every path the model names resolves INSIDE the folder.
    for (const a of args) {
      if (isAbsolute(a) || /(^|[\\/])\.\.([\\/]|$)/.test(a)) {
        return `run_ffmpeg: "${a}" is an absolute path or climbs out of the working folder. Use paths relative to it.`
      }
    }
    if (!ctx.runFfmpeg || !ctx.workspaceDir) return needsRuntime('run_ffmpeg')
    ctx.onStatus?.('Running ffmpeg')
    try {
      const res = await ctx.runFfmpeg(args, { signal: ctx.signal, cwd: ctx.workspaceDir })
      if (res.exitCode !== 0) {
        return `ffmpeg exited with code ${res.exitCode}.\n${res.stderr.trim().split('\n').slice(-6).join('\n')}`
      }
      const outRel = readStr(o.output)
      const outAbs = outRel ? resolveInWorkspace(ctx.workspaceDir, outRel) : null
      if (outRel && outAbs) {
        await emitOutput(ctx, outAbs, outRel, 'ffmpeg output')
        return `ffmpeg finished → ${await describeOutput(ctx, outRel, outAbs)}`
      }
      return 'ffmpeg finished successfully.'
    } catch (err) {
      return `run_ffmpeg failed: ${toErrorMessage(err)}`
    }
  }
}

/** Every media-editing tool, in a stable order (registered in registry.ts → ALL_TOOLS). */
export const mediaEditTools: readonly ToolDef[] = [
  probeVideoTool,
  trimClipTool,
  concatClipsTool,
  extractFramesTool,
  transcribeAudioTool,
  detectSilenceTool,
  addSubtitlesTool,
  mixAudioTool,
  resizeOrCropTool,
  applyEditPlanTool,
  runFfmpegTool
]

