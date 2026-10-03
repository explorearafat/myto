/**
 * The ELECTRON/Node half of the video-editing tools — the actual process spawning. Mirrors
 * document-raster-runtime.ts: all pure logic (arg builders, parsers, edit-plan compile) lives
 * in ./tools/ffmpeg-core.ts and is unit-tested; this file only resolves the bundled binaries
 * and spawns them, so it is typechecked but not unit-tested (it needs the packaged binaries).
 *
 * Safety: every spawn passes an argument ARRAY and `shell` is never set, so no shell parsing
 * or interpolation can happen — the model's typed fields reach ffmpeg verbatim. The ffmpeg /
 * ffprobe binaries come from ffmpeg-static / ffprobe-static, resolved at runtime out of the
 * unpacked node_modules (electron-builder asarUnpack), never bundled into the app chunk.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProgress, buildProbeArgs, type FfmpegProgress } from './tools/ffmpeg-core'

/** Outcome of one spawned ffmpeg/ffprobe process. */
export interface FfmpegRunResult {
  exitCode: number | null
  /** stderr tail (ffmpeg logs + silencedetect lines land here). */
  stderr: string
  /** stdout (ffprobe JSON; empty for encodes unless captured). */
  stdout: string
}

/** Options for a single ffmpeg run (progress + cancellation). */
export interface FfmpegRunOptions {
  onProgress?: (p: FfmpegProgress) => void
  totalDurationSec?: number
  signal?: AbortSignal
  captureStdout?: boolean
  /**
   * Working directory for the spawned process. The `run_ffmpeg` escape-hatch tool sets
   * this to the Cowork working folder so relative paths in the model's args can only
   * resolve inside the sandbox; omitted elsewhere (every other tool passes absolute paths).
   */
  cwd?: string
}

/** electron-builder keeps the binaries in app.asar.unpacked; ffmpeg-static reports the
 * in-asar path, so rewrite it. Harmless in dev (no "app.asar" segment to replace). */
function unpacked(p: string): string {
  return p.includes('app.asar') && !p.includes('app.asar.unpacked')
    ? p.replace('app.asar', 'app.asar.unpacked')
    : p
}

let _ffmpeg: string | null = null
let _ffprobe: string | null = null

/** Absolute path to the bundled ffmpeg binary (memoised). */
export function ffmpegPath(): string {
  if (!_ffmpeg) {
    const req = createRequire(import.meta.url)
    _ffmpeg = unpacked(req('ffmpeg-static') as string)
  }
  return _ffmpeg
}

/** Absolute path to the bundled ffprobe binary (memoised). */
export function ffprobePath(): string {
  if (!_ffprobe) {
    const req = createRequire(import.meta.url)
    _ffprobe = unpacked((req('ffprobe-static') as { path: string }).path)
  }
  return _ffprobe
}

/** Spawn a binary with an arg ARRAY (never a shell), streaming progress + capturing output. */
function spawnBinary(bin: string, args: string[], opts: FfmpegRunOptions): Promise<FfmpegRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd: opts.cwd })
    let stderr = ''
    let stdout = ''
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const cleanup = (): void => opts.signal?.removeEventListener('abort', onAbort)
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString()
      if (opts.captureStdout) stdout += s
      if (opts.onProgress) {
        const p = parseProgress(s, opts.totalDurationSec)
        if (p) opts.onProgress(p)
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000) // keep a readable tail only
    })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('close', (code) => {
      cleanup()
      resolve({ exitCode: code, stderr, stdout })
    })
  })
}

/** Run ffmpeg. When `onProgress` is given, `-progress pipe:1` is prepended so ticks stream. */
export function runFfmpeg(args: string[], opts: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
  const pre = opts.onProgress ? ['-progress', 'pipe:1'] : []
  return spawnBinary(ffmpegPath(), [...pre, ...args], opts)
}

/** Probe a media file and return its ffprobe JSON stdout (the tool parses it with the core). */
export async function probeMedia(absPath: string, signal?: AbortSignal): Promise<string> {
  const { exitCode, stdout, stderr } = await spawnBinary(ffprobePath(), buildProbeArgs(absPath), {
    captureStdout: true,
    signal
  })
  if (exitCode !== 0 || !stdout.trim()) {
    throw new Error(stderr.trim().split('\n').slice(-3).join(' ') || `ffprobe exited ${exitCode}`)
  }
  return stdout
}

// ── Transcription: local whisper.cpp first, then an OpenAI-compatible API ──────
//
// Resolver order (per the product decision — env-driven, no Settings UI this pass):
//   1. WHISPER_CPP_PATH (+ WHISPER_CPP_MODEL): run the local whisper.cpp CLI offline.
//   2. MYTO_TRANSCRIBE_API_KEY (+ _API_BASE, _MODEL): POST to an OpenAI-compatible endpoint.
//   3. Neither → a clear "not configured" error naming the env vars.
// To add a Settings toggle later: read the same three/​three values from CoworkSettings and
// pass them in instead of process.env, keeping this resolver's shape.

/** Raw transcript JSON (whisper.cpp or OpenAI verbose_json shape); the core parses it. */
export async function transcribeAudio(absPath: string, signal?: AbortSignal): Promise<string> {
  const whisperBin = process.env.WHISPER_CPP_PATH?.trim()
  const whisperModel = process.env.WHISPER_CPP_MODEL?.trim()
  if (whisperBin && whisperModel) return transcribeWhisperCpp(whisperBin, whisperModel, absPath, signal)
  const apiKey = process.env.MYTO_TRANSCRIBE_API_KEY?.trim()
  if (apiKey) return transcribeApi(apiKey, absPath, signal)
  throw new Error(
    'Transcription is not configured. Set WHISPER_CPP_PATH + WHISPER_CPP_MODEL for a local ' +
      'whisper.cpp, or MYTO_TRANSCRIBE_API_KEY (+ optional MYTO_TRANSCRIBE_API_BASE / _MODEL) ' +
      'for an OpenAI-compatible speech-to-text API.'
  )
}

/** whisper.cpp needs 16 kHz mono WAV, so decode with the bundled ffmpeg first, then run the CLI. */
async function transcribeWhisperCpp(
  bin: string, model: string, absPath: string, signal?: AbortSignal
): Promise<string> {
  const wav = join(tmpdir(), `myto-stt-${Date.now().toString(36)}.wav`)
  const outBase = wav.replace(/\.wav$/, '')
  try {
    const dec = await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', absPath, '-ar', '16000', '-ac', '1', wav], { signal })
    if (dec.exitCode !== 0) throw new Error('could not decode audio for transcription')
    const { exitCode, stderr } = await spawnBinary(
      bin,
      ['-m', model, '-f', wav, '--output-json', '--output-file', outBase],
      { signal }
    )
    if (exitCode !== 0) throw new Error(stderr.trim().split('\n').slice(-2).join(' ') || `whisper exited ${exitCode}`)
    return await readFile(`${outBase}.json`, 'utf8')
  } finally {
    await rm(wav, { force: true }).catch(() => {})
    await rm(`${outBase}.json`, { force: true }).catch(() => {})
  }
}

/** POST the audio to an OpenAI-compatible /audio/transcriptions endpoint (verbose_json). */
async function transcribeApi(apiKey: string, absPath: string, signal?: AbortSignal): Promise<string> {
  const base = (process.env.MYTO_TRANSCRIBE_API_BASE?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = process.env.MYTO_TRANSCRIBE_MODEL?.trim() || 'whisper-1'
  const bytes = await readFile(absPath)
  const form = new FormData()
  const name = absPath.replace(/\\/g, '/').split('/').pop() || 'audio'
  form.append('file', new Blob([new Uint8Array(bytes)]), name)
  form.append('model', model)
  form.append('response_format', 'verbose_json')
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  })
  if (!res.ok) throw new Error(`transcription API returned ${res.status} ${res.statusText}`)
  return await res.text()
}

/** Materialise an SRT (or raw subtitle text) to a temp file ffmpeg's subtitles filter can read. */
export async function writeTempSubtitle(srt: string): Promise<string> {
  const path = join(tmpdir(), `myto-sub-${Date.now().toString(36)}.srt`)
  await writeFile(path, srt, 'utf8')
  return path
}

/** Remove a temp subtitle file written by {@link writeTempSubtitle}. */
export async function removeTempSubtitle(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {})
}

