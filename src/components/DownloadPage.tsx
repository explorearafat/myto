import { ArrowRight, Download } from 'lucide-react';
import { LINKS, PLATFORMS, RELEASE, type Platform } from '../data';
import { useReveals } from '../lib/reveal';
import { AndroidMark, WindowsMark } from './PlatformIcons';
import { MytoMark } from './MytoMark';
import { Footer } from './Footer';
import { Header } from './Header';

/* Per-platform brand glyph. Windows/Android have their own marks; the planned
   platforms (iOS, Linux, macOS) fall back to the Myto mark. */
function Mark({ name, className }: { name: string; className?: string }) {
  if (name === 'Windows') return <WindowsMark className={className} />;
  if (name === 'Android') return <AndroidMark className={className} />;
  return <MytoMark className={className} />;
}

/*
 * One alternating block per platform. `flip` mirrors the row on wide screens so
 * blocks read left / right / left …; on mobile everything stacks. The small-font
 * Myto docs note sits on the OPPOSITE side of the download column.
 */
function PlatformBlock({ platform, flip }: { platform: Platform; flip: boolean }) {
  const version = platform.version ?? RELEASE.version;
  const file = platform.href ? platform.href.split('/').pop() : '';
  return (
    <div
      data-reveal
      className={
        'flex flex-col gap-10 py-14 sm:flex-row sm:items-center sm:gap-16 sm:py-16 ' +
        (flip ? 'sm:flex-row-reverse' : '')
      }
    >
      {/* PLATFORM_BLOCK_BODY */}
      {/* Download column — name, version, framed description, low white button. */}
      <div className="flex-1">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#e3e1d8] bg-[#f0efe9] text-[#141413]">
            <Mark name={platform.name} className="h-[22px] w-[22px]" />
          </span>
          <h2 className="font-display font-normal text-[28px] tracking-[-0.01em] text-[#141413]">
            {platform.name}
          </h2>
          <span className="font-mono text-[13px] text-[#9c988e]">{version}</span>
        </div>

        <div className="mt-6 border-t border-[#e9e6dd]" />
        <p className="py-5 text-[15.5px] leading-relaxed text-[#544f46]">{platform.body}</p>
        <div className="border-t border-[#e9e6dd]" />

        {platform.ready ? (
          <a
            href={platform.href}
            className="mt-6 inline-flex items-center gap-2.5 rounded-lg border border-[#e4e1d8] bg-white px-5 py-3 text-[15px] font-medium text-[#141413] no-underline transition-colors duration-150 hover:border-[#d8d3c8] hover:bg-[#faf9f5] active:translate-y-px"
          >
            <Download className="h-[17px] w-[17px]" aria-hidden="true" />
            {platform.cta ?? 'Download'}
          </a>
        ) : (
          <span
            aria-disabled="true"
            className="mt-6 inline-flex cursor-not-allowed items-center gap-2.5 rounded-lg border border-dashed border-[#ded9cc] bg-[#faf9f5] px-5 py-3 text-[15px] font-medium text-[#9c988e]"
          >
            Coming soon
          </span>
        )}
        {platform.ready && file ? (
          <p className="mt-3 font-mono text-[12.5px] text-[#9c988e]">
            {file}
            {platform.size ? ` · ${platform.size}` : ''}
          </p>
        ) : null}
      </div>

      {/* Docs note — small font, opposite side. */}
      <div className="sm:w-[280px] sm:flex-none">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#9c988e]">
          {platform.status}
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-[#6b675e]">
          <span className="font-medium text-[#57544e]">Requires:</span> {platform.requires}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-[#6b675e]">
          {platform.note ??
            'Free to use — bring your own model and point Myto at any OpenAI-compatible endpoint or a local Ollama.'}
        </p>
        <a
          href="/#docs"
          className="group mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-[#141413] no-underline underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
        >
          Read the docs
          <ArrowRight
            className="h-3 w-3 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </a>
      </div>
    </div>
  );
}

export function DownloadPage() {
  // The same single scroll-reveal observer the product page uses.
  useReveals();

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <a className="skip-link" href="#get">
        Skip to downloads
      </a>
      {/* DOWNLOAD_PAGE_BODY */}
      <Header subpage />
      <main id="get" className="flex-1">
        <section className="relative overflow-hidden border-b border-[#e9e6dd]">
          <div aria-hidden="true" className="hero-aura" />
          <div className="relative mx-auto max-w-4xl px-6 pt-20 pb-14 text-center sm:pt-28 sm:pb-16">
            <p data-reveal className="eyebrow">
              Download
            </p>
            <h1
              data-reveal
              style={{ transitionDelay: '60ms' }}
              className="mx-auto mt-5 font-display font-normal text-[44px] leading-[1.02] tracking-[-0.02em] text-[#141413] sm:text-[64px]"
            >
              Get Myto
            </h1>
            <p
              data-reveal
              style={{ transitionDelay: '130ms' }}
              className="mx-auto mt-6 max-w-[46ch] text-[18px] leading-relaxed text-[#544f46] sm:text-[20px]"
            >
              The full coding workspace on your desktop, and a native chat app in your pocket.
              Free — bring your own model.
            </p>
          </div>
        </section>

        {/* Alternating platform blocks — Android, Windows, iOS, Linux, macOS. */}
        <section className="mx-auto max-w-5xl px-6">
          <div className="divide-y divide-[#eceae2]">
            {PLATFORMS.map((p, i) => (
              // A custom component with `key` trips tsc (no @types/react) — key the wrapper.
              <div key={p.name}>
                <PlatformBlock platform={p} flip={i % 2 === 1} />
              </div>
            ))}
          </div>
        </section>

        {/* One quiet closing line, then back to the product page. */}
        <section className="border-t border-[#e9e6dd]">
          <div className="mx-auto max-w-3xl px-6 py-14 text-center sm:py-16">
            <p data-reveal className="text-[15px] leading-relaxed text-[#6b675e]">
              Every build is served from the public{' '}
              <a
                href={LINKS.releases}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-[#141413] no-underline underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
              >
                myto-dist releases page
              </a>
              . Myto needs a model to talk to — a local Ollama, or any OpenAI-compatible endpoint.
            </p>
            <div data-reveal className="mt-6">
              <a
                href="/#docs"
                className="inline-flex items-center gap-1.5 text-[14px] font-medium text-[#141413] no-underline underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
              >
                Read what Myto does
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer subpage />
    </div>
  );
}
