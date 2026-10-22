import { type ReactNode, useRef } from 'react'
import type { PhotoAdjust } from '@shared/types'
import { useEditorStore } from '../store/useEditorStore'
import { usePreviewStore } from '../store/usePreviewStore'
import { useEditorPlayer } from '../hooks/useEditorPlayer'
import { cssFilterFor, vignetteOpacity } from '../lib/editor-preview'
import { PhotoEditor } from './PhotoEditor'
import { VideoEditor } from './VideoEditor'
import { VirtualCursor } from './VirtualCursor'
import { StudioPhoto } from './StudioPhoto'
import { StudioVideo } from './StudioVideo'

/**
 * Myto's "watch me edit" pane (Build mode). It plays back a photo/video edit Myto is
 * performing: a source preview appears, Myto drives a Lightroom-style (photo) or
 * CapCut-style (video) UI live, a render bar tracks the real FFmpeg bake, and finally a
 * before/after compare shows the authoritative result. State comes entirely from
 * {@link useEditorStore}, fed by `editor` stream chunks (no extra IPC).
 *
 * This is the Phase-1 shell: it already handles every stream phase (open → script →
 * progress → baked / error), the before/after compare, and handing video playback to
 * the Preview pane. The rich Lightroom panel ({@link PhotoEditor}) and CapCut timeline
 * ({@link VideoEditor}) with the live-driven canvas slot into {@link EditorStage} in
 * Phases 2–3.
 */

/** A compact header control button (matches FilesPane/PreviewPane's PaneButton). */
function PaneButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  )
}

/** The render-progress bar shown while the real FFmpeg bake runs. */
function RenderBar({ pct, label }: { pct: number; label: string }): ReactNode {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="shrink-0 border-t border-border bg-surface px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span className="truncate">{label || 'Rendering…'}</span>
        <span className="ml-2 shrink-0 font-mono">{Math.round(clamped)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

/**
 * The center stage. Until Myto finishes the bake it shows the source preview (Phases
 * 2–3 replace this with the live-driven Lightroom/CapCut editor); after `baked` it
 * shows a before/after compare and, for video, a "Play in Preview" button.
 */
function EditorStage({ live }: { live: PhotoAdjust | null }): ReactNode {
  const kind = useEditorStore((s) => s.kind)
  const source = useEditorStore((s) => s.source)
  const baked = useEditorStore((s) => s.baked)
  const compare = useEditorStore((s) => s.compare)
  const select = useEditorStore((s) => s.select)
  const previewShow = usePreviewStore((s) => s.show)

  if (!source) {
    return (
      <div className="grid min-h-0 min-w-0 flex-1 place-items-center px-4 text-center text-[12px] text-muted">
        No edit in progress. When Myto edits a photo or video, you'll watch it happen here.
      </div>
    )
  }

  // Before the bake we show the SOURCE with Myto's live approximation layered on (CSS
  // filter + vignette + rotate); after the bake, the compare toggle picks the untouched
  // source ("before") vs the authoritative baked result ("after", shown plain).
  const showingResult = baked !== null && compare === 'after'
  const livePreview = !baked && live !== null
  const imageSrc = showingResult && baked ? baked.resultPreview : source.preview
  const vig = livePreview && live ? vignetteOpacity(live) : 0

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-black/40 p-3">
        <div className="relative inline-flex max-h-full max-w-full">
          <img
            src={imageSrc}
            alt={showingResult ? 'Edited result' : 'Source'}
            className="max-h-full max-w-full rounded-md object-contain shadow-lg"
            style={
              livePreview && live
                ? { filter: cssFilterFor(live), transform: live.rotate ? `rotate(${live.rotate}deg)` : undefined }
                : undefined
            }
          />
          {vig > 0 && (
            <div
              className="pointer-events-none absolute inset-0 rounded-md"
              style={{
                background:
                  live && live.vignette < 0
                    ? `radial-gradient(ellipse at center, rgba(255,255,255,0) 42%, rgba(255,255,255,${vig}) 100%)`
                    : `radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,${vig}) 100%)`
              }}
            />
          )}
        </div>
      </div>

      {baked && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => select('before')}
              className={`px-2.5 py-1 text-[11px] transition-colors ${
                compare === 'before' ? 'bg-primary text-white' : 'text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              Before
            </button>
            <button
              type="button"
              onClick={() => select('after')}
              className={`px-2.5 py-1 text-[11px] transition-colors ${
                compare === 'after' ? 'bg-primary text-white' : 'text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              After
            </button>
          </div>
          {baked.outputPath && (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={baked.outputPath}>
              {baked.outputPath}
            </span>
          )}
          {kind === 'video' && baked.url && (
            <button
              type="button"
              onClick={() => previewShow({ kind: 'url', url: baked.url as string, title: baked.outputPath || 'Result' })}
              className="ml-auto shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] text-white transition-opacity hover:opacity-90"
            >
              ▶ Play in Preview
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function EditorPane(): ReactNode {
  const kind = useEditorStore((s) => s.kind)
  const title = useEditorStore((s) => s.title)
  const mode = useEditorStore((s) => s.mode)
  const progress = useEditorStore((s) => s.progress)
  const error = useEditorStore((s) => s.error)
  const close = useEditorStore((s) => s.close)
  const closeManual = useEditorStore((s) => s.closeManual)
  const player = useEditorPlayer()
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const manualMode = mode === 'manual'
  const kindLabel = manualMode
    ? kind === 'photo'
      ? 'Photo · Studio'
      : 'Video · Studio'
    : kind === 'photo'
      ? 'Photo · Lightroom'
      : kind === 'video'
        ? 'Video · CapCut'
        : 'Editor'
  const live = player.playback?.adjust ?? null

  return (
    <div className="flex h-full flex-col border-l border-border bg-bg">
      {/* Header: identity on the left, controls on the right. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center text-muted">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 3.5h12a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <circle cx="5.5" cy="6.5" r="1.1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2 11l3.2-3 2.3 2 3-3.3L14.5 11" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text">{title || 'Editor'}</div>
          <div className="text-[10px] text-muted">{kindLabel}</div>
        </div>
        <PaneButton label="Close editor" onClick={manualMode ? closeManual : close}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </PaneButton>
      </div>

      {/* Body: the manual Studio (user-driven) or the agent's "watch me edit" playback. */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        {manualMode ? (
          kind === 'video' ? (
            <StudioVideo />
          ) : (
            <StudioPhoto />
          )
        ) : kind === 'video' ? (
          <VideoEditor player={player} />
        ) : (
          <>
            <EditorStage live={live} />
            {kind === 'photo' && <PhotoEditor player={player} />}
          </>
        )}
        {!manualMode && <VirtualCursor player={player} bodyRef={bodyRef} />}
      </div>
      {!manualMode && progress && <RenderBar pct={progress.pct} label={progress.label} />}
      {!manualMode && error && (
        <div className="shrink-0 border-t border-border bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
          {error}
        </div>
      )}
    </div>
  )
}
