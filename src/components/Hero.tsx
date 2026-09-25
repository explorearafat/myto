import { Download } from 'lucide-react';
import { MytoMark } from './MytoMark';
import { LINKS } from '../data';

export function Hero() {
  return (
    <section className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:py-28 lg:py-32">
        <div className="max-w-2xl">
          <h1
            data-reveal
            className="font-display font-normal text-[44px] leading-[1.04] tracking-[-0.02em] text-[#141413] sm:text-[58px]"
          >
            Your coding agent, on any model.
          </h1>
          <p
            data-reveal
            style={{ transitionDelay: '90ms' }}
            className="mt-6 max-w-[48ch] text-[18px] leading-relaxed text-[#544f46] sm:text-[20px]"
          >
            Myto reads your project, edits with your approval, and runs your build — with the
            model you choose, running locally or on your own endpoint.
          </p>
        </div>

        {/* Logo mark + single download call-to-action, centered on the page below the intro. */}
        <div
          data-reveal
          style={{ transitionDelay: '170ms' }}
          className="mt-14 flex flex-col items-center gap-5"
        >
          {/* Logo only — no wordmark. */}
          <MytoMark size={64} />
          {/* Borderless — just text and a glyph, quiet hover. The header keeps the solid pill. */}
          <a
            href={LINKS.downloadPage}
            className="group inline-flex items-center gap-2.5 text-[17px] font-medium text-[#141413] no-underline transition-opacity duration-150 hover:opacity-70"
          >
            <Download
              className="h-[19px] w-[19px] transition-transform duration-150 group-hover:translate-y-0.5"
              strokeWidth={1.9}
              aria-hidden="true"
            />
            Download
          </a>
        </div>
      </div>
    </section>
  );
}
