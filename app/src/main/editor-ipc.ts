/**
 * Myto Studio IPC — the MANUAL photo/video editor's bridge to the main process. It mirrors the
 * agent's `edit_photo`/`edit_video` tools, but driven by the USER from the Studio pane: open a
 * workspace file, bake with the SAME ffmpeg cores and runtime the agent uses, and (when a
 * model is configured) critique the baked result against a goal so Myto can self-correct.
 *
 * Safety: every spawn is an arg ARRAY through {@link runFfmpeg} (no shell); every input/output
 * path is confined to the Cowork working folder via {@link resolveInWorkspace}/
 * {@link resolveInWorkspaceReal}; the output can never equal (or overwrite) the source.
 */
import { ipcMain, type WebContents } from 'electron'
import { readFile, mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IpcChannel } from '../shared/ipc'
import type {
  StudioMediaItem,
  StudioOpenResult,
  StudioBakeResult,
  StudioCritiqueRequest
} from '../shared/types'
import { getSettings } from './settings'
import { toErrorMessage } from './providers/http'
import { runFfmpeg, probeMedia } from './ffmpeg-runtime'
import { validatePhotoAdjust, buildPhotoEditArgs } from './tools/photo-core'
import {
  buildFrameAtArgs,
  parseProbe,
  deriveOutputRel,
  extOf,
  segmentsToSrt,
  validateEditPlan,
  buildEditPlanArgs,
  type FfmpegProgress
} from './tools/ffmpeg-core'
import { resolveInWorkspace, resolveInWorkspaceReal } from './tools/fs'
import { runCritique } from './editor-vision'

/** Longest edge (px) of the downscaled stills carried as data: images to the renderer. */
const PREVIEW_MAX_DIM = 1280
const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'])
/** Cap the media picker + the recursion so a huge workspace can't stall the scan. */
const MEDIA_LIST_CAP = 300
const WALK_MAX_DEPTH = 6
/** Folders the media scan never descends into (build output, VCS, Myto's own data). */
const WALK_SKIP = new Set([
  'node_modules', '.git', '.data', '.myto', 'dist', 'out', 'build', '.next', '.cache', '.vercel'
])

// EDITOR_IPC_BODY

// ── Small helpers ──────────────────────────────────────────────────────────────

/** The Cowork working folder, or null when none is picked (every op refuses without it). */
function workspace(): string | null {
  const d = getSettings().cowork?.workspaceDir
  return typeof d === 'string' && d.trim() ? d : null
}
function uniq(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}
function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}
function fail(error: string): StudioBakeResult {
  return { ok: false, error }
}

/**
 * Render a downscaled JPEG still of a photo (or a video poster at `atSec`) to a temp file,
 * read it back as a data: URL, and clean up. Null on any failure (previews are best-effort).
 */
async function renderPreview(inputAbs: string, atSec = 0): Promise<string | null> {
  const tmp = join(tmpdir(), `myto-stu-${uniq()}.jpg`)
  try {
    const res = await runFfmpeg(buildFrameAtArgs(inputAbs, tmp, atSec, PREVIEW_MAX_DIM))
    if (res.exitCode !== 0) return null
    return toDataUrl(await readFile(tmp), 'image/jpeg')
  } catch {
    return null
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** Candidate system fonts for `drawtext` captions (same probe order as visual-edit.ts). */
const FONT_CANDIDATES: Record<string, string[]> = {
  win32: ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/calibri.ttf'],
  darwin: ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'],
  linux: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf'
  ]
}
let fontProbe: Promise<string | null> | null = null
function resolveFontAbs(): Promise<string | null> {
  if (fontProbe) return fontProbe
  fontProbe = (async () => {
    const candidates = FONT_CANDIDATES[process.platform] ?? FONT_CANDIDATES.linux
    for (const p of candidates) {
      try {
        if ((await stat(p)).isFile()) return p
      } catch { /* next */ }
    }
    return null
  })()
  return fontProbe
}

// ── Media listing ────────────────────────────────────────────────────────────

/** Walk the working folder for image + video files (bounded), newest paths sorted. */
async function listMedia(): Promise<StudioMediaItem[]> {
  const root = workspace()
  if (!root) return []
  const rootDir: string = root
  const out: StudioMediaItem[] = []
  async function walk(dirAbs: string, depth: number): Promise<void> {
    if (out.length >= MEDIA_LIST_CAP || depth > WALK_MAX_DEPTH) return
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    for (const e of entries) {
      if (out.length >= MEDIA_LIST_CAP) break
      if (WALK_SKIP.has(e.name)) continue
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue
        await walk(join(dirAbs, e.name), depth + 1)
        continue
      }
      const abs = join(dirAbs, e.name)
      const ext = extOf(abs)
      const kind = PHOTO_EXTS.has(ext) ? 'photo' : VIDEO_EXTS.has(ext) ? 'video' : null
      if (!kind) continue
      out.push({ path: relative(rootDir, abs).split(sep).join('/'), kind })
    }
  }
  await walk(rootDir, 0)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

// ── Open / frame ───────────────────────────────────────────────────────────────

async function openPhoto(rel: string): Promise<StudioOpenResult | null> {
  const root = workspace()
  if (!root || typeof rel !== 'string') return null
  const abs = await resolveInWorkspaceReal(root, rel)
  if (!abs || !PHOTO_EXTS.has(extOf(abs))) return null
  const preview = await renderPreview(abs, 0)
  if (!preview) return null
  let width: number | undefined
  let height: number | undefined
  try {
    const info = parseProbe(await probeMedia(abs))
    width = info.video?.width
    height = info.video?.height
  } catch { /* dimensions best-effort */ }
  return { preview, width, height }
}

async function openVideo(rel: string): Promise<StudioOpenResult | null> {
  const root = workspace()
  if (!root || typeof rel !== 'string') return null
  const abs = await resolveInWorkspaceReal(root, rel)
  if (!abs || !VIDEO_EXTS.has(extOf(abs))) return null
  let durationSec = 0
  let width: number | undefined
  let height: number | undefined
  try {
    const info = parseProbe(await probeMedia(abs))
    durationSec = info.durationSec
    width = info.video?.width
    height = info.video?.height
  } catch { /* best-effort */ }
  const preview = await renderPreview(abs, Math.min(1, durationSec / 2))
  if (!preview) return null
  return { preview, width, height, durationSec }
}

async function frameAt(rel: string, atSec: number): Promise<string | null> {
  const root = workspace()
  if (!root || typeof rel !== 'string') return null
  const abs = await resolveInWorkspaceReal(root, rel)
  if (!abs || !VIDEO_EXTS.has(extOf(abs))) return null
  return renderPreview(abs, Math.max(0, Number.isFinite(atSec) ? atSec : 0))
}

// EDITOR_IPC_BAKE

// ── Bake (authoritative ffmpeg re-encode) ───────────────────────────────────────

/** Emit a progress tick to the renderer that started this bake (keyed by jobId). */
function progressTo(sender: WebContents, jobId: string, pct: number, label: string): void {
  if (sender.isDestroyed()) return
  sender.send(IpcChannel.EditorBakeProgress, { jobId, pct, label })
}

async function bakePhoto(
  sender: WebContents,
  rel: string,
  rawAdjust: unknown,
  jobId: string,
  output?: string
): Promise<StudioBakeResult> {
  const root = workspace()
  if (!root) return fail('No working folder is selected — pick one in Cowork settings first.')
  const abs = await resolveInWorkspaceReal(root, rel)
  if (!abs) return fail(`"${rel}" is outside the working folder, or does not exist.`)
  if (!PHOTO_EXTS.has(extOf(abs))) return fail(`"${rel}" is not an image Myto Studio can edit.`)
  const parsed = validatePhotoAdjust(rawAdjust)
  if (!parsed.ok) return fail(parsed.error)
  const ext = extOf(abs)
  const outRel = typeof output === 'string' && output.trim() ? output.trim() : deriveOutputRel(rel, 'edit', uniq(), ext)
  const outAbs = resolveInWorkspace(root, outRel)
  if (!outAbs) return fail(`The output path "${outRel}" is outside the working folder.`)
  if (outAbs === abs) return fail('The output must differ from the source — Myto never overwrites your original.')
  try {
    await mkdir(dirname(outAbs), { recursive: true })
  } catch { /* surfaces on write */ }
  progressTo(sender, jobId, 10, 'Rendering…')
  try {
    const res = await runFfmpeg(buildPhotoEditArgs(abs, outAbs, parsed.adjust), {
      onProgress: (p: FfmpegProgress) => {
        if (p.percent != null) progressTo(sender, jobId, Math.max(10, Math.min(99, p.percent)), 'Rendering…')
      }
    })
    if (res.exitCode !== 0) {
      return fail(res.stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with code ${res.exitCode}`)
    }
    progressTo(sender, jobId, 100, 'Done')
    const resultPreview = await renderPreview(outAbs, 0)
    return { ok: true, outputPath: outRel, resultPreview: resultPreview ?? '', url: pathToFileURL(outAbs).href }
  } catch (err) {
    return fail(toErrorMessage(err))
  }
}

async function bakeVideo(sender: WebContents, rawPlan: unknown, jobId: string): Promise<StudioBakeResult> {
  const root = workspace()
  if (!root) return fail('No working folder is selected — pick one in Cowork settings first.')
  const res0 = validateEditPlan(rawPlan)
  if (!res0.ok) return fail(res0.error)
  const plan = res0.plan
  const abs = await resolveInWorkspaceReal(root, plan.input)
  if (!abs) return fail(`"${plan.input}" is outside the working folder, or does not exist.`)
  if (!VIDEO_EXTS.has(extOf(abs))) return fail(`"${plan.input}" is not a video Myto Studio can edit.`)
  const outRel = plan.output ?? deriveOutputRel(plan.input, 'reel', uniq(), 'mp4')
  const outAbs = resolveInWorkspace(root, outRel)
  if (!outAbs) return fail(`The output path "${outRel}" is outside the working folder.`)
  if (outAbs === abs) return fail('The output must differ from the source — Myto never overwrites your original.')
  try {
    await mkdir(dirname(outAbs), { recursive: true })
  } catch { /* surfaces on write */ }
  let durationSec = 0
  try {
    durationSec = parseProbe(await probeMedia(abs)).durationSec
  } catch { /* best-effort */ }
  let subTmp = ''
  try {
    const subOp = plan.operations.find((o) => o.op === 'subtitles')
    let subAbs: string | undefined
    if (subOp && subOp.op === 'subtitles') {
      const srt = subOp.srt ?? (subOp.segments ? segmentsToSrt(subOp.segments) : '')
      if (srt.trim()) {
        subTmp = join(tmpdir(), `myto-sub-${uniq()}.srt`)
        await writeFile(subTmp, srt, 'utf8')
        subAbs = subTmp
      }
    }
    const hasText = plan.operations.some((o) => o.op === 'text')
    const fontAbs = hasText ? (await resolveFontAbs()) ?? undefined : undefined
    progressTo(sender, jobId, 6, 'Rendering…')
    const bake = await runFfmpeg(buildEditPlanArgs(abs, outAbs, plan, subAbs, fontAbs), {
      totalDurationSec: durationSec || undefined,
      onProgress: (p: FfmpegProgress) => {
        if (p.percent != null) progressTo(sender, jobId, Math.max(6, Math.min(99, p.percent)), 'Rendering…')
      }
    })
    if (bake.exitCode !== 0) {
      return fail(bake.stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with code ${bake.exitCode}`)
    }
    progressTo(sender, jobId, 100, 'Done')
    const resultPreview = await renderPreview(outAbs, 0)
    return { ok: true, outputPath: outRel, resultPreview: resultPreview ?? '', url: pathToFileURL(outAbs).href }
  } catch (err) {
    return fail(toErrorMessage(err))
  } finally {
    if (subTmp) await rm(subTmp, { force: true }).catch(() => {})
  }
}

// ── Vision self-correction ───────────────────────────────────────────────────
// The model-calling critique lives in ./editor-vision (shared with the agent tools).

// ── Registration ───────────────────────────────────────────────────────────────

export function registerEditorIpc(): void {
  ipcMain.handle(IpcChannel.EditorListMedia, () => listMedia())
  ipcMain.handle(IpcChannel.EditorOpenPhoto, (_e, rel: string) => openPhoto(rel))
  ipcMain.handle(IpcChannel.EditorOpenVideo, (_e, rel: string) => openVideo(rel))
  ipcMain.handle(IpcChannel.EditorFrameAt, (_e, rel: string, atSec: number) => frameAt(rel, atSec))
  ipcMain.handle(IpcChannel.EditorBakePhoto, (e, rel: string, adjust: unknown, jobId: string, output?: string) =>
    bakePhoto(e.sender, rel, adjust, jobId, output)
  )
  ipcMain.handle(IpcChannel.EditorBakeVideo, (e, plan: unknown, jobId: string) => bakeVideo(e.sender, plan, jobId))
  ipcMain.handle(IpcChannel.EditorCritique, (_e, req: StudioCritiqueRequest) => runCritique(req))
}


