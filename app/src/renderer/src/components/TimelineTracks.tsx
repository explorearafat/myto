import { type ReactNode, useCallback } from 'react'
import type { EditorClip, EditorTextClip, EditorAudioClip } from '@shared/types'
import type { EditorPlayer } from '../hooks/useEditorPlayer'
import { useEditorStore } from '../store/useEditorStore'

/**
 * The CapCut-style timeline Myto drives while editing a video: a time ruler over a video
 * track, a text/caption track and an audio track, with a sweeping playhead. Each clip and
 * caption registers its DOM element under the SAME semantic id the choreography uses
 * ('clip-0', 'text-0', 'playhead') so {@link VirtualCursor} can glide onto it; clips/captions
 * appear "ghosted" until Myto's add-clip/add-text step has laid them down, then light up —
 * the progressive reveal is what the user watches. Display-only: all live state comes from
 * {@link EditorPlayer.videoPlayback}; the player owns the clock.
 */
function isVideoClip(c: EditorClip | EditorTextClip | EditorAudioClip): c is EditorClip {
  return c.track === 'video'
}
function isTextClip(c: EditorClip | EditorTextClip | EditorAudioClip): c is EditorTextClip {
  return c.track === 'text'
}
function isAudioClip(c: EditorClip | EditorTextClip | EditorAudioClip): c is EditorAudioClip {
  return c.track === 'audio'
}

/** A time tick label (whole seconds) for the ruler. */
function ticks(dur: number): number[] {
  const step = dur <= 6 ? 1 : dur <= 20 ? 5 : 10
  const out: number[] = []
  for (let s = 0; s <= dur + 0.001; s += step) out.push(Math.round(s))
  return out
}

export function TimelineTracks({ player }: { player: EditorPlayer }): ReactNode {
  const timeline = useEditorStore((s) => s.script?.timeline ?? null)
  const vp = player.videoPlayback
  const reg = player.registerControl
  const setPlayheadRef = useCallback((el: HTMLElement | null) => reg('playhead', el), [reg])

  if (!timeline) return null
  const dur = Math.max(0.1, timeline.durationSec)
  const left = (sec: number): string => `${Math.max(0, Math.min(100, (sec / dur) * 100))}%`
  const width = (a: number, b: number): string => `${Math.max(1, Math.min(100, ((b - a) / dur) * 100))}%`

  const videoClips = timeline.tracks.flatMap((t) => t.clips).filter(isVideoClip)
  const textClips = timeline.tracks.flatMap((t) => t.clips).filter(isTextClip)
  const audioClips = timeline.tracks.flatMap((t) => t.clips).filter(isAudioClip)

  const clipsPlaced = vp?.clipsPlaced ?? videoClips.length
  const textsPlaced = vp?.textsPlaced ?? textClips.map((c) => c.id)
  const playheadSec = vp?.playheadSec ?? 0
  const showPlayhead = (vp?.playheadSec ?? 0) > 0 || !vp

  return (
    <div className="shrink-0 border-t border-border bg-surface px-3 pb-2 pt-1.5">
      {/* Ruler */}
      <div className="relative mb-1 h-4 text-[9px] text-muted">
        {ticks(dur).map((s) => (
          <span key={s} className="absolute -translate-x-1/2 font-mono" style={{ left: left(s) }}>
            {s}s
          </span>
        ))}
      </div>

      <div className="relative">
        {/* Video track */}
        <div className="relative mb-1 h-10 rounded bg-surface-2/60">
          {videoClips.map((clip, i) => {
            const placed = i < clipsPlaced
            return (
              <div
                key={clip.id}
                ref={(el) => reg(clip.id, el)}
                className={`absolute top-0 flex h-full flex-col justify-between overflow-hidden rounded border p-1 transition-all ${
                  placed
                    ? 'border-primary/70 bg-primary/20'
                    : 'border-dashed border-border bg-transparent opacity-40'
                }`}
                style={{ left: left(clip.startSec), width: width(clip.startSec, clip.endSec) }}
              >
                <span className="truncate text-[9px] text-text">{clip.label ?? `Clip ${i + 1}`}</span>
                <div className="flex items-center gap-1">
                  {clip.speed && clip.speed !== 1 && (
                    <span className="rounded bg-black/30 px-1 text-[8px] font-mono text-text">{clip.speed}×</span>
                  )}
                  {clip.grade && (
                    <span className="truncate rounded bg-primary/40 px-1 text-[8px] text-text">{clip.grade}</span>
                  )}
                </div>
              </div>
            )
          })}
          {/* Boundaries (cuts / transitions) between placed clips. */}
          {vp?.boundaries.map((b, i) => (
            <div key={i} className="absolute top-0 h-full" style={{ left: left(b.atSec) }}>
              {b.kind === 'transition' ? (
                <span className="absolute -top-0.5 -translate-x-1/2 rounded bg-amber-400/90 px-1 text-[8px] text-black">
                  ⨝ {b.name}
                </span>
              ) : (
                <span className="absolute top-0 h-full w-px -translate-x-1/2 bg-amber-400/90" />
              )}
            </div>
          ))}
        </div>

        {/* Text track */}
        <div className="relative mb-1 h-7 rounded bg-surface-2/60">
          {textClips.map((clip) => {
            const placed = textsPlaced.includes(clip.id)
            return (
              <div
                key={clip.id}
                ref={(el) => reg(clip.id, el)}
                className={`absolute top-0 flex h-full items-center overflow-hidden rounded border px-1 transition-all ${
                  placed ? 'border-sky-400/70 bg-sky-400/20' : 'border-dashed border-border opacity-40'
                }`}
                style={{ left: left(clip.startSec), width: width(clip.startSec, clip.endSec) }}
              >
                <span className="truncate text-[9px] text-text">T {clip.text}</span>
              </div>
            )
          })}
          {textClips.length === 0 && (
            <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[9px] text-muted">Text</span>
          )}
        </div>

        {/* Audio track */}
        <div className="relative h-7 rounded bg-surface-2/60">
          {audioClips.map((clip) => (
            <div
              key={clip.id}
              className="absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded border border-emerald-400/60 bg-emerald-400/15 px-1"
              style={{ left: left(clip.startSec), width: width(clip.startSec, clip.endSec) }}
            >
              <span className="text-[9px]">{clip.muted ? '🔇' : '🔊'}</span>
              <span className="truncate text-[9px] text-text">
                {clip.label ?? 'Audio'}
                {typeof clip.volume === 'number' && clip.volume !== 100 ? ` · ${clip.volume}%` : ''}
              </span>
            </div>
          ))}
        </div>

        {/* Playhead across all tracks. */}
        {showPlayhead && (
          <div
            className="pointer-events-none absolute -top-5 bottom-0 z-10 w-px bg-red-500"
            style={{ left: left(playheadSec) }}
          >
            <span
              ref={setPlayheadRef}
              className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-red-500"
            />
          </div>
        )}
      </div>
    </div>
  )
}
