import { SHOWCASE } from '../data';
import { Words } from './Words';

export function Showcase() {
  return (
    <section id="inside" className="border-y border-[#e4e1d8] bg-[#f0eee6]">
      {/* Heading keeps the page's 3xl text column; the rows below are wider so the
          screenshots have room to be legible. */}
      <div className="mx-auto max-w-3xl px-6 pt-16 sm:pt-20">
        <h2
          data-reveal="words"
          className="text-[24px] font-semibold tracking-[-0.02em] text-[#141413] sm:text-[28px]"
        >
          <Words text="A look inside" />
        </h2>
        <p
          data-reveal
          style={{ transitionDelay: '180ms' }}
          className="mt-2 text-[14px] text-[#6b675e]"
        >
          Screenshots from the app. The sample project is there to fill the window.
        </p>
      </div>

      <div className="mx-auto max-w-5xl px-6 pb-16 sm:pb-20">
        <div className="mt-10 divide-y divide-[#e4e1d8]">
          {SHOWCASE.map((s, i) => (
            <div
              key={s.title}
              data-reveal
              className="grid items-center gap-7 py-10 first:pt-0 last:pb-0 md:grid-cols-5 md:gap-10 md:py-14"
            >
              {/* Text first in the DOM so the heading is read before its image; on
                  wide screens odd rows push it right, which puts the shot left. */}
              <div className={'md:col-span-2' + (i % 2 === 0 ? ' md:order-2' : '')}>
                <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-[#141413] sm:text-[21px]">
                  {s.title}
                </h3>
                <p
                  className="reveal-line mt-2.5 text-[15px] leading-relaxed text-[#544f46]"
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
                className="w-full rounded-lg border border-[#e4e1d8] bg-white transition-[transform,border-color] duration-500 ease-out hover:-translate-y-1 hover:border-[#cbc6ba] md:col-span-3"
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
