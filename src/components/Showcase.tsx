import { SHOWCASE } from '../data';

export function Showcase() {
  return (
    <section id="inside" className="border-y border-[#e4e1d8] bg-[#f0eee6]">
      {/* Centred section header, then the alternating rows below it. */}
      <div className="mx-auto max-w-5xl px-6 pt-16 text-center sm:pt-24">
        <p data-reveal className="eyebrow">
          A look inside
        </p>
        <h2
          data-reveal
          style={{ transitionDelay: '60ms' }}
          className="mx-auto mt-5 max-w-[20ch] text-[30px] font-semibold tracking-[-0.025em] text-[#141413] sm:text-[42px]"
        >
          See the actual app
        </h2>
        <p
          data-reveal
          style={{ transitionDelay: '140ms' }}
          className="mx-auto mt-4 max-w-[52ch] text-[16px] leading-relaxed text-[#544f46]"
        >
          Screenshots from the app. The sample project is there to fill the window.
        </p>
      </div>

      <div className="mx-auto max-w-5xl px-6 pb-16 sm:pb-24">
        <div className="mt-14 space-y-16 sm:space-y-24">
          {SHOWCASE.map((s, i) => (
            <div
              key={s.title}
              data-reveal
              className="grid items-center gap-8 md:grid-cols-5 md:gap-12"
            >
              {/* Text first in the DOM so the heading is read before its image; on
                  wide screens odd rows push it right, which puts the shot left. */}
              <div className={'md:col-span-2' + (i % 2 === 0 ? ' md:order-2' : '')}>
                <span className="text-[13px] font-semibold tracking-wider text-[#cf5535]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-2 text-[22px] font-semibold tracking-[-0.02em] text-[#141413] sm:text-[26px]">
                  {s.title}
                </h3>
                <p
                  className="reveal-line mt-3 text-[16px] leading-relaxed text-[#544f46]"
                  style={{ transitionDelay: '160ms' }}
                >
                  {s.body}
                </p>
              </div>
              <img
                src={s.img}
                alt={s.alt}
                width={1440}
                height={900}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
                className="w-full rounded-2xl border border-[#141413]/10 bg-white shadow-[0_16px_50px_-24px_rgba(20,20,19,0.28)] transition-[transform,box-shadow] duration-500 ease-out hover:-translate-y-1.5 hover:shadow-[0_28px_60px_-24px_rgba(20,20,19,0.35)] md:col-span-3"
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
