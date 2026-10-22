/**
 * Self-correction core (PURE) — the prompt + response parsing for Myto Studio's "look at the
 * result and fix it" loop. Given a goal, the edit applied so far, and (at call time) the baked
 * result image, a vision-capable model returns a short critique and, if the result misses the
 * goal, a CORRECTED full adjust (photo) or plan (video) to re-bake. No Electron, no model call
 * here — {@link editor-ipc} supplies the image and runs the completion; this file only builds
 * the text and parses the verdict, so it unit-tests without a provider.
 */
import type { PhotoAdjust, StudioVideoPlan, StudioCritiqueRequest } from '../../shared/types'
import { validatePhotoAdjust } from './photo-core'
import { validateEditPlan } from './ffmpeg-core'

/** The critic persona + the strict JSON contract both photo and video replies must follow. */
export const CRITIQUE_SYSTEM =
  "You are Myto's photo and video edit critic. You are shown the CURRENT edited result and told " +
  'the user\'s GOAL and the adjustment already applied. Judge honestly whether the result meets the ' +
  'goal. Reply with ONLY a single JSON object, no prose, no markdown fences.\n' +
  'For a PHOTO: {"done": boolean, "note": string, "adjust": { ...full Lightroom adjust... }}.\n' +
  'For a VIDEO: {"done": boolean, "note": string, "plan": {"operations": [ ... ]}}.\n' +
  'Rules: "done" is true when the result already satisfies the goal — then omit adjust/plan. ' +
  'When not done, return the COMPLETE corrected adjust/plan (absolute values, not deltas) so it can ' +
  're-bake from the original source. Keep "note" to one short friendly sentence describing what you ' +
  'changed or still see wrong. Photo adjust fields are each -100..100 (0 = neutral): exposure, ' +
  'contrast, highlights, shadows, whites, blacks, temp, tint, vibrance, saturation, clarity, sharpen, ' +
  'vignette; plus optional curve/hsl/crop/rotate. Be decisive; prefer finishing in few passes.'

/** Render the current edit compactly so the model can reason about what to change. */
function describeCurrent(req: StudioCritiqueRequest): string {
  if (req.kind === 'photo') {
    return JSON.stringify(req.current)
  }
  const plan = req.current as StudioVideoPlan
  return JSON.stringify({ operations: plan.operations ?? [] })
}

/** Build the user turn text (the baked image rides as a separate image part, added by the IPC). */
export function buildCritiqueUser(req: StudioCritiqueRequest): string {
  const kind = req.kind === 'photo' ? 'photo' : 'video'
  return (
    `GOAL: ${req.goal}\n` +
    `This is edit pass ${req.pass}. The ${kind} currently has this adjustment applied:\n` +
    `${describeCurrent(req)}\n` +
    `The attached image is the CURRENT ${kind === 'photo' ? 'result' : 'result (a frame of the result)'}. ` +
    `Does it meet the goal? Reply with the JSON object described in the system message.`
  )
}

/**
 * Extract the first balanced `{…}` object from a model reply (it may wrap the JSON in prose or
 * ```json fences despite instructions). Returns the substring or null if none is balanced.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** The parsed verdict (before the IPC wraps it into a {@link StudioCritiqueResult}). */
export interface ParsedCritique {
  done: boolean
  note: string
  adjust?: PhotoAdjust
  plan?: StudioVideoPlan
}

/**
 * Parse a critique reply into a verdict. Tolerant: finds the JSON object, reads `done`/`note`,
 * and validates any corrected `adjust` (photo) / `plan` (video) through the SAME validators the
 * bake uses, so a malformed correction is dropped rather than trusted. `fallbackInput` supplies
 * the video plan's `input` when the model omits it. Returns null when no JSON could be read.
 */
export function parseCritiqueResponse(
  kind: 'photo' | 'video',
  text: string,
  fallbackInput?: string
): ParsedCritique | null {
  const json = extractJsonObject(text)
  if (!json) return null
  let o: Record<string, unknown>
  try {
    const v = JSON.parse(json)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    o = v as Record<string, unknown>
  } catch {
    return null
  }
  const done = o.done === true
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 400) : ''
  if (kind === 'photo') {
    let adjust: PhotoAdjust | undefined
    if (!done && o.adjust) {
      const v = validatePhotoAdjust(o.adjust)
      if (v.ok) adjust = v.adjust
    }
    return { done, note, adjust }
  }
  let plan: StudioVideoPlan | undefined
  if (!done && o.plan && typeof o.plan === 'object') {
    const raw = { ...(o.plan as Record<string, unknown>) }
    if (!raw.input && fallbackInput) raw.input = fallbackInput
    const v = validateEditPlan(raw)
    if (v.ok) plan = v.plan as StudioVideoPlan
  }
  return { done, note, plan }
}
