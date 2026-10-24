import { Download } from 'lucide-react';
import { MytoMark } from './MytoMark';
import { LINKS } from '../data';
import { AppWindowMockup, StatStrip } from './objects';

export function Hero() {
  return (
    <section className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-16 sm:pb-20 sm:pt-24">
        {/* Two-column hero: the words left, the product right — the object IS the
            pitch, so the section needs no decoration. */}
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_540px]">
          <div data-reveal>
            <h1 className="max-w-[16ch] font-display text-[42px] font-normal leading-[1.04] tracking-[-0.02em] text-[#141413] sm:text-[56px] lg:text-[62px]">
              Your coding agent, on any model.
            </h1>
            <p className="mt-6 max-w-[46ch] text-[17.5px] leading-relaxed text-[#544f46] sm:text-[19px]">
              Myto reads your project, edits with your approval, and runs your build — with the
              model you choose, running locally or on your own endpoint.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={LINKS.downloadPage}
                className="inline-flex items-center gap-2.5 rounded-full bg-[#141413] px-7 py-3.5 text-[16px] font-medium text-[#faf9f5] no-underline shadow-[0_10px_30px_-12px_rgba(20,20,19,0.45)] transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98]"
              >
                <Download className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
                Download Myto
              </a>
              <a
                href={LINKS.chatPage}
                className="inline-flex items-center rounded-full border border-[#e3e1d8] bg-white px-6 py-3.5 text-[15.5px] font-medium text-[#141413] no-underline transition-colors hover:border-[#c9c4b8]"
              >
                Try in browser
              </a>
            </div>
            <div className="mt-10 border-t border-[#e9e6dd] pt-6">
              <StatStrip />
            </div>
          </div>

          {/* The drawn product object. */}
          <div data-reveal style={{ transitionDelay: '120ms' }}>
            <AppWindowMockup />
          </div>
        </div>

        {/* The wordmark keeps its quiet centered moment below the mockup. */}
        <div data-reveal style={{ transitionDelay: '200ms' }} className="mt-14 flex justify-center">
          <MytoMark size={44} />
        </div>
      </div>
    </section>
  );
}
