/*
 * The Sylor star — Sylor's universal mark. A twelve-ray terracotta sunburst drawn from pure
 * geometry (no image file), so it stays razor-sharp at any size and drops into any project
 * as-is: no imports beyond this one file, no assets, no build step.
 *
 * This component is the single source of truth for the mark in the app. public/sylor-star.svg
 * is the exact same geometry as a static file for non-React use (favicon, <img>, CSS). Keep
 * the two in sync — same viewBox, same ray paths, same colour — so the logo is identical
 * everywhere it appears.
 */

/** The two rays, alternating around twelve 30° steps about the centre (12,12). */
const LONG_RAY = 'M12 1.4C12.85 6 12.85 8.4 12 11C11.15 8.4 11.15 6 12 1.4Z';
const SHORT_RAY = 'M12 4.8C12.6 7.4 12.6 8.9 12 11C11.4 8.9 11.4 7.4 12 4.8Z';

interface SylorStarProps {
  /** Extra classes on the <svg> — e.g. Tailwind sizing when `size` is omitted. */
  className?: string;
  /** Width and height in px. Omit to size via `className`/CSS instead. */
  size?: number;
  /** Fill colour. Defaults to Sylor terracotta so the mark looks identical everywhere. */
  color?: string;
  /** Accessible label. Omit to render the mark as decorative (aria-hidden). */
  title?: string;
}

export function SylorStar({ className, size, color = '#cf5535', title }: SylorStarProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {Array.from({ length: 12 }).map((_, i) => (
        <path
          key={i}
          d={i % 2 === 0 ? LONG_RAY : SHORT_RAY}
          transform={`rotate(${i * 30} 12 12)`}
        />
      ))}
    </svg>
  );
}
