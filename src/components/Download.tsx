import { PLATFORMS, RELEASE, LINKS } from '../data';
import { WindowsMark, AndroidMark } from './PlatformIcons';

/* Only the platforms you can actually install today get a card here; the full
   matrix (with the planned ones, stated plainly) lives on /download. */
const READY = PLATFORMS.filter((p) => p.ready);

function Mark({ name, className }: { name: string; className?: string }) {
  if (name === 'Windows') return <WindowsMark className={className} />;
  if (name === 'Android') return <AndroidMark className={className} />;
  return null;
}

export function Download() {
  return (
    <section id="download" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="text-center">
          <h2
            data-reveal
            className="font-display font-normal text-[32px] tracking-[-0.02em] text-[#141413] sm:text-[40px]"
          >
            Download Sylor
          </h2>
          <div
            data-reveal
            style={{ transitionDelay: '70ms' }}
            className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#e4e1d8] bg-white px-3.5 py-1.5 text-[13px] font-medium text-[#6b675e]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#cf5535]" aria-hidden="true" />
            {RELEASE.version} · {RELEASE.date}
          </div>
        </div>

        <div className="mx-auto mt-12 grid max-w-3xl gap-5 sm:grid-cols-2">
          {READY.map((p) => (
            <div
              key={p.name}
              data-reveal
              className="flex flex-col rounded-2xl border border-[#e4e1d8] bg-white p-7 transition-[border-color,box-shadow] duration-200 hover:border-[#d8d3c8] hover:shadow-[0_18px_44px_-26px_rgba(20,20,19,0.3)]"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#eadfd9] bg-[#faf1ee] text-[#cf5535]">
                <Mark name={p.name} className="h-6 w-6" />
              </div>
              <h3 className="mt-5 font-display font-normal text-[22px] tracking-[-0.01em] text-[#141413]">
                {p.name}
              </h3>
              <p className="mt-1 text-[13px] text-[#9c988e]">{p.requires}</p>
              <p className="mt-3 flex-1 text-[15px] leading-relaxed text-[#544f46]">{p.body}</p>
              <a
                href={p.href}
                className="mt-6 inline-flex items-center justify-center gap-2.5 rounded-lg bg-[#141413] px-5 py-3 text-[15px] font-medium text-[#faf9f5] no-underline transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
              >
                <Mark name={p.name} className="h-[17px] w-[17px]" />
                {p.cta}
              </a>
            </div>
          ))}
        </div>

        <p
          data-reveal
          className="mx-auto mt-8 max-w-[52ch] text-center text-[14px] leading-relaxed text-[#6b675e]"
        >
          macOS and Linux are planned.{' '}
          <a
            href={LINKS.downloadPage}
            className="font-medium text-[#a8442a] no-underline underline decoration-[#e6b8ac] underline-offset-2 transition-colors duration-150 hover:decoration-[#cf5535]"
          >
            See all platforms and every release
          </a>
          .
        </p>
      </div>
    </section>
  );
}
