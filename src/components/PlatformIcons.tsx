/*
 * Two small platform marks, drawn inline so they inherit `currentColor` and sit
 * on any button — dark, outline, or card. The Windows mark is the four-square
 * logo; the Android mark is the robot head (dome + antennae + eyes), stroked so
 * it reads on light and dark alike. Neither is a fabricated brand asset beyond
 * these plain, universally recognised silhouettes.
 */

interface MarkProps {
  className?: string;
}

export function WindowsMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="0.6" />
      <rect x="13" y="3" width="8" height="8" rx="0.6" />
      <rect x="3" y="13" width="8" height="8" rx="0.6" />
      <rect x="13" y="13" width="8" height="8" rx="0.6" />
    </svg>
  );
}

export function AndroidMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* antennae */}
      <path d="M8 4.5 9.4 6.8" />
      <path d="M16 4.5 14.6 6.8" />
      {/* the dome, closed along the bottom */}
      <path d="M5 12a7 7 0 0 1 14 0Z" />
      {/* eyes */}
      <circle cx="9.4" cy="9" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="9" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
