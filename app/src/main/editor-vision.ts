/**
 * Vision self-correction (model-calling half) — shared by the manual Studio IPC
 * ({@link editor-ipc}) and the agent's edit_photo/edit_video tools. Given a baked result still
 * and a goal, it asks the configured model to critique the result and, if it misses, return a
 * corrected adjust/plan. The PURE prompt + parse live in {@link editor-critique-core}; this file
 * only resolves the provider and runs the completion, so it is typechecked but not unit-tested.
 */
import type { StudioCritiqueRequest, StudioCritiqueResult, ChatMessage, StudioVideoPlan } from '../shared/types'
import { getSettings } from './settings'
import { providerFromSettings } from './providers'
import { toErrorMessage } from './providers/http'
import { CRITIQUE_SYSTEM, buildCritiqueUser, parseCritiqueResponse } from './tools/editor-critique-core'

/** Split a `data:<mime>;base64,<data>` URL into the parts a {@link ChatMessage} image wants. */
export function dataUrlToImage(dataUrl: string): { mediaType: string; dataBase64: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!m) return null
  const mediaType = m[1] || 'image/jpeg'
  const dataBase64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), 'utf8').toString('base64')
  if (!dataBase64) return null
  return { mediaType, dataBase64 }
}

/**
 * Ask the configured model to critique a baked result against the goal. Resolves `ok:false`
 * (with a reason) when no model is configured or it can't produce a usable verdict — callers
 * then stop iterating and keep the last bake. Never throws.
 */
export async function runCritique(req: StudioCritiqueRequest, signal?: AbortSignal): Promise<StudioCritiqueResult> {
  const settings = getSettings()
  const modelId = settings.modelId
  if (!modelId) return { ok: false, note: '', done: true, reason: 'No model is configured for Myto to review the result.' }
  const image = typeof req.resultPreview === 'string' ? dataUrlToImage(req.resultPreview) : null
  if (!image) return { ok: false, note: '', done: true, reason: 'No result image was available to review.' }
  try {
    const provider = providerFromSettings(settings)
    const messages: ChatMessage[] = [
      { role: 'system', content: CRITIQUE_SYSTEM },
      { role: 'user', content: buildCritiqueUser(req), images: [image] }
    ]
    const text = await provider.getCompletion(modelId, messages, undefined, signal)
    const fallbackInput = req.kind === 'video' ? (req.current as StudioVideoPlan).input : undefined
    const parsed = parseCritiqueResponse(req.kind, text, fallbackInput)
    if (!parsed) return { ok: false, note: '', done: true, reason: 'Myto could not read a verdict from the model.' }
    return { ok: true, note: parsed.note, done: parsed.done, adjust: parsed.adjust, plan: parsed.plan }
  } catch (err) {
    return { ok: false, note: '', done: true, reason: toErrorMessage(err) }
  }
}
