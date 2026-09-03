interface BackdropProps {
  /** 'down' fades the grid out toward the bottom, 'up' toward the top. */
  fade?: 'down' | 'up';
  /** The warm bloom is only worth it on the light paper background. */
  bloom?: boolean;
}

/**
 * The page's one piece of texture: faint graph-paper ruling, masked so it never
 * reaches an edge, with an optional warm bloom behind the top corner. Two static
 * CSS gradients — no image request, nothing animating, nothing to composite on
 * scroll. Bookends the page (hero at the top, Install at the bottom) and leaves
 * the reading sections in between on plain paper.
 */
export function Backdrop({ fade = 'down', bloom = false }: BackdropProps) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className={fade === 'down' ? 'paper-grid paper-grid--down' : 'paper-grid paper-grid--up'} />
      {bloom ? <div className="paper-bloom" /> : null}
    </div>
  );
}
