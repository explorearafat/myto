import { useCallback, useEffect, useRef } from 'react'
import type { PhotoAdjust, StudioVideoOp, StudioVideoPlan, StudioCritiqueRequest } from '@shared/types'
import { useEditorStore, type ManualVideoEdit, type EditorBaked } from '../store/useEditorStore'

/**
 * Compile the structured manual video edit into the {@link StudioVideoPlan} the bake validates.
 * Pure + exported so it unit-tests. Emits ops only for non-neutral settings, in the same order
 * `ffmpeg-core.compileEditPlan` expects (trim → speed → look → reframe → audio → captions).
 */
export function buildVideoPlan(path: string, v: ManualVideoEdit, durationSec: number): StudioVideoPlan {
  const ops: StudioVideoOp[] = []
  if (v.trim && (v.trim.start > 0.01 || v.trim.end < durationSec - 0.01)) {
    ops.push({ op: 'trim', start: Math.max(0, v.trim.start), end: Math.max(v.trim.start + 0.1, v.trim.end) })
  }
  if (v.speed !== 1) ops.push({ op: 'speed', factor: v.speed })
  if (v.filter && v.filter !== 'none') ops.push({ op: 'filter', name: v.filter })
  if (v.aspect) ops.push({ op: 'resize', aspect: v.aspect, mode: 'crop' })
  if (v.mute) ops.push({ op: 'mute' })
  else if (v.volume !== 100) ops.push({ op: 'volume', factor: v.volume / 100 })
  for (const t of v.texts) {
    if (!t.text.trim()) continue
    ops.push({ op: 'text', text: t.text, start: t.startSec, end: t.endSec, y: t.y, box: t.box, color: t.color })
  }
  return { input: path, operations: ops }
}

/** How many critique → re-bake rounds the self-correct loop runs before giving up. */
const MAX_AUTO_PASSES = 3

/**
 * The bake + self-correct engine for the manual Studio. Subscribes to bake-progress ticks and
 * exposes `exportPhoto`/`exportVideo` (one authoritative ffmpeg bake) and `autoFix` (bake, then
 * ask a vision model to critique against the goal and re-bake the correction, up to a few passes).
 * All state lands back on {@link useEditorStore} so the pane + canvas react.
 */
export function useStudioBake(): {
  exportPhoto: () => Promise<void>
  exportVideo: () => Promise<void>
  autoFix: () => Promise<void>
} {
  const jobRef = useRef(`job-${Date.now().toString(36)}`)
  // True only while a bake is in flight, so a progress tick that arrives after the bake has
  // already resolved (and the baked result is shown) can't re-raise the progress bar.
  const activeRef = useRef(false)

  // Route progress ticks for OUR jobId into the store (ignored once the bake has resolved).
  useEffect(() => {
    const off = window.myto.editor.onBakeProgress((p) => {
      if (p.jobId === jobRef.current && activeRef.current) {
        useEditorStore.getState().setManualProgress({ pct: p.pct, label: p.label })
      }
    })
    return off
  }, [])

  const exportPhoto = useCallback(async () => {
    const m = useEditorStore.getState().manual
    if (!m || m.kind !== 'photo') return
    const store = useEditorStore.getState()
    store.setManualError(null)
    store.setManualProgress({ pct: 1, label: 'Starting…' })
    useEditorStore.setState({ pinned: true })
    activeRef.current = true
    const res = await window.myto.editor.bakePhoto(m.path, m.adjust, jobRef.current)
    activeRef.current = false
    if (res.ok) {
      const baked: EditorBaked = { kind: 'photo', resultPreview: res.resultPreview, outputPath: res.outputPath, url: res.url }
      store.setManualBaked(baked)
    } else {
      store.setManualError(res.error)
    }
  }, [])

  const exportVideo = useCallback(async () => {
    const m = useEditorStore.getState().manual
    if (!m || m.kind !== 'video' || !m.video) return
    const store = useEditorStore.getState()
    const plan = buildVideoPlan(m.path, m.video, m.durationSec ?? 0)
    if (plan.operations.length === 0) {
      store.setManualError('No edits yet — trim, grade, caption, or reframe first.')
      return
    }
    store.setManualError(null)
    store.setManualProgress({ pct: 1, label: 'Starting…' })
    useEditorStore.setState({ pinned: true })
    activeRef.current = true
    const res = await window.myto.editor.bakeVideo(plan, jobRef.current)
    activeRef.current = false
    if (res.ok) {
      const baked: EditorBaked = { kind: 'video', resultPreview: res.resultPreview, outputPath: res.outputPath, url: res.url }
      store.setManualBaked(baked)
    } else {
      store.setManualError(res.error)
    }
  }, [])

  const autoFix = useCallback(async () => {
    const store = useEditorStore.getState()
    const m0 = store.manual
    if (!m0) return
    const goal = m0.goal.trim()
    if (!goal) {
      store.setAutoNote('Type what you want first, e.g. "make it warm and cinematic".')
      return
    }
    store.setAutoRunning(true)
    store.setAutoNote('Myto is reviewing the result…')
    try {
      for (let pass = 1; pass <= MAX_AUTO_PASSES; pass++) {
        // 1) Make sure there is a fresh baked result to look at.
        if (m0.kind === 'photo') await exportPhoto()
        else await exportVideo()
        const m = useEditorStore.getState().manual
        if (!m || !m.baked || !m.baked.resultPreview) {
          store.setAutoNote('Myto could not render a result to review.')
          break
        }
        // 2) Critique the baked result against the goal.
        const req: StudioCritiqueRequest = {
          goal,
          kind: m.kind,
          resultPreview: m.baked.resultPreview,
          current: m.kind === 'photo' ? m.adjust : buildVideoPlan(m.path, m.video!, m.durationSec ?? 0),
          pass
        }
        const verdict = await window.myto.editor.critique(req)
        if (!verdict.ok) {
          store.setAutoNote(verdict.reason || 'A vision-capable model is needed for Myto to self-review.')
          break
        }
        if (verdict.done || (!verdict.adjust && !verdict.plan)) {
          store.setAutoNote(verdict.note || 'Looks good — matches your goal.')
          break
        }
        // 3) Apply the correction and loop (the next iteration re-bakes it).
        store.setAutoNote(verdict.note || `Refining (pass ${pass})…`)
        if (m.kind === 'photo' && verdict.adjust) {
          applyAdjust(verdict.adjust)
        } else if (m.kind === 'video' && verdict.plan) {
          applyVideoPlan(verdict.plan)
        } else {
          break
        }
      }
    } finally {
      useEditorStore.getState().setAutoRunning(false)
    }
  }, [exportPhoto, exportVideo])

  return { exportPhoto, exportVideo, autoFix }
}

/** Replace the manual photo adjust wholesale (used when the critic returns a corrected adjust). */
function applyAdjust(adjust: PhotoAdjust): void {
  const s = useEditorStore.getState()
  if (!s.manual) return
  useEditorStore.setState({ manual: { ...s.manual, adjust, dirty: true } })
}

/** Fold a critic-returned plan back into the structured manual video edit (best-effort). */
function applyVideoPlan(plan: StudioVideoPlan): void {
  const s = useEditorStore.getState()
  if (!s.manual || !s.manual.video) return
  const v: ManualVideoEdit = { ...s.manual.video, texts: [...s.manual.video.texts] }
  for (const op of plan.operations) {
    if (op.op === 'trim') v.trim = { start: op.start, end: op.end }
    else if (op.op === 'speed') v.speed = op.factor
    else if (op.op === 'filter') v.filter = op.name
    else if (op.op === 'resize') v.aspect = op.aspect
    else if (op.op === 'mute') v.mute = true
    else if (op.op === 'volume') v.volume = Math.round(op.factor * 100)
  }
  useEditorStore.setState({ manual: { ...s.manual, video: v, dirty: true } })
}
