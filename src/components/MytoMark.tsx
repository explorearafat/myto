/*
 * The Myto mark — Myto's universal logo (a monochrome mitochondria: a tilted, organic bean with a
 * double membrane and four rounded finger-like cristae). Drawn from pure geometry (no image file), so it stays
 * razor-sharp at any size and drops into any project as-is: no imports beyond this one
 * file, no assets, no build step.
 *
 * This component is the single source of truth for the mark on the site. public/myto-mark.svg
 * is the exact same geometry as a static file for non-React use (favicon, <img>, CSS). Keep
 * the two — and the desktop app's MytoMark + the mobile painter — in sync (same viewBox, same
 * paths). The stroke uses `currentColor`, so the mark inverts with context (ink on the warm
 * "paper" theme, near-white on dark) unless a caller sets `color`.
 */

interface MytoMarkProps {
  /** Extra classes on the <svg> — e.g. Tailwind sizing when `size` is omitted. */
  className?: string;
  /** Width and height in px. Omit to size via `className`/CSS instead. */
  size?: number;
  /** Stroke colour. Defaults to `currentColor` so the mark tracks the surrounding text colour. */
  color?: string;
  /** Accessible label. Omit to render the mark as decorative (aria-hidden). */
  title?: string;
}

export function MytoMark({ className, size, color = 'currentColor', title }: MytoMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <g transform="rotate(12 256 256)">
        <path strokeWidth="17" d="M100 260C100 212 134 178 182 170C214 165 234 187 258 193C284 199 302 170 342 168C394 166 436 202 434 254C432 306 398 348 344 356C302 362 282 368 252 368C194 368 132 354 110 320C97 300 98 282 100 260Z" />
        <path strokeWidth="13" d="M142 258C142 224 168 204 202 199C228 195 244 209 266 214C288 219 302 200 330 200C366 200 394 222 392 256C390 292 366 320 328 326C300 330 284 334 258 334C214 334 174 324 156 302C143 288 142 274 142 258Z" />
        <path strokeWidth="14" d="M184 300C172 274 176 244 192 224" />
        <path strokeWidth="15" d="M216 312C206 282 210 242 226 216" />
        <path strokeWidth="14" d="M250 312C244 284 254 248 272 226" />
        <path strokeWidth="13" d="M286 302C282 282 292 262 310 248" />
      </g>
    </svg>
  );
}
