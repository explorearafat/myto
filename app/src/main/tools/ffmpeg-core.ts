/**
 * FFmpeg argument builders + validators — the PURE half of the video/photo editing tools.
 * No Electron, no `child_process`, no filesystem: every function here takes already-resolved
 * absolute paths (the TOOL resolves them through the workspace sandbox) and returns a plain
 * `string[]` argument vector or a parsed value. That is the whole safety story — the model
 * never gets to compose a shell string; it fills small typed fields, these builders turn them
 * into an arg ARRAY, and the runtime spawns ffmpeg with that array and no shell. Mirrors the
 * document-raster-core.ts split: all the logic (and all the unit tests) live here; the actual
 * spawn lives in ../ffmpeg-runtime.ts behind a ctx callback.
 */

/** A single stream inside a media container, normalised from ffprobe's JSON. */
export interface MediaStreamInfo {
  index: number
  type: 'video' | 'audio' | 'subtitle' | 'other'
  codec: string
  width?: number
  height?: number
  fps?: number
  channels?: number
  sampleRate?: number
}

/** The shape probe_video returns — a concise, model-friendly summary of a media file. */
export interface MediaInfo {
  durationSec: number
  sizeBytes: number
  format: string
  bitRate?: number
  streams: MediaStreamInfo[]
  /** First video stream, if any (convenience). */
  video?: MediaStreamInfo
  /** First audio stream, if any (convenience). */
  audio?: MediaStreamInfo
}

/** One caption line with absolute start/end seconds — the unit transcription returns. */
export interface Segment {
  start: number
  end: number
  text: string
}

/** Target shapes resize_or_crop / the edit plan understand. */
export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5' | '4:3' | '3:4' | '2:1'

/** How to fit the source into the target frame. */
export type FitMode = 'crop' | 'pad' | 'stretch'

/** Decoded `-progress pipe:1` tick (or a stderr `time=` line) during a render. */
export interface FfmpegProgress {
  /** Output position in seconds reached so far. */
  outTimeSec: number
  /** 0–100 when a total duration is known, else undefined. */
  percent?: number
  speed?: string
  done: boolean
}

// ── Time + number parsing ───────────────────────────────────────────────────

/**
 * Parse a timecode into seconds. Accepts a number (seconds), a plain numeric
 * string ("12.5"), or clock forms "SS", "MM:SS", "HH:MM:SS" with optional ".ms".
 * Returns null for anything unparseable or negative — the caller turns that into a
 * readable tool error rather than passing junk to ffmpeg.
 */
export function parseTimecode(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  let sec = 0
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p.trim())) return null
    sec = sec * 60 + Number(p)
  }
  return Number.isFinite(sec) && sec >= 0 ? sec : null
}

/** Seconds → "HH:MM:SS,mmm" for SRT timestamps. */
export function secondsToSrtTime(sec: number): string {
  const clamped = Math.max(0, sec)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

/** Clamp an audio volume multiplier to a sane [0, 4] (0 = mute, 1 = unchanged). */
export function clampVolume(v: unknown, fallback = 1): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(4, n)
}

// ── ffprobe JSON → MediaInfo ──────────────────────────────────────────────────

/** Parse "num/den" (ffprobe r_frame_rate) → fps, or undefined. */
function parseFrac(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(v.trim())
  if (m) {
    const den = Number(m[2])
    return den ? Number(m[1]) / den : undefined
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Normalise `ffprobe -print_format json -show_format -show_streams` output into a
 * {@link MediaInfo}. Pure: the runtime hands over the raw stdout string, this parses
 * it. Throws a readable error on malformed JSON so the tool can report it.
 */
export function parseProbe(json: string): MediaInfo {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('ffprobe did not return valid JSON')
  }
  const format = (root.format ?? {}) as Record<string, unknown>
  const rawStreams = Array.isArray(root.streams) ? (root.streams as Record<string, unknown>[]) : []
  const streams: MediaStreamInfo[] = rawStreams.map((s, i) => {
    const codecType = String(s.codec_type ?? 'other')
    const type: MediaStreamInfo['type'] =
      codecType === 'video' || codecType === 'audio' || codecType === 'subtitle' ? codecType : 'other'
    const info: MediaStreamInfo = {
      index: typeof s.index === 'number' ? s.index : i,
      type,
      codec: String(s.codec_name ?? 'unknown')
    }
    if (typeof s.width === 'number') info.width = s.width
    if (typeof s.height === 'number') info.height = s.height
    const fps = parseFrac(s.r_frame_rate)
    if (fps) info.fps = Math.round(fps * 1000) / 1000
    if (s.channels != null) info.channels = Number(s.channels)
    if (s.sample_rate != null) info.sampleRate = Number(s.sample_rate)
    return info
  })
  const durationSec = Number(format.duration) || 0
  const sizeBytes = Number(format.size) || 0
  const bitRate = Number(format.bit_rate) || undefined
  return {
    durationSec,
    sizeBytes,
    format: String(format.format_name ?? 'unknown'),
    bitRate,
    streams,
    video: streams.find((s) => s.type === 'video'),
    audio: streams.find((s) => s.type === 'audio')
  }
}

// ── Aspect ratio → scale/crop/pad filter ─────────────────────────────────────

/** Canonical pixel dimensions for the aspect ratios reels/posts actually use. */
const ASPECT_DIMS: Record<AspectRatio, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '3:4': { w: 1080, h: 1440 },
  '4:3': { w: 1440, h: 1080 },
  '2:1': { w: 1920, h: 960 }
}

/** True when `v` is one of the aspect ratios we accept. */
export function isAspectRatio(v: unknown): v is AspectRatio {
  return typeof v === 'string' && v in ASPECT_DIMS
}

/** True when `v` is a fit mode we accept (defaults applied elsewhere). */
export function isFitMode(v: unknown): v is FitMode {
  return v === 'crop' || v === 'pad' || v === 'stretch'
}

/**
 * The `-vf` value that reshapes any source into `aspect` at canonical size:
 *  - crop: cover the frame then centre-crop the overflow (no bars, may lose edges)
 *  - pad: fit inside then letterbox with black bars (whole frame kept)
 *  - stretch: ignore aspect and squash to fit (distorts)
 */
export function aspectFilter(aspect: AspectRatio, mode: FitMode): string {
  const { w, h } = ASPECT_DIMS[aspect]
  if (mode === 'stretch') return `scale=${w}:${h}`
  if (mode === 'pad') {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
}

// ── Output-path derivation (project-scoped, never the input) ──────────────────

/** The sub-folder (relative to the workspace) all generated media lands in. */
export const OUTPUT_DIR = 'myto-edits'

/** Strip directory + extension from a relative/absolute path → bare base name. */
function baseName(p: string): string {
  const noDir = p.replace(/\\/g, '/').split('/').pop() ?? p
  return noDir.replace(/\.[^.]+$/, '')
}

/** Lowercase extension of a path without the dot, or '' when none. */
export function extOf(p: string): string {
  const m = /\.([a-z0-9]+)\s*$/i.exec(p)
  return m ? m[1].toLowerCase() : ''
}

/**
 * A unique, project-scoped output path (relative to the workspace): always under
 * {@link OUTPUT_DIR}, named `<base>-<suffix>-<uniq>.<ext>`. Guarantees the result is
 * never the input (different folder + unique token), which is the "never overwrite the
 * input" safety rule. `uniq` is injected (the tool passes a timestamp) so this stays pure
 * and testable; `ext` defaults to the input's extension.
 */
export function deriveOutputRel(inputRel: string, suffix: string, uniq: string, ext?: string): string {
  const e = (ext ?? extOf(inputRel) ?? 'mp4').replace(/^\./, '') || 'mp4'
  return `${OUTPUT_DIR}/${baseName(inputRel)}-${suffix}-${uniq}.${e}`
}

/** Escape a path for use INSIDE an ffmpeg filter argument (subtitles=…). Windows
 * backslashes and the drive colon must be escaped or libavfilter mis-parses them. */
export function escapeFilterPath(abs: string): string {
  return abs.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

// ── Argument builders (each returns a full ffmpeg/ffprobe arg vector) ─────────
//
// Every builder takes already-resolved absolute paths and returns a string[].
// `-y` is always safe: the output path is a fresh unique name under OUTPUT_DIR, so
// it can only overwrite a prior generated file, never the input. `-nostdin` keeps a
// stalled encode from blocking on terminal input in the spawned process.

const BASE: readonly string[] = ['-hide_banner', '-nostdin', '-y']

/** ffprobe args for a one-shot JSON probe of every stream + the container. */
export function buildProbeArgs(input: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-print_format', 'json', '-show_format', '-show_streams', input]
}

/**
 * Trim a single [start, end) range. Stream-copy by default (instant, no re-encode);
 * `reencode` gives frame-accurate cuts (libx264/aac) at the cost of time. `-ss` before
 * `-i` is the fast input seek; `-t` is the kept duration.
 */
export function buildTrimArgs(
  input: string, output: string, startSec: number, endSec: number, reencode = false
): string[] {
  const dur = Math.max(0, endSec - startSec)
  const codec = reencode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac']
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
  return [...BASE, '-ss', String(startSec), '-i', input, '-t', String(dur), ...codec, output]
}

/** The text of a concat-demuxer list file: one `file '<abs>'` line per input. */
export function buildConcatListContent(absPaths: string[]): string {
  return absPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/**
 * Concatenate clips written in a concat-demuxer list file. Stream-copy when the inputs
 * share a codec/params; `reencode` normalises mismatched sources into one H.264/AAC file.
 */
export function buildConcatArgs(listPath: string, output: string, reencode = false): string[] {
  const codec = reencode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac']
    : ['-c', 'copy']
  return [...BASE, '-f', 'concat', '-safe', '0', '-i', listPath, ...codec, output]
}

/** Extract frames at a fixed interval (one every `intervalSec`), capped at `maxFrames`.
 * `outPattern` is an ffmpeg numbered pattern, e.g. `frame-%03d.jpg`. */
/** A `scale` sub-filter that shrinks a frame to fit within `maxDim` px (keeps aspect, never upscales). */
export function fitScale(maxDim: number): string {
  return `scale='min(iw,${maxDim})':'min(ih,${maxDim})':force_original_aspect_ratio=decrease`
}

export function buildFramesIntervalArgs(
  input: string, outPattern: string, intervalSec: number, maxFrames: number, maxDim?: number
): string[] {
  const safeInterval = intervalSec > 0 ? intervalSec : 1
  const vf = maxDim ? `fps=1/${safeInterval},${fitScale(maxDim)}` : `fps=1/${safeInterval}`
  return [...BASE, '-i', input, '-vf', vf, '-frames:v', String(Math.max(1, maxFrames)), '-q:v', '2', outPattern]
}

/** Extract exactly one frame at `atSec` to `outPath`. Fast input-seek, high quality. `maxDim` caps resolution. */
export function buildFrameAtArgs(input: string, outPath: string, atSec: number, maxDim?: number): string[] {
  const scale = maxDim ? ['-vf', fitScale(maxDim)] : []
  return [...BASE, '-ss', String(Math.max(0, atSec)), '-i', input, ...scale, '-frames:v', '1', '-q:v', '2', outPath]
}

/** Analyse-only pass that logs silent ranges to stderr via the `silencedetect` filter.
 * `thresholdDb` is negative (e.g. -30); `minDurationSec` ignores blips shorter than it. */
export function buildSilenceArgs(input: string, thresholdDb: number, minDurationSec: number): string[] {
  return ['-hide_banner', '-nostdin', '-i', input, '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDurationSec}`, '-f', 'null', '-']
}

/**
 * Burn (hardcode) a subtitle file onto the video via the `subtitles` filter, so captions
 * survive re-upload to any platform. `subAbsPath` is the on-disk .srt/.ass; `styleForce`
 * is an optional libass `force_style` string (e.g. "FontSize=24,Outline=2").
 */
export function buildSubtitleBurnArgs(
  input: string, output: string, subAbsPath: string, styleForce?: string
): string[] {
  const style = styleForce ? `:force_style='${styleForce.replace(/'/g, '')}'` : ''
  const vf = `subtitles='${escapeFilterPath(subAbsPath)}'${style}`
  return [...BASE, '-i', input, '-vf', vf, '-c:a', 'copy', output]
}

/**
 * Combine a video's audio with a second audio file. `mode`:
 *  - 'replace': drop the video's own audio, use the new track (copy video)
 *  - 'mix': blend both (new track at `volume`), length clamped to the video
 *  - 'duck': like mix but the music is auto-lowered under the original speech (sidechain)
 */
export function buildMixAudioArgs(
  video: string, audio: string, output: string, mode: 'replace' | 'mix' | 'duck', volume: number
): string[] {
  if (mode === 'replace') {
    const vol = volume === 1 ? [] : ['-filter:a:1', `volume=${volume}`]
    return [...BASE, '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', ...vol, '-c:v', 'copy', '-shortest', output]
  }
  const filter =
    mode === 'duck'
      ? `[1:a]volume=${volume}[m];[0:a][m]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[a]`
      : `[1:a]volume=${volume}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`
  return [...BASE, '-i', video, '-i', audio, '-filter_complex', filter, '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-shortest', output]
}

/** Reshape a video to `aspect` using `mode` (see {@link aspectFilter}); audio is copied. */
export function buildResizeCropArgs(
  input: string, output: string, aspect: AspectRatio, mode: FitMode
): string[] {
  return [...BASE, '-i', input, '-vf', aspectFilter(aspect, mode), '-c:a', 'copy', output]
}

// ── Output parsers (stderr / -progress) ───────────────────────────────────────

/** Pull silent [start, end] ranges (seconds) out of a `silencedetect` stderr log. */
export function parseSilenceRanges(stderr: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let pendingStart: number | null = null
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr))) {
    const t = Number(m[2])
    if (m[1] === 'start') pendingStart = t
    else if (pendingStart != null) {
      ranges.push({ start: Math.max(0, pendingStart), end: t })
      pendingStart = null
    }
  }
  return ranges
}

/**
 * Invert silent ranges into the LOUD keep-ranges across a clip of `durationSec` — the
 * segments a "cut the silences" edit keeps. Drops keep-ranges shorter than `minKeepSec`.
 */
export function silenceToKeepRanges(
  silences: { start: number; end: number }[], durationSec: number, minKeepSec = 0.1
): { start: number; end: number }[] {
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) keeps.push({ start: cursor, end: Math.min(s.start, durationSec) })
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < durationSec) keeps.push({ start: cursor, end: durationSec })
  return keeps.filter((k) => k.end - k.start >= minKeepSec)
}

/** Parse one chunk of ffmpeg `-progress pipe:1` output into a {@link FfmpegProgress}. */
export function parseProgress(chunk: string, totalDurationSec?: number): FfmpegProgress | null {
  const outMatch = /out_time_(?:ms|us)=(\d+)/.exec(chunk)
  const timeMatch = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk)
  const speedMatch = /speed=\s*([\d.]+x)/.exec(chunk)
  const done = /progress=end/.test(chunk)
  let outTimeSec = 0
  if (timeMatch) {
    outTimeSec = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])
  } else if (outMatch) {
    // out_time_us / out_time_ms are both emitted in MICROseconds by modern ffmpeg.
    outTimeSec = Number(outMatch[1]) / 1_000_000
  } else if (!done) {
    return null
  }
  const percent =
    totalDurationSec && totalDurationSec > 0
      ? Math.min(100, Math.round((outTimeSec / totalDurationSec) * 100))
      : undefined
  return { outTimeSec, percent, speed: speedMatch?.[1], done }
}

// ── Subtitles (SRT) + transcription normalisation ─────────────────────────────

/** Render caption {@link Segment}s to an SRT document (1-based, blank-line separated). */
export function segmentsToSrt(segments: Segment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${secondsToSrtTime(s.start)} --> ${secondsToSrtTime(s.end)}\n${s.text.trim()}\n`)
    .join('\n')
}

/**
 * Normalise a whisper.cpp / OpenAI-style transcription JSON into {@link Segment}s. Accepts
 * either `{ segments: [{ start, end, text }] }` (both emit this) or `{ transcription: [...] }`
 * (whisper.cpp `--output-json`, with `offsets.from/to` in ms). Pure, so it is unit-tested
 * without a transcriber present.
 */
export function parseTranscriptJson(json: string): Segment[] {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('transcription output was not valid JSON')
  }
  const whisperCpp = Array.isArray(root.transcription) ? (root.transcription as Record<string, unknown>[]) : null
  if (whisperCpp) {
    return whisperCpp.map((seg) => {
      const off = (seg.offsets ?? {}) as Record<string, unknown>
      return {
        start: Number(off.from ?? 0) / 1000,
        end: Number(off.to ?? 0) / 1000,
        text: String(seg.text ?? '').trim()
      }
    })
  }
  const segs = Array.isArray(root.segments) ? (root.segments as Record<string, unknown>[]) : []
  return segs.map((s) => ({
    start: Number(s.start ?? 0),
    end: Number(s.end ?? 0),
    text: String(s.text ?? '').trim()
  }))
}

/** Chain `atempo` filters (each limited to 0.5–2.0) to reach an arbitrary speed `factor`. */
export function atempoChain(factor: number): string {
  const parts: string[] = []
  let r = factor
  while (r > 2) { parts.push('atempo=2.0'); r /= 2 }
  while (r < 0.5) { parts.push('atempo=0.5'); r *= 2 }
  parts.push(`atempo=${Math.round(r * 1000) / 1000}`)
  return parts.join(',')
}

// ── Edit plan: a JSON pipeline compiled into ONE render ───────────────────────

/** One operation in an edit plan. Order of application is fixed (not list order):
 * keep-ranges → speed → resize → colorGrade → filter → subtitles → text → audio —
 * the natural reel pipeline. A `transition` op (when ≥2 keep-ranges) turns the
 * keep-ranges concat into an xfade chain instead. */
export type EditOp =
  | { op: 'segments'; keep: { start: number; end: number }[] }
  | { op: 'trim'; start: number; end: number }
  | { op: 'speed'; factor: number }
  | { op: 'resize'; aspect: AspectRatio; mode: FitMode }
  | { op: 'subtitles'; srt?: string; segments?: Segment[] }
  | { op: 'volume'; factor: number }
  | { op: 'mute' }
  /** Color grade via `eq` (brightness/contrast/saturation/gamma) + `colorbalance`
   * (temperature/tint). Every field optional; at least one required. */
  | {
      op: 'colorGrade'
      brightness?: number
      contrast?: number
      saturation?: number
      gamma?: number
      temperature?: number
      tint?: number
    }
  /** A named look from {@link FILTER_PRESETS} (vivid, cinematic, mono, vintage, …). */
  | { op: 'filter'; name: string }
  /** A styled, optionally time-boxed `drawtext` overlay (CapCut-style caption/title). */
  | {
      op: 'text'
      text: string
      start?: number
      end?: number
      x?: number | string
      y?: number | string
      fontSize?: number
      color?: string
      box?: boolean
      boxColor?: string
    }
  /** An `xfade`/`acrossfade` transition between consecutive keep-ranges. */
  | { op: 'transition'; name: string; durationSec: number }

/** A validated edit plan: one input, an optional output name, and ≥1 operation. */
export interface EditPlan {
  input: string
  output?: string
  operations: EditOp[]
}

/** Discriminated validation result so the tool can print a precise error. */
export type EditPlanResult = { ok: true; plan: EditPlan } | { ok: false; error: string }

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Validate one raw operation object into a typed {@link EditOp}, or return an error string. */
function validateOp(raw: unknown, i: number): EditOp | string {
  const o = asObj(raw)
  if (!o) return `operation ${i} is not an object`
  const op = o.op
  if (op === 'mute') return { op: 'mute' }
  if (op === 'speed') {
    const f = Number(o.factor)
    if (!Number.isFinite(f) || f <= 0) return `operation ${i} (speed) needs a positive "factor"`
    return { op: 'speed', factor: f }
  }
  if (op === 'volume') {
    const f = Number(o.factor)
    if (!Number.isFinite(f) || f < 0) return `operation ${i} (volume) needs "factor" ≥ 0`
    return { op: 'volume', factor: f }
  }
  if (op === 'trim') {
    const s = parseTimecode(o.start), e = parseTimecode(o.end)
    if (s == null || e == null || e <= s) return `operation ${i} (trim) needs start < end`
    return { op: 'trim', start: s, end: e }
  }
  if (op === 'resize') {
    if (!isAspectRatio(o.aspect)) return `operation ${i} (resize) needs a valid "aspect" (9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 2:1)`
    const mode = isFitMode(o.mode) ? o.mode : 'crop'
    return { op: 'resize', aspect: o.aspect, mode }
  }
  if (op === 'segments') {
    if (!Array.isArray(o.keep) || o.keep.length === 0) return `operation ${i} (segments) needs a non-empty "keep" array`
    const keep: { start: number; end: number }[] = []
    for (const r of o.keep) {
      const ro = asObj(r)
      const s = parseTimecode(ro?.start), e = parseTimecode(ro?.end)
      if (s == null || e == null || e <= s) return `operation ${i} (segments) has a range with start >= end`
      keep.push({ start: s, end: e })
    }
    return { op: 'segments', keep }
  }
  if (op === 'subtitles') {
    const srt = typeof o.srt === 'string' && o.srt.trim() ? o.srt : undefined
    const segments = Array.isArray(o.segments)
      ? (o.segments as unknown[]).map((s) => {
          const so = asObj(s)
          return { start: Number(so?.start ?? 0), end: Number(so?.end ?? 0), text: String(so?.text ?? '') }
        })
      : undefined
    if (!srt && (!segments || segments.length === 0)) return `operation ${i} (subtitles) needs "srt" text or a "segments" array`
    return { op: 'subtitles', srt, segments }
  }
  if (op === 'colorGrade') {
    const num = (x: unknown): number | undefined => {
      const n = Number(x)
      return Number.isFinite(n) ? n : undefined
    }
    const cg: Extract<EditOp, { op: 'colorGrade' }> = { op: 'colorGrade' }
    if (o.brightness !== undefined) cg.brightness = clampNum(num(o.brightness) ?? 0, -1, 1)
    if (o.contrast !== undefined) cg.contrast = clampNum(num(o.contrast) ?? 1, 0, 3)
    if (o.saturation !== undefined) cg.saturation = clampNum(num(o.saturation) ?? 1, 0, 3)
    if (o.gamma !== undefined) cg.gamma = clampNum(num(o.gamma) ?? 1, 0.1, 10)
    if (o.temperature !== undefined) cg.temperature = clampNum(num(o.temperature) ?? 0, -100, 100)
    if (o.tint !== undefined) cg.tint = clampNum(num(o.tint) ?? 0, -100, 100)
    if (
      cg.brightness === undefined && cg.contrast === undefined && cg.saturation === undefined &&
      cg.gamma === undefined && cg.temperature === undefined && cg.tint === undefined
    ) {
      return `operation ${i} (colorGrade) needs at least one of brightness, contrast, saturation, gamma, temperature, tint`
    }
    return cg
  }
  if (op === 'filter') {
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name || !(name in FILTER_PRESETS)) {
      return `operation ${i} (filter) needs a known "name" (${Object.keys(FILTER_PRESETS).join(', ')})`
    }
    return { op: 'filter', name }
  }
  if (op === 'text') {
    const text = typeof o.text === 'string' ? o.text : ''
    if (!text.trim()) return `operation ${i} (text) needs a non-empty "text"`
    const t: Extract<EditOp, { op: 'text' }> = { op: 'text', text }
    const s = o.start !== undefined ? parseTimecode(o.start) : null
    const e = o.end !== undefined ? parseTimecode(o.end) : null
    if (s != null) t.start = s
    if (e != null) t.end = e
    if (typeof o.x === 'number' || typeof o.x === 'string') t.x = o.x
    if (typeof o.y === 'number' || typeof o.y === 'string') t.y = o.y
    const fs = Number(o.fontSize)
    if (Number.isFinite(fs) && fs > 0) t.fontSize = fs
    if (typeof o.color === 'string') t.color = o.color
    if (o.box === true) t.box = true
    if (typeof o.boxColor === 'string') t.boxColor = o.boxColor
    return t
  }
  if (op === 'transition') {
    const name = typeof o.name === 'string' ? o.name.trim() : 'fade'
    if (!XFADE_TRANSITIONS.has(name)) {
      return `operation ${i} (transition) has an unknown "name" (fade, wipeleft, slideup, circleopen, dissolve, …)`
    }
    const d = Number(o.durationSec)
    const durationSec = Number.isFinite(d) && d > 0 ? Math.min(5, d) : 0.5
    return { op: 'transition', name, durationSec }
  }
  return `operation ${i} has an unknown "op": ${JSON.stringify(op)}`
}

/**
 * Validate a raw edit-plan object (as the model emits it) into a typed {@link EditPlan}.
 * Checks the input path, that there is at least one operation, and each operation's shape.
 * Pure — the heart of the edit-plan unit tests.
 */
export function validateEditPlan(raw: unknown): EditPlanResult {
  const o = asObj(raw)
  if (!o) return { ok: false, error: 'the plan must be a JSON object' }
  const input = typeof o.input === 'string' ? o.input.trim() : ''
  if (!input) return { ok: false, error: 'the plan needs an "input" video path' }
  if (!Array.isArray(o.operations) || o.operations.length === 0) {
    return { ok: false, error: 'the plan needs a non-empty "operations" array' }
  }
  const operations: EditOp[] = []
  for (let i = 0; i < o.operations.length; i++) {
    const res = validateOp(o.operations[i], i)
    if (typeof res === 'string') return { ok: false, error: res }
    operations.push(res)
  }
  const output = typeof o.output === 'string' && o.output.trim() ? o.output.trim() : undefined
  return { ok: true, plan: { input, output, operations } }
}

// APPEND_MARKER

// ── Color grade / looks / text / transition primitives (video + photo share) ──

/** Round to 3 decimals so compiled graphs stay deterministic (no float dust). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Clamp a number into [lo, hi]. */
function clampNum(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Named one-shot looks → a primitive filter chain. Every value is a hand-checked,
 * constant ffmpeg filter string (no interpolation of model input), so a `filter` op
 * can only pick a safe preset by key. `none` is the identity (compiles to nothing).
 */
export const FILTER_PRESETS: Record<string, string> = {
  none: '',
  vivid: 'eq=saturation=1.4:contrast=1.08',
  cinematic: 'eq=contrast=1.12:saturation=0.92,colorbalance=rm=0.06:bm=-0.06:bs=0.04',
  warm: 'colorbalance=rm=0.12:bm=-0.1',
  cool: 'colorbalance=rm=-0.1:bm=0.12',
  mono: 'hue=s=0',
  bw: 'hue=s=0,eq=contrast=1.1',
  vintage: 'curves=preset=vintage',
  fade: 'curves=preset=lighter,eq=saturation=0.85',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  noir: 'hue=s=0,eq=contrast=1.25:brightness=-0.03'
}

/** The `xfade` transitions we expose (a safe subset of ffmpeg's list). */
const XFADE_TRANSITIONS = new Set<string>([
  'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose',
  'dissolve', 'pixelize', 'radial', 'smoothleft', 'smoothright', 'distance'
])

/**
 * `colorbalance` midtone shift for a Lightroom-style temperature/tint pair, each in
 * −100..100. Warm temp pushes red up / blue down; positive tint leans magenta
 * (green down). Returns '' when both are neutral. Pure.
 */
export function colorBalanceFor(temperature: number, tint: number): string {
  if (!temperature && !tint) return ''
  const t = round3(clampNum(temperature / 100, -1, 1) * 0.3)
  const k = round3(clampNum(tint / 100, -1, 1) * 0.3)
  const seg: string[] = []
  if (t) seg.push(`rm=${t}`)
  if (k) seg.push(`gm=${round3(-k)}`)
  if (t) seg.push(`bm=${round3(-t)}`)
  return seg.length ? `colorbalance=${seg.join(':')}` : ''
}

/** A {@link EditOp} colorGrade → its `eq`[,`colorbalance`] chain, or '' when neutral. */
export function colorGradeFilter(cg: Extract<EditOp, { op: 'colorGrade' }>): string {
  const eq: string[] = []
  if (cg.brightness != null && cg.brightness !== 0) eq.push(`brightness=${round3(cg.brightness)}`)
  if (cg.contrast != null && cg.contrast !== 1) eq.push(`contrast=${round3(cg.contrast)}`)
  if (cg.saturation != null && cg.saturation !== 1) eq.push(`saturation=${round3(cg.saturation)}`)
  if (cg.gamma != null && cg.gamma !== 1) eq.push(`gamma=${round3(cg.gamma)}`)
  const parts: string[] = []
  if (eq.length) parts.push(`eq=${eq.join(':')}`)
  const cb = colorBalanceFor(cg.temperature ?? 0, cg.tint ?? 0)
  if (cb) parts.push(cb)
  return parts.join(',')
}

/**
 * Escape arbitrary caption text for a single-quoted `drawtext` value. Backslashes,
 * colons and percent signs are the libavfilter metacharacters; a literal apostrophe
 * would close the quote, so it is swapped for a typographic one; newlines collapse to
 * a space. The text never reaches a shell — it rides inside the arg array.
 */
export function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/'/g, '’')
    .replace(/[\r\n]+/g, ' ')
}

/** Only allow a safe `#rrggbb[aa]` or `name[@alpha]` color token, else null. */
function sanitizeColor(c: string | undefined): string | null {
  if (typeof c !== 'string') return null
  const s = c.trim()
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return s
  if (/^[a-zA-Z]+(@[0-9.]+)?$/.test(s)) return s
  return null
}

/** Resolve an x/y field (number = px, keyword = anchored expression) for drawtext. */
function drawtextPos(v: number | string | undefined, axis: 'x' | 'y'): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.round(v))
  const kw = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (axis === 'x') {
    if (kw === 'left') return '40'
    if (kw === 'right') return 'w-tw-40'
    return '(w-tw)/2'
  }
  if (kw === 'top') return '40'
  if (kw === 'center' || kw === 'middle') return '(h-th)/2'
  return 'h-th-60'
}

/**
 * Build a `drawtext=…` filter for one styled, optionally time-boxed caption. `fontAbs`
 * is the on-disk font the TOOL resolved (drawtext needs a `fontfile=`), passed in so
 * this stays pure. Pure + deterministic.
 */
export function drawtextFilter(t: Extract<EditOp, { op: 'text' }>, fontAbs: string): string {
  const parts: string[] = [
    `fontfile='${escapeFilterPath(fontAbs)}'`,
    `text='${escapeDrawtext(t.text)}'`,
    `fontsize=${t.fontSize && t.fontSize > 0 ? Math.round(t.fontSize) : 48}`,
    `fontcolor=${sanitizeColor(t.color) ?? 'white'}`,
    `x=${drawtextPos(t.x, 'x')}`,
    `y=${drawtextPos(t.y, 'y')}`
  ]
  if (t.box) {
    parts.push('box=1', `boxcolor=${sanitizeColor(t.boxColor) ?? 'black@0.5'}`, 'boxborderw=12')
  }
  if (t.start != null || t.end != null) {
    const a = t.start ?? 0
    const b = t.end ?? a + 3
    parts.push(`enable='between(t,${round3(a)},${round3(b)})'`)
  }
  return `drawtext=${parts.join(':')}`
}


/** A compiled filtergraph plus the final video/audio pad labels to map. */
export interface CompiledGraph {
  /** The `-filter_complex` value, or '' when the plan needs no filters. */
  filterComplex: string
  /** Final video pad (an input ref like `0:v` or a produced label like `s2`). */
  video: string
  /** Final audio pad, or null when the plan mutes/drops audio. */
  audio: string | null
}

/** `0:v`-style input refs map as `0:v`; produced labels map as `[label]`. */
function mapRef(label: string): string {
  return label.includes(':') ? label : `[${label}]`
}

/**
 * Compile a validated {@link EditPlan} into a single filter_complex graph. `subtitleAbs`
 * is the on-disk path the TOOL materialised from a subtitles op; `fontAbs` is the font
 * the TOOL resolved for any `text` (drawtext) ops — both passed in so this stays pure.
 * `text` overlays are emitted ONLY when a `fontAbs` is supplied (drawtext needs a
 * fontfile), so plans without a font are unaffected. Pure + deterministic.
 */
export function compileEditPlan(plan: EditPlan, subtitleAbs?: string, fontAbs?: string): CompiledGraph {
  const stmts: string[] = []
  let v = '0:v'
  let a: string | null = '0:a'
  let idx = 0
  const next = (): string => `s${idx++}`

  // 1. keep-ranges (segments / single trim) → per-range trim then concat, OR — when a
  //    transition op is present and ≥2 ranges — an xfade/acrossfade chain between them.
  const seg = plan.operations.find((o) => o.op === 'segments' || o.op === 'trim')
  const keeps =
    seg?.op === 'segments' ? seg.keep : seg?.op === 'trim' ? [{ start: seg.start, end: seg.end }] : null
  const trans = plan.operations.find((o) => o.op === 'transition')
  if (keeps && keeps.length) {
    keeps.forEach((k, i) => {
      stmts.push(`[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`)
      stmts.push(`[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`)
    })
    if (trans?.op === 'transition' && keeps.length >= 2) {
      // Cross-fade consecutive ranges. xfade's offset is on the merged timeline, which
      // shrinks by `duration` at each join, so track the running length as we go.
      const d = trans.durationSec
      let vc = 'v0'
      let ac = 'a0'
      let acc = keeps[0].end - keeps[0].start
      for (let i = 1; i < keeps.length; i++) {
        const vl = `vt${i}`
        const al = `at${i}`
        const offset = round3(Math.max(0, acc - d))
        stmts.push(`[${vc}][v${i}]xfade=transition=${trans.name}:duration=${round3(d)}:offset=${offset}[${vl}]`)
        stmts.push(`[${ac}][a${i}]acrossfade=d=${round3(d)}[${al}]`)
        acc = acc + (keeps[i].end - keeps[i].start) - d
        vc = vl
        ac = al
      }
      v = vc
      a = ac
    } else {
      const chain = keeps.map((_, i) => `[v${i}][a${i}]`).join('')
      stmts.push(`${chain}concat=n=${keeps.length}:v=1:a=1[vc][ac]`)
      v = 'vc'
      a = 'ac'
    }
  }

  // 2. speed (video setpts + audio atempo chain)
  const sp = plan.operations.find((o) => o.op === 'speed')
  if (sp?.op === 'speed') {
    const vl = next()
    stmts.push(`[${v}]setpts=PTS/${sp.factor}[${vl}]`)
    v = vl
    if (a) {
      const al = next()
      stmts.push(`[${a}]${atempoChain(sp.factor)}[${al}]`)
      a = al
    }
  }

  // 3. resize / crop to aspect
  const rz = plan.operations.find((o) => o.op === 'resize')
  if (rz?.op === 'resize') {
    const vl = next()
    stmts.push(`[${v}]${aspectFilter(rz.aspect, rz.mode)}[${vl}]`)
    v = vl
  }

  // 3b. color grade (eq + colorbalance)
  const cg = plan.operations.find((o) => o.op === 'colorGrade')
  if (cg?.op === 'colorGrade') {
    const chain = colorGradeFilter(cg)
    if (chain) {
      const vl = next()
      stmts.push(`[${v}]${chain}[${vl}]`)
      v = vl
    }
  }

  // 3c. named look preset
  const fl = plan.operations.find((o) => o.op === 'filter')
  if (fl?.op === 'filter') {
    const chain = FILTER_PRESETS[fl.name]
    if (chain) {
      const vl = next()
      stmts.push(`[${v}]${chain}[${vl}]`)
      v = vl
    }
  }

  // 4. burn subtitles (only when the tool supplied a materialised file)
  const sub = plan.operations.find((o) => o.op === 'subtitles')
  if (sub && subtitleAbs) {
    const vl = next()
    stmts.push(`[${v}]subtitles='${escapeFilterPath(subtitleAbs)}'[${vl}]`)
    v = vl
  }

  // 4b. text overlays (drawtext) — only when a font path is supplied; one per op, in order
  if (fontAbs) {
    for (const t of plan.operations) {
      if (t.op !== 'text') continue
      const vl = next()
      stmts.push(`[${v}]${drawtextFilter(t, fontAbs)}[${vl}]`)
      v = vl
    }
  }

  // 5. audio: mute drops the track, else optional volume
  if (plan.operations.some((o) => o.op === 'mute')) {
    a = null
  } else {
    const vol = plan.operations.find((o) => o.op === 'volume')
    if (vol?.op === 'volume' && a) {
      const al = next()
      stmts.push(`[${a}]volume=${vol.factor}[${al}]`)
      a = al
    }
  }

  return { filterComplex: stmts.join(';'), video: v, audio: a }
}

/**
 * Full ffmpeg arg vector that renders an {@link EditPlan} in ONE pass. Always re-encodes
 * (filters forbid stream copy): H.264 + AAC. `inputAbs`/`outputAbs` are resolved paths;
 * `subtitleAbs` is the materialised subtitle file if the plan burns captions; `fontAbs`
 * is the font for any `text` overlays (drawtext). Both optional — omitted = those stages
 * are skipped, so existing callers stay intact.
 */
export function buildEditPlanArgs(
  inputAbs: string, outputAbs: string, plan: EditPlan, subtitleAbs?: string, fontAbs?: string
): string[] {
  const g = compileEditPlan(plan, subtitleAbs, fontAbs)
  const args = [...BASE, '-i', inputAbs]
  if (g.filterComplex) args.push('-filter_complex', g.filterComplex)
  args.push('-map', mapRef(g.video))
  if (g.audio) args.push('-map', mapRef(g.audio))
  else args.push('-an')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20')
  if (g.audio) args.push('-c:a', 'aac')
  args.push('-movflags', '+faststart', outputAbs)
  return args
}
