import { useEffect, useRef } from 'react';

/* A subtle CSS-3D gyroscope for the hero — three nested rings tilted on
   different axes, each spinning on its own orbit with a single node dot riding
   the edge (composite-only: no three.js, no canvas, no per-frame JS). Sits
   behind the hero at low opacity, the way OpenAI/ChatGPT pages float abstract
   geometry. prefers-reduced-motion holds the rings still. */
export function Hero3D() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.querySelectorAll<HTMLElement>('.h3d-ring').forEach((ring) => {
        ring.style.animation = 'none';
      });
    }
  }, []);

  // Tilt/size per ring — nested tighter and flatter toward the back.
  const RINGS = [
    { size: 440, tiltX: 74, tiltY: 0, dur: 38, border: 'rgba(20,20,19,0.11)' },
    { size: 372, tiltX: 74, tiltY: 60, dur: 52, border: 'rgba(20,20,19,0.085)' },
    { size: 304, tiltX: 74, tiltY: 120, dur: 68, border: 'rgba(26,107,82,0.14)' },
  ];

  return (
    <div
      aria-hidden="true"
      ref={ref}
      className="pointer-events-none absolute -right-16 top-1/2 hidden -translate-y-1/2 lg:block"
      style={{ perspective: '900px' }}
    >
      <div className="h3d-scene relative h-[440px] w-[440px]">
        {RINGS.map((r, i) => (
          <div
            key={i}
            className="h3d-tilt"
            style={{
              width: r.size,
              height: r.size,
              left: '50%',
              top: '50%',
              marginLeft: -r.size / 2,
              marginTop: -r.size / 2,
              transform: `rotateX(${r.tiltX}deg) rotateY(${r.tiltY}deg)`,
            }}
          >
            <div
              className="h3d-ring"
              style={{
                borderColor: r.border,
                borderWidth: 1.5,
                animationDuration: `${r.dur}s`,
                animationDirection: i % 2 === 1 ? 'reverse' : 'normal',
              }}
            >
              <span className="h3d-node" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
