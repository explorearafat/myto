import { type ReactNode, type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import type { StudioAspect } from '@shared/types'
import { useEditorStore, type ManualTextClip, type ManualVideoEdit } from '../store/useEditorStore'
import { usePreviewStore } from '../store/usePreviewStore'
import { useStudioBake } from '../hooks/useStudioBake'
import { videoGradeFilter } from '../lib/editor-preview'
import { Slider } from './StudioControls'

/**
 * The MANUAL video editor, styled as a master-copy of CapCut's desktop chrome: a near-black
 * theme with a blue accent, a large program player with a transport bar + timecode, a right
 * properties dock (Video / Audio / Text tabs), and a bottom timeline with a tool strip, a time
 * ruler, and video / text / audio track rows with a draggable clip, trim handles and playhead.
 * The edit compiles to a StudioVideoPlan; "Export" bakes the authoritative MP4 and "Auto-fix"
 * lets Myto review + correct it against a goal.
 *
 * CapCut palette: bg #0d0d0f · panel #1b1b20 · rail #141418 · player #000 · text #e6e6e6 ·
 *   muted #8a8a92 · accent #4e7cff · clip gradient #3b6fe0→#5a8bff.
 */
const FILTERS: Array<{ id: string; label: string }> = [
  { id: 'none', label: 'Original' }, { id: 'vivid', label: 'Vivid' }, { id: 'cinematic', label: 'Cinematic' },
  { id: 'warm', label: 'Warm' }, { id: 'cool', label: 'Cool' }, { id: 'mono', label: 'Mono' },
  { id: 'bw', label: 'B&W' }, { id: 'vintage', label: 'Vintage' }, { id: 'fade', label: 'Fade' },
  { id: 'sepia', label: 'Sepia' }, { id: 'noir', label: 'Noir' }
]
const SPEEDS = [0.5, 1, 1.5, 2]
const ASPECTS: Array<{ label: string; value: StudioAspect | null }> = [
  { label: 'Original', value: null }, { label: '9:16', value: '9:16' }, { label: '1:1', value: '1:1' },
  { label: '4:5', value: '4:5' }, { label: '16:9', value: '16:9' }
]
type VTab = 'video' | 'audio' | 'text'

function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  const cs = Math.floor((s - Math.floor(s)) * 100)
  return `${m}:${r.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

// STUDIO_VIDEO_BODY

export function StudioVideo(): ReactNode {
  const m = useEditorStore((s) => s.manual)
  const patchVideo = useEditorStore((s) => s.patchVideo)
  const addText = useEditorStore((s) => s.addText)
  const removeText = useEditorStore((s) => s.removeText)
  const setPlayhead = useEditorStore((s) => s.setPlayhead)
  const selectManual = useEditorStore((s) => s.selectManual)
  const setGoal = useEditorStore((s) => s.setGoal)
  const previewShow = usePreviewStore((s) => s.show)
  const { exportVideo, autoFix } = useStudioBake()

  const [frame, setFrame] = useState('')
  const [caption, setCaption] = useState('')
  const [tab, setTab] = useState<VTab>('video')
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef(0)

  const path = m?.path ?? ''
  useEffect(() => {
    setFrame(m?.sourcePreview ?? '')
  }, [m?.sourcePreview])

  const fetchFrame = useCallback(
    async (sec: number) => {
      if (!path) return
      const url = await window.myto.editor.frameAt(path, sec)
      if (url) setFrame(url)
    },
    [path]
  )

  // Lightweight transport: play advances the playhead across the kept range in real time
  // (the program frame refreshes when you pause/scrub — decoding every tick would thrash ffmpeg).
  const trimStart = m?.video?.trim?.start ?? 0
  const trimEnd = m?.video?.trim?.end ?? (m?.durationSec || 10)
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = (now - last) / 1000
      last = now
      const cur = useEditorStore.getState().manual?.playheadSec ?? 0
      const next = cur + dt * (m?.video?.speed ?? 1)
      if (next >= trimEnd) {
        setPlayhead(trimEnd)
        setPlaying(false)
        return
      }
      setPlayhead(next < trimStart ? trimStart : next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, trimStart, trimEnd, m?.video?.speed, setPlayhead])

  if (!m || m.kind !== 'video' || !m.video) return null
  const v = m.video
  const duration = m.durationSec && m.durationSec > 0 ? m.durationSec : v.trim?.end ?? 10
  const { baked, compare, progress, error, playheadSec, goal, autoNote, autoRunning } = m
  const showAfter = baked && compare === 'after'
  const showBefore = baked && compare === 'before'
  const activeTexts = v.texts.filter((t) => playheadSec >= t.startSec && playheadSec <= t.endSec)

  const togglePlay = (): void => {
    if (!playing && playheadSec >= trimEnd - 0.05) setPlayhead(trimStart)
    setPlaying((p) => !p)
  }
  const seek = (sec: number): void => {
    setPlaying(false)
    setPlayhead(sec)
    void fetchFrame(sec)
  }
  const addCaptionNow = (): void => {
    const text = caption.trim()
    if (!text) return
    addText({
      id: `t-${Date.now().toString(36)}`,
      text,
      startSec: Math.round(playheadSec * 10) / 10,
      endSec: Math.round(Math.min(duration, playheadSec + 3) * 10) / 10,
      y: 'bottom',
      box: true,
      color: '#ffffff'
    })
    setCaption('')
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-[#0d0d0f] text-[#e6e6e6]"
      style={{ '--studio-accent': '#4e7cff' } as CSSProperties}
    >
      {/* Top bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/60 bg-[#141418] px-3">
        <span className="text-[11px] font-semibold text-[#e6e6e6]">CapCut Studio</span>
        <span className="text-[10px] text-[#8a8a92]">· {m.path.split('/').pop()}</span>
        <button type="button" onClick={exportVideo} disabled={!!progress}
          className="ml-auto rounded-md bg-[#4e7cff] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40">
          {progress ? 'Exporting…' : 'Export'}
        </button>
      </div>

      {/* Player + properties */}
      <div className="@container flex min-h-0 flex-1 flex-col @[560px]:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative grid min-h-0 flex-1 place-items-center bg-black p-3">
            <div className="relative inline-flex max-h-full max-w-full">
              <img
                src={showAfter ? baked!.resultPreview : showBefore ? m.sourcePreview : frame || m.sourcePreview}
                alt={showAfter ? 'Edited result' : 'Program'}
                className="max-h-full max-w-full rounded object-contain"
                style={!baked ? { filter: videoGradeFilter(v.filter === 'none' ? null : v.filter, 100) } : undefined}
              />
              {!baked && activeTexts.map((t) => (
                <span key={t.id}
                  className="pointer-events-none absolute left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded px-2 py-0.5 text-center text-[14px] font-semibold"
                  style={{
                    top: t.y === 'top' ? '8%' : t.y === 'center' ? '46%' : undefined,
                    bottom: t.y === 'bottom' ? '8%' : undefined,
                    color: t.color,
                    background: t.box ? 'rgba(0,0,0,0.55)' : 'transparent',
                    textShadow: t.box ? 'none' : '0 1px 3px rgba(0,0,0,0.9)'
                  }}>{t.text}</span>
              ))}
            </div>
          </div>
          {/* Transport */}
          <div className="flex h-10 shrink-0 items-center gap-3 border-t border-black/60 bg-[#141418] px-3">
            <button type="button" onClick={() => seek(trimStart)} aria-label="Jump to start" className="text-[#c9c9cf] hover:text-white">⏮</button>
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
              className="grid h-7 w-7 place-items-center rounded-full bg-[#4e7cff] text-white hover:opacity-90">{playing ? '❚❚' : '▶'}</button>
            <button type="button" onClick={() => seek(trimEnd)} aria-label="Jump to end" className="text-[#c9c9cf] hover:text-white">⏭</button>
            <span className="font-mono text-[11px] text-[#c9c9cf]">{fmtTime(playheadSec)} <span className="text-[#6a6a72]">/ {fmtTime(duration)}</span></span>
            {baked && (
              <div className="ml-auto flex items-center gap-2">
                <div className="flex overflow-hidden rounded border border-black/60">
                  <button type="button" onClick={() => selectManual('before')} className={`px-2 py-0.5 text-[10px] ${compare === 'before' ? 'bg-[#4e7cff] text-white' : 'text-[#c9c9cf]'}`}>Before</button>
                  <button type="button" onClick={() => selectManual('after')} className={`px-2 py-0.5 text-[10px] ${compare === 'after' ? 'bg-[#4e7cff] text-white' : 'text-[#c9c9cf]'}`}>After</button>
                </div>
                {baked.url && <button type="button" onClick={() => previewShow({ kind: 'url', url: baked.url as string, title: baked.outputPath || 'Result' })} className="rounded bg-[#2a2a30] px-2 py-0.5 text-[10px] text-[#c9c9cf] hover:bg-[#34343c]">Open ▶</button>}
              </div>
            )}
          </div>
        </div>

        <VideoProps
          tab={tab} setTab={setTab} v={v}
          patchVideo={patchVideo} caption={caption} setCaption={setCaption} addCaptionNow={addCaptionNow}
          removeText={removeText} goal={goal} autoNote={autoNote} autoRunning={autoRunning} setGoal={setGoal} autoFix={autoFix}
        />
      </div>

      {progress && (
        <div className="shrink-0 bg-[#141418] px-3 py-1.5">
          <div className="h-1 w-full overflow-hidden rounded-full bg-black/60">
            <div className="h-full rounded-full bg-[#4e7cff] transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }} />
          </div>
        </div>
      )}
      {error && <div className="shrink-0 bg-[#4a1620] px-3 py-2 text-[11px] text-[#ffd7dd]">{error}</div>}

      <VideoTimeline
        duration={duration} trim={v.trim ?? { start: 0, end: duration }} playhead={playheadSec} texts={v.texts}
        onTrim={(trim) => patchVideo({ trim })} onSeek={seek} filter={v.filter} muted={v.mute}
      />
    </div>
  )
}

// STUDIO_VIDEO_PROPS

interface PropsBag {
  tab: VTab
  setTab: (t: VTab) => void
  v: ManualVideoEdit
  patchVideo: (p: Partial<ManualVideoEdit>) => void
  caption: string
  setCaption: (s: string) => void
  addCaptionNow: () => void
  removeText: (id: string) => void
  goal: string
  autoNote: string | null
  autoRunning: boolean
  setGoal: (s: string) => void
  autoFix: () => void
}

function VideoProps(p: PropsBag): ReactNode {
  const { v } = p
  const TABS: Array<{ id: VTab; label: string }> = [
    { id: 'video', label: 'Video' }, { id: 'audio', label: 'Audio' }, { id: 'text', label: 'Text' }
  ]
  return (
    <div className="flex w-64 shrink-0 flex-col border-l border-black/60 bg-[#1b1b20] @[560px]:w-64 max-[559px]:w-full max-[559px]:border-l-0 max-[559px]:border-t max-[559px]:max-h-[46%]">
      <div className="flex shrink-0 border-b border-black/50">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => p.setTab(t.id)}
            className={'flex-1 py-2 text-[11px] font-medium transition-colors ' + (p.tab === t.id ? 'border-b-2 border-[#4e7cff] text-white' : 'text-[#8a8a92] hover:text-[#e6e6e6]')}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {p.tab === 'video' && (
          <>
            <Section title="Filters">
              <div className="grid grid-cols-3 gap-1.5">
                {FILTERS.map((f) => (
                  <button key={f.id} type="button" onClick={() => p.patchVideo({ filter: f.id })}
                    className={'rounded-md py-2 text-[9.5px] transition-colors ' + (v.filter === f.id ? 'bg-[#4e7cff] text-white' : 'bg-[#26262c] text-[#b9b9c0] hover:bg-[#303038]')}>
                    {f.label}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="Speed">
              <div className="flex gap-1.5">
                {SPEEDS.map((s) => (
                  <button key={s} type="button" onClick={() => p.patchVideo({ speed: s })}
                    className={'flex-1 rounded-md py-1.5 text-[11px] transition-colors ' + (v.speed === s ? 'bg-[#4e7cff] text-white' : 'bg-[#26262c] text-[#b9b9c0] hover:bg-[#303038]')}>
                    {s}×
                  </button>
                ))}
              </div>
            </Section>
            <Section title="Aspect ratio">
              <div className="flex flex-wrap gap-1.5">
                {ASPECTS.map((a) => (
                  <button key={a.label} type="button" onClick={() => p.patchVideo({ aspect: a.value })}
                    className={'rounded-md px-2.5 py-1.5 text-[10px] transition-colors ' + (v.aspect === a.value ? 'bg-[#4e7cff] text-white' : 'bg-[#26262c] text-[#b9b9c0] hover:bg-[#303038]')}>
                    {a.label}
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}
        {p.tab === 'audio' && (
          <Section title="Original audio">
            <button type="button" onClick={() => p.patchVideo({ mute: !v.mute })}
              className={'mb-2 w-full rounded-md py-1.5 text-[11px] transition-colors ' + (v.mute ? 'bg-[#4e7cff] text-white' : 'bg-[#26262c] text-[#b9b9c0] hover:bg-[#303038]')}>
              {v.mute ? 'Muted — click to unmute' : 'Mute'}
            </button>
            {!v.mute && <Slider label="Volume" value={v.volume} min={0} max={200} reset={100} onChange={(val) => p.patchVideo({ volume: val })} format={(x) => `${Math.round(x)}%`} />}
          </Section>
        )}
        {p.tab === 'text' && (
          <Section title="Captions">
            <div className="flex gap-1.5">
              <input value={p.caption} onChange={(e) => p.setCaption(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && p.addCaptionNow()}
                placeholder="Add at playhead" className="min-w-0 flex-1 rounded-md border border-black/50 bg-[#111114] px-2 py-1.5 text-[11px] text-[#e6e6e6] outline-none placeholder:text-[#6a6a72] focus:border-[#4e7cff]" />
              <button type="button" onClick={p.addCaptionNow} className="shrink-0 rounded-md bg-[#4e7cff] px-2.5 text-[13px] text-white hover:opacity-90">+</button>
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {v.texts.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded-md bg-[#26262c] px-2 py-1.5 text-[10px]">
                  <span className="min-w-0 flex-1 truncate text-[#e6e6e6]">{t.text}</span>
                  <span className="shrink-0 font-mono text-[#8a8a92]">{fmtTime(t.startSec)}</span>
                  <button type="button" onClick={() => p.removeText(t.id)} aria-label="Remove" className="shrink-0 text-[#8a8a92] hover:text-[#ff6b7a]">✕</button>
                </div>
              ))}
              {v.texts.length === 0 && <p className="text-[10px] text-[#6a6a72]">No captions yet. Move the playhead, type, and press +.</p>}
            </div>
          </Section>
        )}
      </div>
      <div className="shrink-0 border-t border-black/50 p-2.5">
        <div className="mb-1 text-[9px] uppercase tracking-wide text-[#6a6a72]">Ask Myto to finish it</div>
        <div className="flex gap-1.5">
          <input value={p.goal} onChange={(e) => p.setGoal(e.target.value)} placeholder="e.g. punchy 9:16 reel"
            className="min-w-0 flex-1 rounded-md border border-black/50 bg-[#111114] px-2 py-1.5 text-[11px] text-[#e6e6e6] outline-none placeholder:text-[#6a6a72] focus:border-[#4e7cff]" />
          <button type="button" onClick={p.autoFix} disabled={p.autoRunning} className="shrink-0 rounded-md bg-[#26262c] px-2.5 text-[11px] text-[#e6e6e6] hover:bg-[#303038] disabled:opacity-40">{p.autoRunning ? '…' : 'Auto-fix'}</button>
        </div>
        {p.autoNote && <p className="mt-1.5 text-[10px] leading-snug text-[#c7d6ff]">{p.autoNote}</p>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-[9px] uppercase tracking-wide text-[#6a6a72]">{title}</div>
      {children}
    </div>
  )
}

// STUDIO_VIDEO_TIMELINE

function VideoTimeline({
  duration, trim, playhead, texts, onTrim, onSeek, filter, muted
}: {
  duration: number
  trim: { start: number; end: number }
  playhead: number
  texts: ManualTextClip[]
  onTrim: (trim: { start: number; end: number }) => void
  onSeek: (sec: number) => void
  filter: string
  muted: boolean
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const laneRef = useRef<HTMLDivElement | null>(null)
  const modeRef = useRef<'in' | 'out' | 'seek' | null>(null)
  const [pxPerSec, setPxPerSec] = useState(42)
  const dur = Math.max(0.1, duration)

  const secFromClientX = useCallback((clientX: number): number => {
    const el = laneRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.min(dur, Math.max(0, Math.round(((clientX - r.left) / Math.max(1, r.width)) * dur * 10) / 10))
  }, [dur])

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const mode = modeRef.current
      if (!mode) return
      const sec = secFromClientX(e.clientX)
      if (mode === 'in') onTrim({ start: Math.min(sec, trim.end - 0.2), end: trim.end })
      else if (mode === 'out') onTrim({ start: trim.start, end: Math.max(sec, trim.start + 0.2) })
      else onSeek(sec)
    }
    const up = (): void => { modeRef.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [secFromClientX, trim.start, trim.end, onTrim, onSeek])

  const laneW = Math.max(0, dur * pxPerSec)
  const px = (s: number): number => s * pxPerSec
  const ticks: number[] = []
  const step = pxPerSec < 24 ? 5 : pxPerSec < 50 ? 2 : 1
  for (let t = 0; t <= dur; t += step) ticks.push(t)

  return (
    <div className="shrink-0 border-t border-black/60 bg-[#141418]">
      {/* Toolbar */}
      <div className="flex h-9 items-center gap-2 border-b border-black/50 px-3">
        <button type="button" onClick={() => onTrim({ start: 0, end: dur })} className="rounded bg-[#26262c] px-2 py-1 text-[10px] text-[#c9c9cf] hover:bg-[#303038]">Fit clip</button>
        <span className="text-[10px] text-[#6a6a72]">kept {fmtTime(trim.start)}–{fmtTime(trim.end)}</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setPxPerSec((z) => Math.max(12, z - 10))} aria-label="Zoom out" className="grid h-6 w-6 place-items-center rounded bg-[#26262c] text-[#c9c9cf] hover:bg-[#303038]">−</button>
          <span className="w-10 text-center font-mono text-[10px] text-[#8a8a92]">{Math.round(pxPerSec)}px/s</span>
          <button type="button" onClick={() => setPxPerSec((z) => Math.min(160, z + 10))} aria-label="Zoom in" className="grid h-6 w-6 place-items-center rounded bg-[#26262c] text-[#c9c9cf] hover:bg-[#303038]">+</button>
        </div>
      </div>

      {/* Lanes (scrollable) */}
      <div ref={scrollRef} className="max-h-[34vh] overflow-x-auto overflow-y-hidden">
        <div ref={laneRef} className="relative min-w-full select-none px-0 py-2" style={{ width: `${laneW}px` }}
          onPointerDown={(e) => { modeRef.current = 'seek'; onSeek(secFromClientX(e.clientX)) }}>
          {/* Ruler */}
          <div className="relative mb-1 h-4">
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 flex h-4 flex-col items-start" style={{ left: `${px(t)}px` }}>
                <div className="h-1.5 w-px bg-[#3a3a42]" />
                <span className="mt-0.5 font-mono text-[8px] text-[#6a6a72]">{fmtTime(t).replace(/\.00$/, '')}</span>
              </div>
            ))}
          </div>

          {/* STUDIO_VIDEO_TRACKS */}
          {/* Video track */}
          <div className="relative mb-1 h-12">
            <div
              className="absolute inset-y-0 flex items-center overflow-hidden rounded-md border border-[#5a8bff]/60"
              style={{ left: `${px(trim.start)}px`, width: `${Math.max(8, px(trim.end - trim.start))}px`, background: 'linear-gradient(180deg,#3b6fe0,#2b55b8)' }}
            >
              <span className="truncate px-2 text-[10px] font-medium text-white/90">🎬 {filter !== 'none' ? filter : 'clip'}</span>
              {/* trim handles */}
              <div onPointerDown={(e) => { e.stopPropagation(); modeRef.current = 'in' }}
                className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize rounded-l-md bg-white/80" />
              <div onPointerDown={(e) => { e.stopPropagation(); modeRef.current = 'out' }}
                className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize rounded-r-md bg-white/80" />
            </div>
          </div>

          {/* Text track */}
          <div className="relative mb-1 h-6">
            {texts.map((t) => (
              <div key={t.id} className="absolute inset-y-0 flex items-center overflow-hidden rounded border border-amber-300/50 bg-amber-500/80 px-1.5"
                style={{ left: `${px(t.startSec)}px`, width: `${Math.max(10, px(Math.max(0.3, t.endSec - t.startSec)))}px` }}
                title={t.text}>
                <span className="truncate text-[9px] font-medium text-black/80">T {t.text}</span>
              </div>
            ))}
            {texts.length === 0 && <span className="absolute left-1 top-1 text-[9px] text-[#4a4a52]">Text</span>}
          </div>

          {/* Audio track */}
          <div className="relative h-7">
            <div className={'absolute inset-y-0 flex items-center overflow-hidden rounded-md ' + (muted ? 'opacity-40' : '')}
              style={{ left: `${px(trim.start)}px`, width: `${Math.max(8, px(trim.end - trim.start))}px`, background: muted ? '#2a2a30' : 'linear-gradient(180deg,#1f8a5b,#166b45)' }}>
              <svg className="h-full w-full opacity-70" preserveAspectRatio="none" viewBox="0 0 100 20">
                {Array.from({ length: 50 }).map((_, i) => {
                  const h = 3 + Math.abs(Math.sin(i * 1.7) * 8) + Math.abs(Math.cos(i * 0.6) * 4)
                  return <rect key={i} x={i * 2} y={10 - h / 2} width="1" height={h} fill="white" />
                })}
              </svg>
              <span className="absolute left-2 text-[9px] font-medium text-white/90">{muted ? '🔇 muted' : '🔊 audio'}</span>
            </div>
          </div>

          {/* Playhead */}
          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 -translate-x-1/2 bg-[#ff4d6a]" style={{ left: `${px(playhead)}px` }}>
            <div className="absolute -top-0 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-[#ff4d6a]" />
          </div>
        </div>
      </div>
    </div>
  )
}



