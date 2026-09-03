import { FEATURES } from '../data';
import { Words } from './Words';

export function Features() {
  return (
    <section id="features">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h2
          data-reveal="words"
          className="text-[24px] font-semibold tracking-[-0.02em] text-[#141413] sm:text-[28px]"
        >
          <Words text="What it does" />
        </h2>
        <div className="mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              data-reveal
              /* Column-pairs share a delay so each row arrives together. */
              style={{ transitionDelay: `${(i % 2) * 60}ms` }}
            >
              <h3 className="text-[16px] font-semibold text-[#141413]">{f.title}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-[#544f46]">{f.body}</p>
              <ul className="mt-2.5 space-y-1 text-[14px] text-[#6b675e]">
                {f.points.map((p, j) => (
                  // The bullets fill in one after another, just behind their heading.
                  <li
                    key={p}
                    className="reveal-line flex gap-2"
                    style={{ transitionDelay: `${180 + j * 90}ms` }}
                  >
                    <span className="text-[#cf5535]">–</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
