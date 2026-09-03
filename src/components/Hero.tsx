import { Download } from 'lucide-react';
import { GLANCE, LINKS } from '../data';
import { Backdrop } from './Backdrop';
import { Words } from './Words';

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <Backdrop fade="down" bloom />
      <div className="relative mx-auto max-w-3xl px-6 pt-16 pb-14 sm:pt-24 sm:pb-20">
        {/* The headline arrives word by word; the lines below it follow as blocks,
            each ~70ms after the one above, so the hero settles in reading order. */}
        <h1
          data-reveal="words"
          className="text-[34px] font-semibold leading-[1.1] tracking-[-0.02em] text-[#141413] sm:text-[44px]"
        >
          <Words text="Build with your tools still in reach." step={55} />
        </h1>
        <p
          data-reveal
          style={{ transitionDelay: '260ms' }}
          className="mt-5 max-w-[48ch] text-[17px] leading-relaxed text-[#3f3b34] sm:text-[18px]"
        >
          A dependable coding workspace that reads your project, uses the tools you approve, and
          turns working ideas into working software.
        </p>
        <div
          data-reveal
          style={{ transitionDelay: '330ms' }}
          className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3"
        >
          <a
            href={LINKS.downloadPage}
            className="inline-flex items-center gap-2 rounded-md bg-[#cf5535] px-5 py-2.5 text-[15px] font-medium text-white no-underline transition-colors duration-150 hover:bg-[#b8482c] active:translate-y-px"
          >
            <Download className="h-4 w-4" />
            Download Sylor
          </a>
          <a
            href={LINKS.web}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[15px] text-[#141413] underline decoration-[#cbc6ba] transition-colors duration-150 hover:decoration-[#cf5535]"
          >
            Try it in your browser
          </a>
        </div>
        <p
          data-reveal
          style={{ transitionDelay: '390ms' }}
          className="mt-5 text-[13px] text-[#6b675e]"
        >
          Free for Windows 10 &amp; 11. macOS and Linux coming soon.
        </p>

        {/* Plain ask, plain answer — what a turn actually looks like. */}
        <div
          data-reveal
          style={{ transitionDelay: '450ms' }}
          className="mt-11 overflow-hidden rounded-lg border border-[#e4e1d8] bg-white"
        >
          <p className="px-4 pt-3.5 text-[12px] text-[#6b675e]">You</p>
          <p className="px-4 pb-3.5 text-[15px] text-[#141413]">
            Add a settings page and wire it into the router
            {/* Drawn, not typed: a block glyph would fall outside the Inter subset
                and pick up a different font's metrics on every OS. */}
            <span
              className="caret ml-1 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-[#cf5535]"
              aria-hidden="true"
            />
          </p>
          <p className="border-t border-[#e4e1d8] bg-[#faf9f5] px-4 py-3 text-[13px] leading-relaxed text-[#6b675e]">
            Sylor reads the files it needs, plans the steps, shows you the diff, then runs your
            build.
          </p>
        </div>

        <dl
          data-reveal
          style={{ transitionDelay: '510ms' }}
          className="mt-10 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-[#e4e1d8] pt-6 sm:grid-cols-4"
        >
          {GLANCE.map((g) => (
            <div key={g.label}>
              <dt className="text-[12px] text-[#6b675e]">{g.label}</dt>
              <dd className="mt-0.5 text-[14px] text-[#141413]">{g.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
