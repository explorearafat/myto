import { ArrowLeft, Download } from 'lucide-react';
import { LINKS, PLATFORMS, RELEASE } from '../data';
import { useReveals } from '../lib/reveal';
import { Footer } from './Footer';
import { Header } from './Header';

const RELEASE_FACTS = [
  { k: 'Current release', v: RELEASE.version },
  { k: 'Published', v: RELEASE.date },
  { k: 'Installer', v: RELEASE.size },
];

export function DownloadPage() {
  // The same single observer the product page uses.
  useReveals();

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <a className="skip-link" href="#platforms">
        Skip to downloads
      </a>
      <Header subpage />
      <main id="platforms" className="flex-1">
        <section className="relative overflow-hidden border-b border-[#e4e1d8]">
          {/* Same warm wash as the product hero, so the pages feel of a piece. */}
          <div aria-hidden="true" className="hero-aura" />
          <div className="relative mx-auto max-w-5xl px-6 pt-20 pb-16 text-center sm:pt-24 sm:pb-20">
            <p data-reveal className="eyebrow">
              Download
            </p>
            <h1
              data-reveal
              style={{ transitionDelay: '60ms' }}
              className="mx-auto mt-5 text-[44px] font-semibold leading-[1.0] tracking-[-0.04em] text-[#141413] sm:text-[64px]"
            >
              Get Sylor
            </h1>
            <p
              data-reveal
              style={{ transitionDelay: '140ms' }}
              className="mx-auto mt-5 max-w-[48ch] text-[18px] leading-relaxed text-[#544f46] sm:text-[20px]"
            >
              One build is ready today. The rest of this page is honest about where the others
              stand.
            </p>
            <dl
              data-reveal
              style={{ transitionDelay: '210ms' }}
              className="mx-auto mt-10 flex flex-wrap justify-center gap-x-12 gap-y-4"
            >
              {RELEASE_FACTS.map((s) => (
                <div key={s.k}>
                  <dt className="text-[12px] font-semibold uppercase tracking-wider text-[#9c988e]">
                    {s.k}
                  </dt>
                  <dd className="mt-1 text-[16px] font-semibold text-[#141413]">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <div className="grid gap-5 sm:grid-cols-2">
            {PLATFORMS.map((p) => (
              <div
                key={p.name}
                data-reveal
                className={
                  'rounded-2xl border p-6 ' +
                  (p.ready ? 'border-[#cf5535]/40 bg-white' : 'border-[#e4e1d8] bg-[#faf9f5]')
                }
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#141413]">
                    {p.name}
                  </h2>
                  {/* Status carries the meaning, so it gets the accent only when it is a yes. */}
                  <span
                    className={
                      'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ' +
                      (p.ready
                        ? 'border-[#e6b8ac] bg-[#fbeee9] text-[#a8442a]'
                        : 'border-[#e4e1d8] bg-[#f0eee6] text-[#6b675e]')
                    }
                  >
                    {p.status}
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] text-[#9c988e]">{p.requires}</p>
                <p
                  className="reveal-line mt-3 text-[15px] leading-relaxed text-[#544f46]"
                  style={{ transitionDelay: '150ms' }}
                >
                  {p.body}
                </p>
                {p.href && p.ready ? (
                  <a
                    href={p.href}
                    className="reveal-line mt-5 inline-flex items-center gap-2 rounded-full bg-[#141413] px-6 py-2.5 text-[15px] font-medium text-[#faf9f5] no-underline transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
                    style={{ transitionDelay: '220ms' }}
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {p.cta}
                  </a>
                ) : (
                  <div className="reveal-line mt-5" style={{ transitionDelay: '220ms' }}>
                    {p.href ? (
                      <a
                        href={p.href}
                        target={p.href.startsWith('http') ? '_blank' : undefined}
                        rel={p.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                        className="inline-flex items-center gap-2 rounded-full border border-[#141413]/20 px-6 py-2.5 text-[15px] font-medium text-[#141413] no-underline transition-colors duration-150 hover:border-[#141413]/50"
                      >
                        {p.cta}
                      </a>
                    ) : null}
                    <p className={(p.href ? 'mt-3 ' : '') + 'text-[13px] text-[#6b675e]'}>
                      {p.href ? null : 'Nothing to download yet. '}
                      <a
                        href={LINKS.releases}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-[#141413] underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#cf5535]"
                      >
                        Watch the releases page
                      </a>{' '}
                      to catch the {p.name} build when it lands.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            data-reveal
            className="mt-10 rounded-2xl border border-[#e4e1d8] bg-[#f0eee6] p-6 text-[14px] leading-relaxed text-[#544f46]"
          >
            <p>
              After installing, open a project folder and describe the first task. Sylor needs a
              model to talk to — Ollama on{' '}
              <span className="font-medium text-[#141413]">localhost:11434</span>, or any
              OpenAI-compatible endpoint you set in Settings.
            </p>
            <p className="mt-3">
              <a
                href="/#features"
                className="inline-flex items-center gap-1.5 font-medium text-[#141413] underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#cf5535]"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Read what Sylor does
              </a>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
