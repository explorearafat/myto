import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../store/useEditorStore'
import { evalPhotoScriptAt, evalVideoScriptAt, type LivePlayback, type VideoPlayback } from '../lib/editor-preview'

/**
 * The rAF playback engine for the "watch Myto edit" pane. It consumes the
 * {@link EditorScript} the `edit_photo`/`edit_video` tool streamed into {@link
 * useEditorStore} and advances a wall-clock each animation frame, evaluating the
 * choreography into a live state: for a photo a {@link LivePlayback} (slider values
 * mid-sweep, the active panel, a curve mid-draw); for a video a {@link VideoPlayback}
 * (clips/captions laid down so far, the grade value, the playhead position). Both report
 * the virtual cursor's target + glide progress, surfaced on the unified
 * {@link EditorPlayer.cursorControl}/{@link EditorPlayer.cursorProgress} so
 * {@link VirtualCursor} is kind-agnostic.
 *
 * For a photo it also publishes the live {@link PhotoAdjust} back to the store so the
 * Lightroom panel, histogram and center canvas all read one source of truth, and hands
 * callers a control-ref registry so the cursor overlay can look up each control's live DOM
 * rect by its semantic id. When the real baked result lands the clock jumps to the end so
 * the panels rest on the final target values. The pure evaluation lives in
 * {@link evalPhotoScriptAt}/{@link evalVideoScriptAt}; this hook only owns the clock + refs.
 */
export interface EditorPlayer {
  /** The live photo playback this frame, or null when the active script isn't a photo. */
  playback: LivePlayback | null
  /** The live video playback this frame, or null when the active script isn't a video. */
  videoPlayback: VideoPlayback | null
  /** The semantic id the virtual cursor targets now (either kind), or null. */
  cursorControl: string | null
  /** 0..1 glide progress toward {@link cursorControl}. */
  cursorProgress: number
  /** True while the animation clock is still advancing. */
  playing: boolean
  /** Current clock position in ms (0..totalMs). */
  elapsedMs: number
  /** Register (or clear, with null) a control element under its semantic id. */
  registerControl: (id: string, el: HTMLElement | null) => void
  /** The live id→element registry, for the cursor overlay to read DOM rects from. */
  controls: React.MutableRefObject<Map<string, HTMLElement>>
}

export function useEditorPlayer(): EditorPlayer {
  const script = useEditorStore((s) => s.script)
  const baked = useEditorStore((s) => s.baked)
  const setLive = useEditorStore((s) => s.setLive)

  const [elapsedMs, setElapsedMs] = useState(0)
  const controls = useRef<Map<string, HTMLElement>>(new Map())
  const rafRef = useRef(0)

  const isPhoto = script?.kind === 'photo'
  const isVideo = script?.kind === 'video'
  const totalMs = script?.totalMs ?? 0

  // Drive the clock for ANY active script. A fresh script restarts from 0; once the bake
  // result arrives we jump straight to the end so the panels + canvas rest on the final
  // values (the before/after compare takes over the image).
  useEffect(() => {
    if (!script) {
      setElapsedMs(0)
      return
    }
    if (baked) {
      setElapsedMs(totalMs)
      return
    }
    let active = true
    const start = performance.now()
    const loop = (now: number): void => {
      if (!active) return
      const e = Math.min(now - start, totalMs)
      setElapsedMs(e)
      if (e < totalMs) rafRef.current = requestAnimationFrame(loop)
    }
    setElapsedMs(0)
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [script, baked, totalMs])

  const playback = useMemo<LivePlayback | null>(
    () => (script && isPhoto ? evalPhotoScriptAt(script, elapsedMs) : null),
    [script, isPhoto, elapsedMs]
  )
  const videoPlayback = useMemo<VideoPlayback | null>(
    () => (script && isVideo ? evalVideoScriptAt(script, elapsedMs) : null),
    [script, isVideo, elapsedMs]
  )

  // Publish the live photo approximation so every panel reads the same source of truth.
  // (Video has no PhotoAdjust; the VideoEditor reads videoPlayback directly.)
  useEffect(() => {
    setLive(playback ? playback.adjust : null)
  }, [playback, setLive])

  const registerControl = useCallback((id: string, el: HTMLElement | null): void => {
    if (el) controls.current.set(id, el)
    else controls.current.delete(id)
  }, [])

  const cursorControl = playback?.cursorControl ?? videoPlayback?.cursorControl ?? null
  const cursorProgress = playback?.cursorProgress ?? videoPlayback?.cursorProgress ?? 1

  return {
    playback,
    videoPlayback,
    cursorControl,
    cursorProgress,
    playing: !!script && !baked && elapsedMs < totalMs,
    elapsedMs,
    registerControl,
    controls
  }
}
