import { useEffect, useRef } from 'react';

/*
 * A full-viewport background animation whose "playback" is scrubbed by scroll
 * position — scroll down and the blooms drift across the page; scroll up and
 * they travel back. It is drawn on a <canvas> (not a real <video>) so it needs no
 * asset, stays smooth (no per-frame video seeking), and uses Myto's own monochrome
 * palette — the same layered-charcoal identity as index.css's .hero-aura and
 * .paper-bloom, just alive. It paints the paper base itself and sits behind all
 * content (z-0, pointer-events-none), so text stays readable and clicks pass through.
 *
 * Landing page only (mounted in App.tsx) — /chat and its aesthetic are untouched.
 * Respects prefers-reduced-motion: no loop, a single static frame instead.
 */

const PAPER = '#faf9f5';

interface Bloom {
  /** Base position, as a fraction of the viewport. */
  bx: number;
  by: number;
  /** How far the bloom travels across a full top→bottom scroll (viewport fractions). */
  dx: number;
  dy: number;
  /** Radius as a fraction of the larger viewport side. */
  r: number;
  /** Monochrome charcoal tint. */
  color: [number, number, number];
  /** Peak alpha at the bloom's core. */
  a: number;
  /** Phase offset so the blooms don't drift in lockstep. */
  o: number;
}

const BLOOMS: Bloom[] = [
  { bx: 0.16, by: 0.1, dx: 0.12, dy: 0.58, r: 0.62, color: [20, 20, 19], a: 0.06, o: 0.0 }, // ink
  { bx: 0.84, by: 0.04, dx: -0.18, dy: 0.44, r: 0.56, color: [43, 42, 39], a: 0.05, o: 1.7 }, // charcoal
  { bx: 0.6, by: 0.52, dx: -0.26, dy: -0.34, r: 0.5, color: [20, 20, 19], a: 0.055, o: 3.1 }, // ink
  { bx: 0.34, by: 0.86, dx: 0.24, dy: -0.52, r: 0.46, color: [43, 42, 39], a: 0.04, o: 4.6 }, // deep charcoal
];

function draw(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  phase: number,
  t: number,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);

  const side = Math.max(w, h);
  const drift = 0.03; // whisper of ambient life when the page is at rest

  for (const b of BLOOMS) {
    const cx = (b.bx + b.dx * phase + Math.sin(t + b.o) * drift) * w;
    const cy = (b.by + b.dy * phase + Math.cos(t * 0.9 + b.o) * drift) * h;
    const rad = b.r * side * (0.9 + 0.16 * Math.sin(phase * Math.PI + b.o));
    const [r, g, bl] = b.color;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, rad));
    grad.addColorStop(0, `rgba(${r}, ${g}, ${bl}, ${b.a})`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${bl}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}

export function ScrollCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const scrollProgress = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    };

    resize();

    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reduced motion: one calm static frame, no animation loop.
    if (reduce) {
      const paintStatic = () => draw(ctx, w, h, 0.14, 0);
      const onResize = () => {
        resize();
        paintStatic();
      };
      paintStatic();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    let phase = scrollProgress();
    let target = phase;
    let t = 0;
    let raf = 0;

    const onScroll = () => {
      target = scrollProgress();
    };

    const frame = () => {
      // Ease toward the scroll target so scrubbing feels fluid, not stepped.
      phase += (target - phase) * 0.08;
      t += 0.0016;
      draw(ctx, w, h, phase, t);
      raf = window.requestAnimationFrame(frame);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', resize);
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-0"
    />
  );
}
