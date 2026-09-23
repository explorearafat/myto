import { LINKS } from '../data';
import { WindowsMark, AndroidMark } from './PlatformIcons';

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

          <div
            data-reveal
            style={{ transitionDelay: '170ms' }}
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <a
              href={LINKS.download}
              className="inline-flex h-12 items-center justify-center gap-2.5 rounded-lg bg-[#141413] px-5 text-[15px] font-medium text-[#faf9f5] no-underline shadow-[0_2px_10px_-4px_rgba(20,20,19,0.45)] transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
            >
              <WindowsMark className="h-[18px] w-[18px]" />
              Download for Windows
            </a>
            <a
              href={LINKS.androidApk}
              className="inline-flex h-12 items-center justify-center gap-2.5 rounded-lg border border-[#141413]/20 bg-white px-5 text-[15px] font-medium text-[#141413] no-underline transition-colors duration-150 hover:border-[#141413]/40 hover:bg-[#faf9f5]"
            >
              <AndroidMark className="h-[18px] w-[18px]" />
              Get it on Android
            </a>
          </div>

          <p
            data-reveal
            style={{ transitionDelay: '230ms' }}
            className="mt-5 text-[14px] text-[#6b675e]"
          >
            <a
              href={LINKS.downloadPage}
              className="font-medium text-[#57544e] no-underline transition-colors duration-150 hover:text-[#141413]"
            >
              macOS &amp; Linux, and every release &rarr;
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
