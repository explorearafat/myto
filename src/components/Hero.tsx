import { LINKS } from '../data';
import { SylorStar } from './SylorStar';

/*
 * Honest stand-in for the reference page's "trusted by" logo wall: Sylor has no
 * customer logos to show, so this states what it actually plugs into instead.
 */
const WORKS_WITH = ['Ollama', 'OpenAI-compatible', 'MCP', 'Markdown skills'];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* The cinematic warm wash behind the name — static, nothing repaints on scroll. */}
      <div aria-hidden="true" className="hero-aura" />

      {/* The mark is the centrepiece: bare on the wash (no tile), the whole lockup
          centred in the first screen. */}
      <div className="relative mx-auto flex min-h-[86svh] max-w-5xl flex-col items-center justify-center px-6 py-16 text-center">
        {/* The terracotta star, sitting straight on the gradient — the universal Sylor mark. */}
        <div data-reveal className="flex justify-center">
          <SylorStar className="h-[68px] w-[68px] drop-shadow-[0_5px_18px_rgba(207,85,53,0.32)] sm:h-24 sm:w-24" />
        </div>

        {/* The wordmark, directly under the mark — bigger, tighter, more deliberate. */}
        <h1
          data-reveal
          style={{ transitionDelay: '90ms' }}
          className="mt-7 text-[72px] font-semibold leading-[0.88] tracking-[-0.055em] text-[#141413] sm:mt-9 sm:text-[112px]"
        >
          Sylor
        </h1>
        <p
          data-reveal
          style={{ transitionDelay: '160ms' }}
          className="mx-auto mt-6 max-w-[40ch] text-balance text-[19px] leading-relaxed text-[#544f46] sm:text-[22px]"
        >
          A dependable coding agent&mdash;on your own machine.
        </p>

        {/* One prominent black pill, plus a quiet second option. */}
        <div
          data-reveal
          style={{ transitionDelay: '240ms' }}
          className="mt-9 flex flex-col items-center gap-4"
        >
          <a
            href={LINKS.downloadPage}
            className="inline-flex items-center justify-center rounded-full bg-[#141413] px-7 py-3.5 text-[16px] font-medium text-[#faf9f5] no-underline shadow-[0_2px_12px_-2px_rgba(20,20,19,0.45)] transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
          >
            Download for Windows
          </a>
          <a
            href={LINKS.web}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[14px] font-medium text-[#6b675e] no-underline transition-colors duration-150 hover:text-[#141413]"
          >
            or try it in your browser &rarr;
          </a>
        </div>

        {/* Honest analog of a logo wall. */}
        <div data-reveal style={{ transitionDelay: '320ms' }} className="mt-16">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#9c988e]">
            Works with
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[15px] font-semibold text-[#8b8578]">
            {WORKS_WITH.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        </div>
      </div>

      {/* The big product shot, rising from the bottom of the hero. */}
      <div
        data-reveal
        style={{ transitionDelay: '400ms' }}
        className="relative mx-auto mt-16 max-w-5xl px-6 pb-16 sm:pb-24"
      >
        <img
          src="/shots/chat.jpg"
          alt="The Sylor workspace: an assistant reply with an inline diff of a settings file and a build command below it."
          width={1440}
          height={900}
          loading="eager"
          decoding="async"
          className="mx-auto w-full rounded-2xl border border-[#141413]/10 bg-white shadow-[0_50px_130px_-45px_rgba(20,20,19,0.55)]"
        />
      </div>
    </section>
  );
}
