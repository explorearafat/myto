import { FEATURES } from '../data';

export function Features() {
  return (
    <section id="features">
      <div className="mx-auto max-w-5xl px-6 py-16 text-center sm:py-24">
        <p data-reveal className="eyebrow">
          What it does
        </p>
        <h2
          data-reveal
          style={{ transitionDelay: '60ms' }}
          className="mx-auto mt-5 max-w-[24ch] text-[30px] font-semibold tracking-[-0.025em] text-[#141413] sm:text-[42px]"
        >
          Six things it does well
        </h2>
        <div className="mt-14 grid gap-5 text-left sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              data-reveal
              /* Row-mates share a delay so each row of cards arrives together. */
              style={{ transitionDelay: `${(i % 3) * 60}ms` }}
              className="rounded-2xl border border-[#e4e1d8] bg-white p-6 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-1 hover:border-[#d8d3c8] hover:shadow-[0_18px_44px_-26px_rgba(20,20,19,0.3)]"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#faf1ee] text-[14px] font-semibold text-[#cf5535]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="text-[18px] font-semibold text-[#141413]">{f.title}</h3>
              </div>
              <p className="mt-4 text-[15px] leading-relaxed text-[#141413]">{f.body}</p>
              <ul className="mt-4 space-y-2 border-t border-[#eceae2] pt-4 text-[14px] leading-relaxed text-[#544f46]">
                {f.points.map((p, j) => (
                  // The bullets fill in one after another, just behind their card.
                  <li
                    key={p}
                    className="reveal-line flex gap-2.5"
                    style={{ transitionDelay: `${180 + j * 80}ms` }}
                  >
                    <span
                      className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#cf5535]"
                      aria-hidden="true"
                    />
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
