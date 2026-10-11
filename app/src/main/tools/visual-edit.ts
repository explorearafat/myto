/**
 * The "watch Myto edit" TOOLS (Build mode) — `edit_photo` (Phase 2) and `edit_video`
 * (Phase 3). Each ONE call drives a whole watchable editing session: it opens the Editor
 * pane on a downscaled source still, streams an ordered choreography the renderer animates
 * (cursor glides, sliders slide, curve draws), then runs the REAL FFmpeg bake and hands
 * back the authoritative result for a before/after compare. The pure halves live in
 * {@link photo-core} (adjust → filter chain + arg vector), {@link editor-script-core}
 * (adjust → choreography) and {@link ffmpeg-core} (shared primitives); the live events ride
 * `ctx.onEditorEvent`, the spawn rides `ctx.runFfmpeg`, and the inline result rides
 * `ctx.emitMedia` — all wired in provider-ipc.ts. Gated by {@link fsAvailable} (Build +
 * chosen folder); degrades to a plain note when the FFmpeg runtime is absent (unit tests).
 */
import { readFile, stat, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toErrorMessage } from '../providers/http'
import type { ToolDef, ToolContext } from './registry'
import type { ToolSideEffect, PhotoAdjust, EditorEvent, EditorScript } from '../../shared/types'
import { fsAvailable, resolveInWorkspace, resolveInWorkspaceReal } from './fs'
import {
  deriveOutputRel, extOf, buildFrameAtArgs, parseProbe, segmentsToSrt,
  validateEditPlan, buildEditPlanArgs, type FfmpegProgress, type EditPlan
} from './ffmpeg-core'
import { validatePhotoAdjust, buildPhotoEditArgs } from './photo-core'
import { photoScript, videoScript } from './editor-script-core'

/** Tools that spawn a process / touch the filesystem flag 'exec' so Build prompts for them. */
const EXEC: ToolSideEffect = 'exec'
/** Largest result re-shown inline / as a data: preview (bytes). Mirrors media-edit's cap. */
const INLINE_PREVIEW_CAP = 32 * 1024 * 1024
/** Longest edge (px) of the downscaled source/result stills carried as data: images. */
const PREVIEW_MAX_DIM = 1280
/** Image extensions `edit_photo` accepts (anything else is a wrong-type refusal). */
const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'])
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff'
}
/** Video extensions `edit_video` accepts (anything else is a wrong-type refusal). */
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'])
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v'
}

// ── Small helpers ───────────────────────────────────────────────────────────────

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}
function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function uniqToken(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}
/** Write a short-lived temp file (a subtitle .srt) that ffmpeg reads; the caller removes it. */
async function writeTemp(content: string, ext: string): Promise<string> {
  const p = join(tmpdir(), `myto-${uniqToken()}.${ext}`)
  await writeFile(p, content, 'utf8')
  return p
}
function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

/** The note a tool returns when it needs the app's FFmpeg runtime but it is absent. */
function needsRuntime(tool: string): string {
  return `${tool} needs Myto's bundled FFmpeg runtime, which isn't available in this context.`
}

/** Encode bytes as a `data:<mime>;base64,…` URL for an `<img src>` (CSP allows data: images). */
function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * Render a downscaled JPEG still of an image (or a video poster at `atSec`) to a temp file,
 * read it back as a data: URL, and clean up. Returns null on any failure (preview is
 * best-effort — the pane simply shows no still rather than breaking the edit).
 */
async function renderPreview(ctx: ToolContext, inputAbs: string, atSec = 0): Promise<string | null> {
  if (!ctx.runFfmpeg) return null
  const tmp = join(tmpdir(), `myto-prev-${uniqToken()}.jpg`)
  try {
    const res = await ctx.runFfmpeg(buildFrameAtArgs(inputAbs, tmp, atSec, PREVIEW_MAX_DIM), { signal: ctx.signal })
    if (res.exitCode !== 0) return null
    const bytes = await readFile(tmp)
    return toDataUrl(bytes, 'image/jpeg')
  } catch {
    return null
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** A compact one-line summary of which controls an adjust actually moves (for the result text). */
function summarizeAdjust(adjust: PhotoAdjust): string {
  const moved: string[] = []
  for (const [k, v] of Object.entries(adjust)) {
    if (typeof v === 'number' && v !== 0) moved.push(`${k} ${v > 0 ? '+' : ''}${v}`)
  }
  if (adjust.curve) moved.push('tone curve')
  if (adjust.hsl) moved.push('HSL')
  if (adjust.crop) moved.push('crop')
  if (adjust.rotate) moved.push(`rotate ${adjust.rotate}°`)
  return moved.length ? moved.join(', ') : 'no changes'
}

/**
 * Candidate system fonts for `drawtext` (CapCut-style captions), per platform. FFmpeg's
 * `drawtext` filter needs a real `fontfile=`; we probe these in order and use the first that
 * exists. No font found → text overlays simply don't bake (the live preview still shows the
 * caption), rather than failing the whole edit. (A bundled OFL font would make this
 * deterministic across machines, but shipping one touches the build config — deferred.)
 */
const FONT_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/calibri.ttf', 'C:/Windows/Fonts/verdana.ttf'
  ],
  darwin: [
    '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf'
  ],
  linux: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'
  ]
}
let fontProbe: Promise<string | null> | null = null
/** Resolve an absolute path to a usable drawtext font (memoized), or null if none is present. */
function resolveFontAbs(): Promise<string | null> {
  if (fontProbe) return fontProbe
  fontProbe = (async () => {
    const candidates = FONT_CANDIDATES[process.platform] ?? FONT_CANDIDATES.linux
    for (const p of candidates) {
      try {
        if ((await stat(p)).isFile()) return p
      } catch { /* try the next candidate */ }
    }
    return null
  })()
  return fontProbe
}

/** A compact one-line summary of what an edit plan does (for the result text). */
function summarizePlan(plan: EditPlan): string {
  const parts: string[] = []
  for (const op of plan.operations) {
    switch (op.op) {
      case 'segments': parts.push(`${op.keep.length} segment${op.keep.length === 1 ? '' : 's'}`); break
      case 'trim': parts.push(`trim ${op.start}–${op.end}s`); break
      case 'speed': parts.push(`${op.factor}× speed`); break
      case 'resize': parts.push(`reframe ${op.aspect}`); break
      case 'subtitles': parts.push('subtitles'); break
      case 'volume': parts.push(`volume ${Math.round(op.factor * 100)}%`); break
      case 'mute': parts.push('mute'); break
      case 'colorGrade': parts.push('color grade'); break
      case 'filter': parts.push(`${op.name} look`); break
      case 'text': parts.push(`title “${op.text}”`); break
      case 'transition': parts.push(`${op.name} transition`); break
    }
  }
  return parts.length ? parts.join(', ') : 'no changes'
}

// ── edit_photo ────────────────────────────────────────────────────────────────

const EDIT_PHOTO_DESC =
  'Edit a photo in a live Lightroom-style editor the user WATCHES: one call opens the Editor pane, ' +
  'animates every adjustment (cursor, sliders, tone curve, HSL), then bakes the real result for a ' +
  'before/after. Fill the "adjust" object (each Basic field −100..100, 0 = neutral). Use this for ANY photo edit.'

export const editPhotoTool: ToolDef = {
  name: 'edit_photo',
  description: EDIT_PHOTO_DESC,
  usage: '{"path": "shots/beach.jpg", "adjust": {"exposure": 25, "contrast": 15, "temp": 20, "vibrance": 30, "clarity": 15}}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      output: { type: 'string' },
      adjust: { type: 'object' }
    },
    required: ['path', 'adjust']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const rel = readStr(o.path)
    if (!rel) return 'edit_photo needs a "path" to an image relative to the working folder.'
    const inputAbs = ctx.workspaceDir ? await resolveInWorkspaceReal(ctx.workspaceDir, rel) : null
    if (!inputAbs) return `edit_photo: "${rel}" is outside the working folder, or does not exist, and was refused.`
    const ext = extOf(inputAbs)
    if (!PHOTO_EXTS.has(ext)) {
      return `edit_photo only edits images (${[...PHOTO_EXTS].join(', ')}); "${rel}" is not one. For video use edit_video.`
    }
    const parsed = validatePhotoAdjust(o.adjust)
    if (!parsed.ok) return `edit_photo: ${parsed.error}.`
    const adjust = parsed.adjust

    if (!ctx.runFfmpeg || !ctx.workspaceDir) return needsRuntime('edit_photo')
    const emit = (e: EditorEvent): void => ctx.onEditorEvent?.(e)

    // Pick a safe UNIQUE output under myto-edits/ (never the input) and make its folder.
    const outRel = readStr(o.output) ?? deriveOutputRel(rel, 'edit', uniqToken(), ext)
    const outAbs = resolveInWorkspace(ctx.workspaceDir, outRel)
    if (!outAbs) return `edit_photo: the output path "${outRel}" is outside the working folder and was refused.`
    if (outAbs === inputAbs) return 'edit_photo: the output must differ from the input — Myto never overwrites the source.'
    try { await mkdir(dirname(outAbs), { recursive: true }) } catch { /* surfaces on write */ }

    try {
      // 1) open — downscaled source still + dimensions, so the pane appears immediately.
      ctx.onStatus?.(`Opening ${rel} in the editor`)
      const sourcePreview = await renderPreview(ctx, inputAbs)
      let width: number | undefined
      let height: number | undefined
      if (ctx.probeMedia) {
        try {
          const info = parseProbe(await ctx.probeMedia(inputAbs, ctx.signal))
          width = info.video?.width
          height = info.video?.height
        } catch { /* dimensions are best-effort */ }
      }
      emit({ phase: 'open', kind: 'photo', title: rel, sourcePreview: sourcePreview ?? '', width, height })

      // 2) script — the choreography the renderer animates while the bake runs.
      emit({ phase: 'script', script: photoScript(adjust) })

      // 3) bake — the REAL filter chain, one-frame re-encode. Photo bakes are quick, so we
      //    bracket it with a coarse progress pulse for the render bar.
      emit({ phase: 'progress', pct: 12, label: 'Rendering…' })
      ctx.onStatus?.('Baking the edit')
      const res = await ctx.runFfmpeg(buildPhotoEditArgs(inputAbs, outAbs, adjust), {
        signal: ctx.signal,
        onProgress: (p: FfmpegProgress) => {
          if (p.percent != null) emit({ phase: 'progress', pct: Math.max(12, Math.min(99, p.percent)), label: 'Rendering…' })
        }
      })
      if (res.exitCode !== 0) {
        const tail = res.stderr.trim().split('\n').slice(-4).join(' ')
        const msg = tail || `ffmpeg exited with code ${res.exitCode}`
        emit({ phase: 'error', message: msg })
        return `edit_photo failed: ${msg}`
      }

      // 4) baked — authoritative result still for the before/after compare.
      emit({ phase: 'progress', pct: 100, label: 'Done' })
      const resultPreview = await renderPreview(ctx, outAbs)
      emit({ phase: 'baked', kind: 'photo', resultPreview: resultPreview ?? '', outputPath: outRel })

      // 5) also drop the result inline in chat (small files only), best-effort.
      if (ctx.emitMedia) {
        try {
          const s = await stat(outAbs)
          if (s.size <= INLINE_PREVIEW_CAP) {
            const bytes = await readFile(outAbs)
            ctx.emitMedia([{ kind: 'image', mediaType: IMAGE_MIME[ext] ?? 'image/jpeg', dataBase64: bytes.toString('base64'), prompt: `edit ${rel}`, localPath: outRel }])
          }
        } catch { /* inline preview is best-effort; the path is always in the result */ }
      }

      const size = await stat(outAbs).then((s) => fmtBytes(s.size)).catch(() => '')
      return `Edited ${rel} (${summarizeAdjust(adjust)}) → ${outRel}${size ? ` — ${size}` : ''}. Shown in the editor with a before/after compare.`
    } catch (err) {
      const msg = toErrorMessage(err)
      ctx.onEditorEvent?.({ phase: 'error', message: msg })
      return `edit_photo failed: ${msg}`
    }
  }
}

// ── edit_video ──────────────────────────────────────────────────────────────

// EDIT_VIDEO_TOOL_PLACEHOLDER

const EDIT_VIDEO_DESC =
  'Edit a video in a live CapCut-style editor the user WATCHES: one call opens the Editor pane, ' +
  'builds the timeline (video/text/audio tracks), animates the edit (clips drop in, playhead sweeps, ' +
  'grade shifts, captions appear), then bakes the real result for a before/after. Give "input" + an ' +
  '"operations" array (segments/trim, speed, resize, colorGrade, filter, text, transition, volume, mute). ' +
  'Use this for ANY video edit.'

export const editVideoTool: ToolDef = {
  name: 'edit_video',
  description: EDIT_VIDEO_DESC,
  usage: '{"input": "clips/raw.mp4", "operations": [{"op":"trim","start":0,"end":15},{"op":"speed","factor":1.25},{"op":"filter","name":"cinematic"},{"op":"text","text":"Summer","start":0,"end":3,"y":"bottom","box":true},{"op":"resize","aspect":"9:16"}]}',
  sideEffect: EXEC,
  schema: {
    type: 'object',
    properties: {
      input: { type: 'string' },
      output: { type: 'string' },
      operations: { type: 'array' },
      plan: { type: 'object' }
    },
    required: ['operations']
  },
  available: fsAvailable,
  async run(input, ctx) {
    const o = obj(input)
    const res = validateEditPlan(o.plan && typeof o.plan === 'object' ? o.plan : o)
    if (!res.ok) return `edit_video: ${res.error}.`
    const plan = res.plan

    const inputAbs = ctx.workspaceDir ? await resolveInWorkspaceReal(ctx.workspaceDir, plan.input) : null
    if (!inputAbs) return `edit_video: "${plan.input}" is outside the working folder, or does not exist, and was refused.`
    const ext = extOf(inputAbs)
    if (!VIDEO_EXTS.has(ext)) {
      return `edit_video only edits video (${[...VIDEO_EXTS].join(', ')}); "${plan.input}" is not one. For images use edit_photo.`
    }

    if (!ctx.runFfmpeg || !ctx.workspaceDir) return needsRuntime('edit_video')
    const emit = (e: EditorEvent): void => ctx.onEditorEvent?.(e)

    // Pick a safe UNIQUE .mp4 output under myto-edits/ (never the input) and make its folder.
    const outRel = readStr(o.output) ?? plan.output ?? deriveOutputRel(plan.input, 'reel', uniqToken(), 'mp4')
    const outAbs = resolveInWorkspace(ctx.workspaceDir, outRel)
    if (!outAbs) return `edit_video: the output path "${outRel}" is outside the working folder and was refused.`
    if (outAbs === inputAbs) return 'edit_video: the output must differ from the input — Myto never overwrites the source.'
    try { await mkdir(dirname(outAbs), { recursive: true }) } catch { /* surfaces on write */ }

    let subTmp = ''
    try {
      // 1) open — a poster frame + the source duration, so the pane appears immediately.
      ctx.onStatus?.(`Opening ${plan.input} in the editor`)
      let durationSec = 0
      let width: number | undefined
      let height: number | undefined
      if (ctx.probeMedia) {
        try {
          const info = parseProbe(await ctx.probeMedia(inputAbs, ctx.signal))
          durationSec = info.durationSec
          width = info.video?.width
          height = info.video?.height
        } catch { /* duration/dimensions are best-effort */ }
      }
      const sourcePreview = await renderPreview(ctx, inputAbs, Math.min(1, durationSec / 2))
      emit({ phase: 'open', kind: 'video', title: plan.input, sourcePreview: sourcePreview ?? '', width, height, durationSec })

      // 2) script — the CapCut choreography (timeline + ordered steps) the renderer animates.
      const script: EditorScript = videoScript(plan, durationSec)
      emit({ phase: 'script', script })

      // 3) bake — the REAL filter graph. Subtitles ride a temp .srt; captions need a system
      //    font (drawtext). Percent is tracked against the OUTPUT duration from the script.
      const subOp = plan.operations.find((op) => op.op === 'subtitles')
      let subAbs: string | undefined
      if (subOp && subOp.op === 'subtitles') {
        const srt = subOp.srt ?? (subOp.segments ? segmentsToSrt(subOp.segments) : '')
        if (srt.trim()) { subTmp = await writeTemp(srt, 'srt'); subAbs = subTmp }
      }
      const hasText = plan.operations.some((op) => op.op === 'text')
      const fontAbs = hasText ? (await resolveFontAbs()) ?? undefined : undefined
      const outDurationSec = script.timeline?.durationSec || durationSec || undefined

      emit({ phase: 'progress', pct: 6, label: 'Rendering…' })
      ctx.onStatus?.('Baking the edit')
      const bake = await ctx.runFfmpeg(buildEditPlanArgs(inputAbs, outAbs, plan, subAbs, fontAbs), {
        signal: ctx.signal,
        totalDurationSec: outDurationSec,
        onProgress: (p: FfmpegProgress) => {
          if (p.percent != null) emit({ phase: 'progress', pct: Math.max(6, Math.min(99, p.percent)), label: 'Rendering…' })
        }
      })
      if (bake.exitCode !== 0) {
        const tail = bake.stderr.trim().split('\n').slice(-4).join(' ')
        const msg = tail || `ffmpeg exited with code ${bake.exitCode}`
        emit({ phase: 'error', message: msg })
        return `edit_video failed: ${msg}`
      }

      // 4) baked — result poster + the workspace path + a file:// url the Preview pane can play.
      emit({ phase: 'progress', pct: 100, label: 'Done' })
      const resultPreview = await renderPreview(ctx, outAbs, 0)
      emit({ phase: 'baked', kind: 'video', resultPreview: resultPreview ?? '', outputPath: outRel, url: pathToFileURL(outAbs).href })

      // 5) also drop the result inline in chat (small files only), best-effort.
      if (ctx.emitMedia) {
        try {
          const s = await stat(outAbs)
          if (s.size <= INLINE_PREVIEW_CAP) {
            const bytes = await readFile(outAbs)
            ctx.emitMedia([{ kind: 'video', mediaType: VIDEO_MIME[ext] ?? 'video/mp4', dataBase64: bytes.toString('base64'), prompt: `edit ${plan.input}`, localPath: outRel }])
          }
        } catch { /* inline preview is best-effort; the path is always in the result */ }
      }

      const size = await stat(outAbs).then((s) => fmtBytes(s.size)).catch(() => '')
      const fontNote = hasText && !fontAbs ? ' (captions shown live; no system font found to bake them in)' : ''
      return `Edited ${plan.input} (${summarizePlan(plan)}) → ${outRel}${size ? ` — ${size}` : ''}. Shown in the editor; play the result in the Preview pane.${fontNote}`
    } catch (err) {
      const msg = toErrorMessage(err)
      ctx.onEditorEvent?.({ phase: 'error', message: msg })
      return `edit_video failed: ${msg}`
    } finally {
      if (subTmp) await rm(subTmp, { force: true }).catch(() => {})
    }
  }
}

/** Every "watch Myto edit" tool, in a stable order (registered in registry.ts → ALL_TOOLS). */
export const visualEditTools: readonly ToolDef[] = [editPhotoTool, editVideoTool]