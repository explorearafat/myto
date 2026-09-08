import { ArrowLeft, Download } from 'lucide-react';
import { LINKS, PLATFORMS, RELEASE } from '../data';
import { useReveals } from '../lib/reveal';
import { Backdrop } from './Backdrop';
import { Footer } from './Footer';
import { Header } from './Header';
import { Words } from './Words';

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
          <Backdrop fade="down" bloom />
          <div className="relative mx-auto max-w-3xl px-6 pt-14 pb-12 sm:pt-20 sm:pb-16">
            <h1
              data-reveal="words"
              className="text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] text-[#141413] sm:text-[40px]"
            >
              <Words text="Download Sylor" step={60} />
            </h1>
            <p
              data-reveal
              style={{ transitionDelay: '200ms' }}
              className="mt-4 max-w-[52ch] text-[16px] leading-relaxed text-[#3f3b34] sm:text-[17px]"
            >
              One build is ready today. The rest of this page is honest about where the others
              stand.
            </p>
            <dl
              data-reveal
              style={{ transitionDelay: '270ms' }}
              className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-[#e4e1d8] pt-6"
            >
              <div>
                <dt className="text-[12px] text-[#6b675e]">Current release</dt>
                <dd className="mt-0.5 text-[14px] text-[#141413]">{RELEASE.version}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-[#6b675e]">Published</dt>
                <dd className="mt-0.5 text-[14px] text-[#141413]">{RELEASE.date}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-[#6b675e]">Installer</dt>
                <dd className="mt-0.5 text-[14px] text-[#141413]">{RELEASE.size}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-14 sm:py-16">
          <div className="divide-y divide-[#e4e1d8]">
            {PLATFORMS.map((p) => (
              <div key={p.name} data-reveal className="py-7 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-[#141413]">
                    {p.name}
                  </h2>
                  {/* Status carries the meaning, so it gets the accent only when it is a yes. */}
                  <span
                    className={
                      'rounded border px-1.5 py-0.5 text-[11px] ' +
                      (p.ready
                        ? 'border-[#e6b8ac] bg-[#fbeee9] text-[#a8442a]'
                        : 'border-[#e4e1d8] bg-[#f0eee6] text-[#6b675e]')
                    }
                  >
                    {p.status}
                  </span>
                  <span className="text-[13px] text-[#6b675e]">{p.requires}</span>
                </div>
                <p
                  className="reveal-line mt-2.5 max-w-[68ch] text-[15px] leading-relaxed text-[#544f46]"
                  style={{ transitionDelay: '150ms' }}
                >
                  {p.body}
                </p>
                {p.href ? (
                  <a
                    href={p.href}
                    target={p.href.startsWith('http') && !p.ready ? '_blank' : undefined}
                    rel={p.href.startsWith('http') && !p.ready ? 'noopener noreferrer' : undefined}
                    className={
                      'reveal-line mt-4 inline-flex items-center gap-2 rounded-md text-[15px] no-underline transition-colors duration-150 ' +
                      (p.ready
                        ? 'bg-[#cf5535] px-5 py-2.5 font-medium text-white hover:bg-[#b8482c] active:translate-y-px'
                        : 'border border-[#cbc6ba] px-4 py-2 text-[#141413] hover:border-[#141413]')
                    }
                    style={{ transitionDelay: '220ms' }}
                  >
                    {p.ready ? <Download className="h-4 w-4" aria-hidden="true" /> : null}
                    {p.cta}
                  </a>
                ) : (
                  <p
                    className="reveal-line mt-4 text-[13px] text-[#6b675e]"
                    style={{ transitionDelay: '220ms' }}
                  >
                    Nothing to download yet.{' '}
                    <a
                      href={LINKS.releases}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#141413] underline decoration-[#cbc6ba] transition-colors duration-150 hover:decoration-[#cf5535]"
                    >
                      Watch the releases page
                    </a>{' '}
                    to catch the {p.name} build when it lands.
                  </p>
                )}
              </div>
            ))}
          </div>

          <div
            data-reveal
            className="mt-12 border-t border-[#e4e1d8] pt-7 text-[14px] leading-relaxed text-[#6b675e]"
          >
            <p>
              After installing, open a project folder and describe the first task. Sylor needs a
              model to talk to — Ollama on{' '}
              <span className="text-[#141413]">localhost:11434</span>, or any OpenAI-compatible
              endpoint you set in Settings.
            </p>
            <p className="mt-3">
              <a
                href="/#features"
                className="inline-flex items-center gap-1.5 text-[#141413] underline decoration-[#cbc6ba] transition-colors duration-150 hover:decoration-[#cf5535]"
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
