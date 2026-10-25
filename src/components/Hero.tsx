import { Download } from 'lucide-react';
import { MytoMark } from './MytoMark';
import { LINKS } from '../data';
import { AppWindowMockup, StatStrip } from './objects';
import { Hero3D } from './Hero3D';

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-[#e9e6dd]">
      {/* Soft brand washes behind the hero object. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(46% 42% at 78% 22%, rgba(26,107,82,0.08), transparent 70%), radial-gradient(40% 38% at 12% 8%, rgba(20,20,19,0.05), transparent 70%)',
        }}
      />
      <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-10 sm:pb-24 sm:pt-14">
        {/* The 3D gyroscope floats behind everything at low opacity. */}
        <Hero3D />
        {/* Announcement chip — what's new, one tap from the hero. */}
        <div className="flex justify-center">
          <a href={LINKS.communityPage} className="announce-chip">
            <span>
              New — Discover, the Myto community. Post, react, follow.
            </span>
            <span>New</span>
          </a>
        </div>

        {/* Two-column hero: the words left, the product right — the object IS the
            pitch, so the section needs no decoration. */}
        <div className="mt-12 grid items-center gap-12 lg:mt-16 lg:grid-cols-[1fr_540px]">
          <div data-reveal>
            <h1 className="max-w-[15ch] font-display text-[44px] font-normal leading-[1.02] tracking-[-0.025em] text-[#141413] sm:text-[60px] lg:text-[72px]">
              Your coding agent, on any model.
            </h1>
            <p className="mt-7 max-w-[46ch] text-[18px] leading-relaxed text-[#544f46] sm:text-[20px]">
              Myto reads your project, edits with your approval, and runs your build — with the
              model you choose, running locally or on your own endpoint.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href={LINKS.downloadPage}
                className="btn btn-dark px-8 py-4 text-[16.5px]"
              >
                <Download className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
                Download Myto
              </a>
              <a href={LINKS.chatPage} className="btn btn-ghost px-7 py-4 text-[16px]">
                Try in browser
              </a>
            </div>
            <div className="mt-12 border-t border-[#e9e6dd] pt-7">
              <StatStrip />
            </div>
          </div>

          {/* The drawn product object, with a soft glow behind it. */}
          <div data-reveal style={{ transitionDelay: '120ms' }} className="object-glow">
            <AppWindowMockup />
          </div>
        </div>

        {/* The wordmark keeps its quiet centered moment below the mockup. */}
        <div data-reveal style={{ transitionDelay: '200ms' }} className="mt-16 flex justify-center">
          <MytoMark size={48} />
        </div>
      </div>
    </section>
  );
}
