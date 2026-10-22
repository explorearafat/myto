import { type ReactNode, type CSSProperties, useState } from 'react'
import type { EditorPanel, HslBand, HslAdjust, CropRect, CurvePoint } from '@shared/types'
import { useEditorStore } from '../store/useEditorStore'
import { useStudioBake } from '../hooks/useStudioBake'
import { AdjustCanvas } from './AdjustCanvas'
import { Histogram } from './Histogram'
import { Slider, CurveEditor } from './StudioControls'

/**
 * The MANUAL photo editor, styled as a faithful master-copy of Adobe Photoshop's chrome:
 * dark gunmetal theme, a top options bar, a left vertical tool rail, a dark checkerboard
 * canvas, and a right dock of Adjustments / Layers / Histogram panels. The adjustment engine
 * (real-time pixel pipeline via {@link AdjustCanvas}) drives the look; "Export" bakes the
 * authoritative file and "Auto-fix" lets Myto review + correct it against a typed goal.
 *
 * Photoshop palette (explicit, theme-independent so it reads as PS in any app theme):
 *   chrome #393939 · panel #2b2b2b · canvas #1e1e1e · divider #1f1f1f · text #d4d4d4 ·
 *   muted #8a8a8a · accent (PS blue) #1473e6 · tool active #4b4b4b.
 */
type NumKey =
  | 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'
  | 'temp' | 'tint' | 'vibrance' | 'saturation' | 'clarity' | 'sharpen' | 'vignette'

const GROUPS: Array<{ title: string; keys: NumKey[] }> = [
  { title: 'Light', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: 'Color', keys: ['temp', 'tint', 'vibrance', 'saturation'] },
  { title: 'Effects', keys: ['clarity', 'sharpen', 'vignette'] }
]
const LABELS: Record<NumKey, string> = {
  exposure: 'Exposure', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows',
  whites: 'Whites', blacks: 'Blacks', temp: 'Temperature', tint: 'Tint', vibrance: 'Vibrance',
  saturation: 'Saturation', clarity: 'Clarity', sharpen: 'Sharpen', vignette: 'Vignette'
}
const HSL_BANDS: HslBand[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']
const BAND_COLOR: Record<HslBand, string> = {
  red: '#e5484d', orange: '#f76b15', yellow: '#f5d90a', green: '#30a46c',
  aqua: '#2dd4bf', blue: '#4661d6', purple: '#8e4ec6', magenta: '#e93d82'
}
const ASPECTS: Array<{ label: string; ratio: number | null }> = [
  { label: 'Original', ratio: null }, { label: '1:1', ratio: 1 }, { label: '4:5', ratio: 4 / 5 },
  { label: '16:9', ratio: 16 / 9 }, { label: '9:16', ratio: 9 / 16 }
]

function cropForAspect(ratio: number | null): CropRect | null {
  if (ratio == null) return null
  if (ratio >= 1) {
    const h = Math.min(1, 1 / ratio)
    return { x: 0, y: (1 - h) / 2, w: 1, h }
  }
  const w = Math.min(1, ratio)
  return { x: (1 - w) / 2, y: 0, w, h: 1 }
}

// STUDIO_PHOTO_BODY

/** A Photoshop-style tool. `panel` (when set) switches the dock to that adjustment panel. */
interface PsTool {
  id: string
  key: string
  title: string
  panel?: EditorPanel
  icon: ReactNode
}
const I = (d: ReactNode): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)
const PS_TOOLS: PsTool[] = [
  { id: 'move', key: 'V', title: 'Move', icon: I(<><path d="M10 3v14M3 10h14" /><path d="M10 3 7 6M10 3l3 3M10 17l-3-3M10 17l3-3M3 10l3-3M3 10l3 3M17 10l-3-3M17 10l-3 3" /></>) },
  { id: 'marquee', key: 'M', title: 'Rectangular Marquee', icon: I(<rect x="3" y="4.5" width="14" height="11" rx="0.5" strokeDasharray="2.4 1.8" />) },
  { id: 'lasso', key: 'L', title: 'Lasso', icon: I(<path d="M4 11c0-4 3-6 6-6s6 2 6 5-3 5-5 5c-1.5 0-2-1-1.3-1.8" />) },
  { id: 'crop', key: 'C', title: 'Crop', panel: 'crop', icon: I(<><path d="M6 2v12h12" /><path d="M2 6h12v12" /></>) },
  { id: 'eyedropper', key: 'I', title: 'Eyedropper', icon: I(<path d="M15 3l2 2-7 7-3 1 1-3 7-7z" />) },
  { id: 'brush', key: 'B', title: 'Brush', icon: I(<path d="M4 16c3 1 5-1 5-3 0-1 7-7 8-9 1-1-1-3-2-2-2 1-8 8-9 8-2 0-4 2-2 6z" />) },
  { id: 'clone', key: 'S', title: 'Clone Stamp', icon: I(<><path d="M6 17h8M8 17v-4h4v4M6 13h8l-1-4H7l-1 4zM9 9V5h2v4" /></>) },
  { id: 'eraser', key: 'E', title: 'Eraser', icon: I(<><path d="M4 13l6-6 5 5-4 4H7l-3-3z" /><path d="M8 17h8" /></>) },
  { id: 'gradient', key: 'G', title: 'Gradient', icon: I(<rect x="3" y="4" width="14" height="12" rx="1" fill="url(#g)" stroke="currentColor" />) },
  { id: 'text', key: 'T', title: 'Type', icon: I(<><path d="M5 5h10M10 5v11M7.5 16h5" /></>) },
  { id: 'hand', key: 'H', title: 'Hand', icon: I(<path d="M7 11V6a1 1 0 012 0v4m0-1V5a1 1 0 012 0v5m0-1V6a1 1 0 012 0v5c0 3-2 5-5 5s-5-2-5-4l-.5-2a1 1 0 011.8-.8L7 11" />) },
  { id: 'zoom', key: 'Z', title: 'Zoom', icon: I(<><circle cx="9" cy="9" r="5" /><path d="M13 13l4 4M7 9h4M9 7v4" /></>) }
]

function OptionBtn({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }): ReactNode {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick}
      className={'rounded px-2 py-1 text-[11px] transition-colors ' + (active ? 'bg-[#1473e6] text-white' : 'text-[#c9c9c9] hover:bg-[#4a4a4a]')}>
      {children}
    </button>
  )
}

export function StudioPhoto(): ReactNode {
  const m = useEditorStore((s) => s.manual)
  const setManualPanel = useEditorStore((s) => s.setManualPanel)
  const setCrop = useEditorStore((s) => s.setCrop)
  const resetAdjust = useEditorStore((s) => s.resetAdjust)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const selectManual = useEditorStore((s) => s.selectManual)
  const { exportPhoto } = useStudioBake()
  const [tool, setTool] = useState('move')

  if (!m || m.kind !== 'photo') return null
  const { adjust, baked, compare, progress } = m
  const showAfter = baked && compare === 'after'
  const showBefore = baked && compare === 'before'
  const activeTool = PS_TOOLS.find((t) => t.id === tool) ?? PS_TOOLS[0]

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-[#1e1e1e] text-[#d4d4d4]"
      style={{ '--studio-accent': '#1473e6' } as CSSProperties}
    >
      {/* Options bar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[#151515] bg-[#393939] px-2">
        <span className="text-[11px] font-medium text-[#e8e8e8]">{activeTool.title}</span>
        <div className="h-4 w-px bg-[#555]" />
        {tool === 'crop' ? (
          ASPECTS.map((a) => (
            <OptionBtn key={a.label} label={a.label} onClick={() => setCrop(cropForAspect(a.ratio))}>{a.label}</OptionBtn>
          ))
        ) : (
          <span className="text-[10px] text-[#8a8a8a]">Adjust the look in the panels on the right →</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <OptionBtn label="Undo" onClick={undo}>↶</OptionBtn>
          <OptionBtn label="Redo" onClick={redo}>↷</OptionBtn>
          <OptionBtn label="Reset all" onClick={resetAdjust}>Reset</OptionBtn>
        </div>
      </div>

      {/* Main: tool rail · canvas · dock */}
      <div className="@container flex min-h-0 flex-1">
        <div className="flex w-10 shrink-0 flex-col items-center gap-[3px] border-r border-[#151515] bg-[#333] py-1.5">
          {PS_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={`${t.title} (${t.key})`}
              aria-label={t.title}
              onClick={() => { setTool(t.id); if (t.panel) setManualPanel(t.panel) }}
              className={'grid h-7 w-7 place-items-center rounded transition-colors ' + (tool === t.id ? 'bg-[#1473e6] text-white' : 'text-[#c7c7c7] hover:bg-[#4b4b4b]')}
            >
              {t.icon}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col @[520px]:flex-row">
          {/* Canvas */}
          <div
            className="relative grid min-h-0 flex-1 place-items-center overflow-auto p-4"
            style={{
              backgroundColor: '#1a1a1a',
              backgroundImage:
                'linear-gradient(45deg,#232323 25%,transparent 25%),linear-gradient(-45deg,#232323 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#232323 75%),linear-gradient(-45deg,transparent 75%,#232323 75%)',
              backgroundSize: '20px 20px',
              backgroundPosition: '0 0,0 10px,10px -10px,-10px 0'
            }}
          >
            <div className="relative inline-flex max-h-full max-w-full">
              {showAfter ? (
                <img src={baked.resultPreview} alt="Edited result" className="max-h-full max-w-full object-contain shadow-[0_0_0_1px_#000,0_8px_30px_rgba(0,0,0,0.6)]" />
              ) : showBefore ? (
                <img src={m.sourcePreview} alt="Original" className="max-h-full max-w-full object-contain shadow-[0_0_0_1px_#000,0_8px_30px_rgba(0,0,0,0.6)]" />
              ) : (
                <AdjustCanvas sourcePreview={m.sourcePreview} adjust={adjust} />
              )}
            </div>
            {baked && (
              <div className="pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 overflow-hidden rounded-md border border-[#111] bg-[#2b2b2b] shadow-lg">
                <button type="button" onClick={() => selectManual('before')} className={`px-3 py-1 text-[11px] ${compare === 'before' ? 'bg-[#1473e6] text-white' : 'text-[#c9c9c9] hover:bg-[#3a3a3a]'}`}>Before</button>
                <button type="button" onClick={() => selectManual('after')} className={`px-3 py-1 text-[11px] ${compare === 'after' ? 'bg-[#1473e6] text-white' : 'text-[#c9c9c9] hover:bg-[#3a3a3a]'}`}>After</button>
              </div>
            )}
          </div>

          <PhotoDock onExport={exportPhoto} baking={!!progress} />
        </div>
      </div>
      {progress && <ProgressBar pct={progress.pct} label={progress.label} />}
      {m.error && <div className="shrink-0 bg-[#5a1a1a] px-3 py-2 text-[11px] text-[#ffd7d7]">{m.error}</div>}
    </div>
  )
}

function ProgressBar({ pct, label }: { pct: number; label: string }): ReactNode {
  return (
    <div className="shrink-0 border-t border-[#151515] bg-[#2b2b2b] px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-[#9a9a9a]">
        <span className="truncate">{label || 'Rendering…'}</span>
        <span className="ml-2 shrink-0 font-mono">{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1a1a1a]">
        <div className="h-full rounded-full bg-[#1473e6] transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
    </div>
  )
}

// STUDIO_PHOTO_DOCK

const SUBTABS: Array<{ id: EditorPanel; label: string }> = [
  { id: 'basic', label: 'Basic' }, { id: 'curve', label: 'Curves' },
  { id: 'hsl', label: 'HSL' }, { id: 'crop', label: 'Transform' }
]

/** A Photoshop dock panel: a dark title bar over a body. */
function Panel({ title, children, grow }: { title: string; children: ReactNode; grow?: boolean }): ReactNode {
  return (
    <div className={'flex flex-col border-b border-[#151515] ' + (grow ? 'min-h-0 flex-1' : '')}>
      <div className="flex h-6 shrink-0 items-center bg-[#333] px-2 text-[10px] font-semibold uppercase tracking-wide text-[#b5b5b5]">{title}</div>
      <div className={'bg-[#2b2b2b] ' + (grow ? 'min-h-0 flex-1 overflow-auto' : '')}>{children}</div>
    </div>
  )
}

function PhotoDock({ onExport, baking }: { onExport: () => void; baking: boolean }): ReactNode {
  const m = useEditorStore((s) => s.manual)
  const patchAdjust = useEditorStore((s) => s.patchAdjust)
  const patchHsl = useEditorStore((s) => s.patchHsl)
  const setCurve = useEditorStore((s) => s.setCurve)
  const setRotate = useEditorStore((s) => s.setRotate)
  const setManualPanel = useEditorStore((s) => s.setManualPanel)
  const setGoal = useEditorStore((s) => s.setGoal)
  const { autoFix } = useStudioBake()
  const [band, setBand] = useState<HslBand>('red')
  if (!m) return null
  const { adjust, panel, sourcePreview, goal, autoNote, autoRunning } = m
  const hsl: HslAdjust = adjust.hsl?.[band] ?? { hue: 0, sat: 0, lum: 0 }
  const movedGroups = GROUPS.filter((g) => g.keys.some((k) => adjust[k] !== 0))

  return (
    <div className="flex w-[248px] shrink-0 flex-col border-l border-[#151515] bg-[#2b2b2b] @[520px]:w-[248px] max-[519px]:w-full max-[519px]:border-l-0 max-[519px]:border-t">
      {/* Adjustments */}
      <Panel title="Adjustments" grow>
        <div className="flex border-b border-[#1f1f1f] bg-[#2b2b2b]">
          {SUBTABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setManualPanel(t.id)}
              className={'flex-1 py-1.5 text-[10px] transition-colors ' + (panel === t.id ? 'border-b-2 border-[#1473e6] text-white' : 'text-[#9a9a9a] hover:text-[#d4d4d4]')}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-1">
          {panel === 'basic' && GROUPS.map((gp) => (
            <div key={gp.title} className="mb-1.5">
              <div className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[#777]">{gp.title}</div>
              {gp.keys.map((k) => (
                <Slider key={k} label={LABELS[k]} value={adjust[k]} onChange={(v) => patchAdjust({ [k]: v })} />
              ))}
            </div>
          ))}
          {panel === 'curve' && (
            <div className="p-1.5">
              <CurveEditor points={adjust.curve?.rgb} onChange={(pts: CurvePoint[]) => setCurve('rgb', pts)} />
              <p className="mt-1 text-[9px] leading-snug text-[#777]">Drag points to shape the curve · double-click to reset a point.</p>
            </div>
          )}
          {panel === 'hsl' && (
            <div className="p-1.5">
              <div className="mb-2 flex flex-wrap gap-1">
                {HSL_BANDS.map((b) => (
                  <button key={b} type="button" onClick={() => setBand(b)} title={b}
                    className={'h-5 w-5 rounded-full border transition-transform ' + (band === b ? 'scale-110 border-white' : 'border-transparent')}
                    style={{ background: BAND_COLOR[b] }} />
                ))}
              </div>
              <div className="text-[9px] uppercase tracking-wide text-[#777]">{band}</div>
              <Slider label="Hue" value={hsl.hue} onChange={(v) => patchHsl(band, 'hue', v)} />
              <Slider label="Saturation" value={hsl.sat} onChange={(v) => patchHsl(band, 'sat', v)} />
              <Slider label="Luminance" value={hsl.lum} onChange={(v) => patchHsl(band, 'lum', v)} />
            </div>
          )}
          {panel === 'crop' && (
            <div className="p-1.5">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-[#777]">Aspect — pick from the options bar above</div>
              <Slider label="Straighten / Rotate" value={adjust.rotate ?? 0} min={-180} max={180} reset={0} onChange={setRotate} format={(v) => `${Math.round(v)}°`} />
              <p className="mt-1 text-[9px] leading-snug text-[#777]">{adjust.crop ? `Crop ${Math.round(adjust.crop.w * 100)}×${Math.round(adjust.crop.h * 100)}%` : 'Full frame'}</p>
            </div>
          )}
        </div>
      </Panel>

      {/* STUDIO_PHOTO_DOCK_B */}
      <Panel title="Histogram">
        <div className="p-1.5">
          <Histogram source={sourcePreview} live={adjust} />
        </div>
      </Panel>

      <Panel title="Layers">
        <div className="flex flex-col gap-px p-1.5">
          {movedGroups.map((g) => (
            <div key={g.title} className="flex items-center gap-2 rounded bg-[#333] px-2 py-1 text-[11px]">
              <span className="h-2 w-2 rounded-sm bg-[#1473e6]" />
              <span className="flex-1 text-[#d4d4d4]">{g.title} adjustment</span>
              <span className="text-[#777]">fx</span>
            </div>
          ))}
          <div className="flex items-center gap-2 rounded bg-[#333] px-2 py-1 text-[11px]">
            <span className="grid h-4 w-5 place-items-center rounded-sm border border-[#555] bg-[#222] text-[8px] text-[#999]">◳</span>
            <span className="flex-1 text-[#d4d4d4]">Background</span>
            <span className="text-[#777]">🔒</span>
          </div>
        </div>
      </Panel>

      {/* Export + Auto-fix */}
      <div className="shrink-0 border-t border-[#151515] bg-[#2b2b2b] p-2">
        <button type="button" onClick={onExport} disabled={baking}
          className="mb-2 w-full rounded bg-[#1473e6] py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
          {baking ? 'Exporting…' : 'Export'}
        </button>
        <div className="mb-1 text-[9px] uppercase tracking-wide text-[#777]">Ask Myto to finish it</div>
        <div className="flex gap-1">
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. warm & cinematic"
            className="min-w-0 flex-1 rounded border border-[#1f1f1f] bg-[#1e1e1e] px-2 py-1 text-[11px] text-[#d4d4d4] outline-none placeholder:text-[#777] focus:border-[#1473e6]" />
          <button type="button" onClick={autoFix} disabled={autoRunning}
            className="shrink-0 rounded bg-[#3a3a3a] px-2 text-[11px] text-[#d4d4d4] hover:bg-[#4a4a4a] disabled:opacity-40">
            {autoRunning ? '…' : 'Auto-fix'}
          </button>
        </div>
        {autoNote && <p className="mt-1.5 text-[10px] leading-snug text-[#cfe3ff]">{autoNote}</p>}
      </div>
    </div>
  )
}


