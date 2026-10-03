import { type ReactNode, useCallback } from 'react'
import type { EditorClip, EditorTextClip, EditorAudioClip, EditorPanel } from '@shared/types'
import type { EditorPlayer } from '../hooks/useEditorPlayer'
import { useEditorStore } from '../store/useEditorStore'
import { usePreviewStore } from '../store/usePreviewStore'
import { videoGradeFilter } from '../lib/editor-preview'
import { TimelineTracks } from './TimelineTracks'

/**
 * The CapCut-style editor Myto drives while editing a video. A program monitor shows the
 * source poster with the live colour-grade approximation ({@link videoGradeFilter}) layered
 * on and captions popping in as the playhead sweeps over them; an Effects panel carries the
 * grade slider (registered under the semantic id 'grade' so {@link VirtualCursor} can glide
 * onto it); and {@link TimelineTracks} lays out the video/text/audio tracks + playhead below.
 * Display-only — the live grade/playhead/caption state all come from
 * {@link EditorPlayer.videoPlayback}; the authoritative look is the FFmpeg bake, shown
 * before/after once it lands (video playback itself opens in the Preview pane).
 */
function isTextClip(c: EditorClip | EditorTextClip | EditorAudioClip): c is EditorTextClip {
  return c.track === 'text'
}

const TABS: Array<{ id: EditorPanel; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'effects', label: 'Effects' },
  { id: 'text', label: 'Text' }
]

export function VideoEditor({ player }: { player: EditorPlayer }): ReactNode {
  const source = useEditorStore((s) => s.source)
  const baked = useEditorStore((s) => s.baked)
  const compare = useEditorStore((s) => s.compare)
  const select = useEditorStore((s) => s.select)
  const timeline = useEditorStore((s) => s.script?.timeline ?? null)
  const previewShow = usePreviewStore((s) => s.show)
  const vp = player.videoPlayback
  const reg = player.registerControl
  const setGradeRef = useCallback((el: HTMLElement | null) => reg('grade', el), [reg])

  const grade = vp?.grade ?? 0
  const gradeName = vp?.gradeName ?? null
  const playheadSec = vp?.playheadSec ?? 0
  const panel: EditorPanel = vp?.activePanel ?? 'timeline'
  const gradeActive = vp?.activeControl === 'grade'

  const textClips = timeline?.tracks.flatMap((t) => t.clips).filter(isTextClip) ?? []
  const textsPlaced = vp?.textsPlaced ?? textClips.map((c) => c.id)

  const showingResult = baked !== null && compare === 'after'
  const livePreview = !baked
  const imageSrc = showingResult && baked ? baked.resultPreview : source?.preview ?? ''
  // Captions ride the live monitor only (the baked result already has them burned in).
  const liveCaptions = livePreview
    ? textClips.filter((c) => textsPlaced.includes(c.id) && playheadSec >= c.startSec && playheadSec <= c.endSec)
    : []

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Program monitor */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-black/60 p-3">
            <div className="relative inline-flex max-h-full max-w-full">
              {imageSrc ? (
                <img
                  src={imageSrc}
                  alt={showingResult ? 'Edited result' : 'Source'}
                  className="max-h-full max-w-full rounded-md object-contain shadow-lg"
                  style={livePreview ? { filter: videoGradeFilter(gradeName, grade) } : undefined}
                />
              ) : (
                <div className="grid h-40 w-72 place-items-center rounded-md bg-surface-2 text-[11px] text-muted">
                  Loading preview…
                </div>
              )}
              {liveCaptions.map((c) => (
                <span
                  key={c.id}
                  className="pointer-events-none absolute max-w-[90%] truncate rounded px-1.5 py-0.5 text-center font-semibold leading-tight"
                  style={{
                    left: `${(c.x ?? 0.5) * 100}%`,
                    top: `${(c.y ?? 0.85) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    fontSize: `${Math.max(10, (c.fontSize ?? 32) * 0.4)}px`,
                    color: c.color ?? '#ffffff',
                    background: c.box ? 'rgba(0,0,0,0.5)' : 'transparent',
                    textShadow: c.box ? 'none' : '0 1px 2px rgba(0,0,0,0.9)'
                  }}
                >
                  {c.text}
                </span>
              ))}
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
              {baked.url && (
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

        {/* Effects panel — the grade control Myto drives (CapCut's right rail). */}
        <div className="flex w-52 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex shrink-0 gap-1 border-b border-border px-2 py-1.5">
            {TABS.map((t) => (
              <div
                key={t.id}
                className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                  panel === t.id ? 'bg-primary text-white' : 'text-muted'
                }`}
              >
                {t.label}
              </div>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="px-0.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">Colour grade</div>
            <div className="mb-0.5 flex items-center justify-between text-[10px]">
              <span className={gradeActive ? 'text-primary' : 'text-muted'}>{gradeName ?? 'None'}</span>
              <span className={`font-mono ${grade !== 0 ? 'text-text' : 'text-muted'}`}>{Math.round(grade)}</span>
            </div>
            <div ref={setGradeRef} className={`relative h-1.5 rounded-full bg-surface-2 ${gradeActive ? 'ring-1 ring-primary/60' : ''}`}>
              <div className="absolute left-0 top-0 h-full rounded-full bg-primary/70" style={{ width: `${Math.max(0, Math.min(100, grade))}%` }} />
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-white shadow"
                style={{ left: `${Math.max(0, Math.min(100, grade))}%` }}
              />
            </div>
            {gradeName && (
              <p className="mt-2 text-[9px] leading-snug text-muted">
                Live preview is an approximation — the exported file carries the full “{gradeName}” grade.
              </p>
            )}
          </div>
        </div>
      </div>

      <TimelineTracks player={player} />
    </div>
  )
}
