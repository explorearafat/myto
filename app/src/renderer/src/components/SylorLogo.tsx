/**
 * Sylor brand mark — a rounded, friendly octopus with rising bubbles (ocean +
 * octopus theme). Drawn on a 48×48 grid and centered so it reads cleanly from
 * ~16px (title bar) up to splash size.
 *
 * Color comes from `currentColor` (defaults to the coral/amber `--color-primary`
 * via the `text-primary` class), so the mark tracks the active theme: warm coral
 * in light, amber in dark. Eyes/pupils/smile are fixed cream + ink for contrast
 * on both. The body outline is exported so the splash screen can stroke-draw it.
 */

/** The octopus body+tentacles outline (viewBox 0 0 48 48). Reused by the splash. */
export const OCTOPUS_BODY_PATH =
  'M10 28 C10 15 12.5 7 21 7 C29.5 7 32 15 32 28 ' +
  'C32 31.5 30.5 35 29 35 C27.6 35 27.2 30.5 26 30.5 ' +
  'C24.8 30.5 24.4 36 23 36 C21.6 36 21.2 30.5 20 30.5 ' +
  'C18.8 30.5 18.4 35 17 35 C15.7 35 15.3 30.5 14 30.5 ' +
  'C12.8 30.5 12.4 34 11 34 C10.4 34 10 31 10 28 Z'

/** The three rising bubbles, as [cx, cy, r] rings to the octopus's upper-right. */
export const OCTOPUS_BUBBLES: Array<[number, number, number]> = [
  [36, 17, 3],
  [40.5, 11, 2],
  [37.5, 6.5, 1.3]
]

const CREAM = '#fff7f0'
const INK = '#2b2a27'

interface SylorLogoProps {
  /** Rendered width/height in px. */
  size?: number
  /** Show the rising bubbles (hidden for tight avatar contexts). */
  showBubbles?: boolean
  /** Show the friendly face (eyes + smile). */
  showFace?: boolean
  className?: string
  title?: string
}

/**
 * The 48-grid was laid out so the bubbles (which reach x≈42.5, y≈5) fit; the body
 * alone occupies only x:10–32, y:7–36, so its optical center is (21, 21.5) — up and
 * to the left of the box center (24, 24). Rendering the bubble-less mark on the full
 * grid therefore parks the octopus off-center inside its square, which is what made
 * the title bar and chat avatar look misaligned against the "Sylor" text beside it.
 * With bubbles hidden we tighten the viewBox onto the body's own center instead;
 * with bubbles shown the full grid is still correct (they're part of the artwork).
 */
const BODY_ONLY_VIEWBOX = '6 6.5 30 30'
const FULL_VIEWBOX = '0 0 48 48'

export function SylorLogo({
  size = 24,
  showBubbles = true,
  showFace = true,
  className = '',
  title = 'Sylor'
}: SylorLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={showBubbles ? FULL_VIEWBOX : BODY_ONLY_VIEWBOX}
      fill="none"
      role="img"
      aria-label={title}
      className={`text-primary ${className}`}
    >
      {/* Body + tentacles (theme-colored via currentColor). */}
      <path d={OCTOPUS_BODY_PATH} fill="currentColor" />

      {/* Soft top-left sheen for a glossy, premium feel. */}
      <ellipse cx="16" cy="12.5" rx="3.2" ry="2" fill={CREAM} opacity="0.3" />

      {showFace && (
        <g>
          {/* Eyes */}
          <circle cx="17.5" cy="19" r="2.6" fill={CREAM} />
          <circle cx="24.5" cy="19" r="2.6" fill={CREAM} />
          <circle cx="18.1" cy="19.3" r="1.05" fill={INK} />
          <circle cx="25.1" cy="19.3" r="1.05" fill={INK} />
          {/* Gentle smile */}
          <path
            d="M18.6 23.6 Q21 25.6 23.4 23.6"
            fill="none"
            stroke={CREAM}
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </g>
      )}

      {showBubbles &&
        OCTOPUS_BUBBLES.map(([cx, cy, r], i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={r < 1.6 ? 1.1 : 1.5}
          />
        ))}
    </svg>
  )
}
