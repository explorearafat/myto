import { type ReactNode, useCallback } from 'react'
import type { PhotoAdjust, EditorPanel, HslBand } from '@shared/types'
import type { EditorPlayer } from '../hooks/useEditorPlayer'
import { useEditorStore } from '../store/useEditorStore'
import { PHOTO_NEUTRAL_ADJUST } from '../lib/editor-preview'
import { ToneCurve } from './ToneCurve'
import { Histogram } from './Histogram'

/**
 * The Lightroom-style panel Myto drives while editing a photo. Every control reads the live
 * {@link PhotoAdjust} the player publishes each frame, so sliders glide, the curve draws and
 * HSL tiles light up exactly as the virtual cursor visits them. Controls register their DOM
 * element under the SAME semantic id the choreography uses ('exposure', 'curve-rgb',
 * 'hsl-red', 'crop'), which is how {@link VirtualCursor} finds where to glide. Display-only:
 * it mutates no state — the player owns the clock and the authoritative values come from
 * {@link EditorPlayer.playback}.
 */
type NumKey = Exclude<keyof PhotoAdjust, 'curve' | 'hsl' | 'crop' | 'rotate'>

const GROUPS: Array<{ title: string; keys: NumKey[] }> = [
  { title: 'Light', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: 'Color', keys: ['temp', 'tint', 'vibrance', 'saturation'] },
  { title: 'Effects', keys: ['clarity', 'sharpen', 'vignette'] }
]
const LABELS: Record<NumKey, string> = {
  exposure: 'Exposure', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows',
  whites: 'Whites', blacks: 'Blacks', temp: 'Temp', tint: 'Tint', vibrance: 'Vibrance',
  saturation: 'Saturation', clarity: 'Clarity', sharpen: 'Sharpen', vignette: 'Vignette'
}
const HSL_BANDS: HslBand[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']
const BAND_COLOR: Record<HslBand, string> = {
  red: '#e5484d', orange: '#f76b15', yellow: '#f5d90a', green: '#30a46c',
  aqua: '#2dd4bf', blue: '#4661d6', purple: '#8e4ec6', magenta: '#e93d82'
}
const TABS: Array<{ id: EditorPanel; label: string }> = [
  { id: 'basic', label: 'Basic' }, { id: 'curve', label: 'Curve' },
  { id: 'hsl', label: 'HSL' }, { id: 'crop', label: 'Crop' }
]

/** One Basic slider: a centered track with a fill from the midpoint to the current value. */
function SliderRow({
  k, value, active, register
}: {
  k: NumKey
  value: number
  active: boolean
  register: (id: string, el: HTMLElement | null) => void
}): ReactNode {
  const setRef = useCallback((el: HTMLElement | null) => register(k, el), [k, register])
  const pct = (value + 100) / 2 // −100..100 → 0..100
  const v = Math.round(value)
  return (
    <div className="px-2 py-1">
      <div className="mb-0.5 flex items-center justify-between text-[10px]">
        <span className={active ? 'text-primary' : 'text-muted'}>{LABELS[k]}</span>
        <span className={`font-mono ${v !== 0 ? 'text-text' : 'text-muted'}`}>{v > 0 ? `+${v}` : v}</span>
      </div>
      <div ref={setRef} className={`relative h-1.5 rounded-full bg-surface-2 ${active ? 'ring-1 ring-primary/60' : ''}`}>
        <div className="absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-border" />
        <div
          className="absolute top-0 h-full rounded-full bg-primary/70"
          style={value >= 0 ? { left: '50%', width: `${pct - 50}%` } : { right: '50%', width: `${50 - pct}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-white shadow"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function PhotoEditor({ player }: { player: EditorPlayer }): ReactNode {
  const source = useEditorStore((s) => s.source)
  const pb = player.playback
  const live: PhotoAdjust = pb?.adjust ?? PHOTO_NEUTRAL_ADJUST
  const panel: EditorPanel = pb?.activePanel ?? 'basic'
  const active = pb?.activeControl ?? null
  const reg = player.registerControl
  const setCurveRef = useCallback(
    (el: HTMLElement | null) => {
      reg('curve-rgb', el)
      reg('curve-r', el)
      reg('curve-g', el)
      reg('curve-b', el)
    },
    [reg]
  )

  return (
    <div className="flex w-60 shrink-0 flex-col border-l border-border bg-surface">
      <div className="shrink-0 border-b border-border p-2">
        <Histogram source={source?.preview ?? ''} live={live} />
      </div>

      {/* Panel tabs — highlighted to match whichever panel Myto is driving. */}
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

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {panel === 'basic' &&
          GROUPS.map((gp) => (
            <div key={gp.title} className="mb-1">
              <div className="px-2 py-0.5 text-[9px] uppercase tracking-wide text-muted">{gp.title}</div>
              {gp.keys.map((k) => (
                <SliderRow key={k} k={k} value={live[k]} active={active === k} register={reg} />
              ))}
            </div>
          ))}

        {panel === 'curve' && (
          <div ref={setCurveRef} className="px-2">
            <ToneCurve curve={live.curve} draw={pb?.curveDraw ?? null} />
          </div>
        )}

        {panel === 'hsl' && (
          <div className="grid grid-cols-2 gap-1 px-2">
            {HSL_BANDS.map((band) => {
              const b = live.hsl?.[band]
              const on = active === `hsl-${band}`
              return (
                <div
                  key={band}
                  ref={(el) => reg(`hsl-${band}`, el)}
                  className={`rounded-md border p-1 transition-colors ${on ? 'border-primary' : 'border-border'}`}
                >
                  <div className="flex items-center gap-1">
                    <span className="h-3 w-3 rounded-full" style={{ background: BAND_COLOR[band] }} />
                    <span className="text-[9px] capitalize text-muted">{band}</span>
                  </div>
                  <div className="mt-0.5 flex justify-between font-mono text-[8px] text-muted">
                    <span>H{Math.round(b?.hue ?? 0)}</span>
                    <span>S{Math.round(b?.sat ?? 0)}</span>
                    <span>L{Math.round(b?.lum ?? 0)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {panel === 'crop' && (
          <div ref={(el) => reg('crop', el)} className="px-2 text-[10px] text-muted">
            <div className="rounded-md border border-border p-2">
              <div className="flex justify-between">
                <span>Rotate</span>
                <span className="font-mono text-text">{Math.round(live.rotate ?? 0)}°</span>
              </div>
              {live.crop && (
                <div className="mt-1 flex justify-between">
                  <span>Crop</span>
                  <span className="font-mono text-text">
                    {Math.round(live.crop.w * 100)}×{Math.round(live.crop.h * 100)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

