import { LINKS } from '../data';

/* Truthful to how Myto actually runs: choose a model, describe the work, approve
   each diff, and let it verify against your build. Rendered as the landing
   page's single dark band — the one high-contrast moment on the page. */
const STEPS = [
  {
    title: 'Choose your model',
    body: 'Point Myto at a local Ollama or any OpenAI-compatible endpoint.',
  },
  {
    title: 'Describe the task',
    body: 'Say what to build, fix, or explain — in plain language, in your project.',
  },
  {
    title: 'Review each diff',
    body: 'Every edit arrives as a diff you approve. Commands and network access ask first.',
  },
  {
    title: 'Ship it verified',
    body: 'Myto runs your build and tests, reads the errors, and fixes until it passes.',
  },
];

export function HowItWorks() {
  return (
    <section className="dark-band border-b border-[#141413]">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
        <div className="text-center">
          <p
            data-reveal
            className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#8a857a]"
          >
            The workflow
          </p>
          <h2
            data-reveal
            style={{ transitionDelay: '60ms' }}
            className="mt-3 font-display text-[34px] font-normal tracking-[-0.02em] sm:text-[44px]"
          >
            How it works
          </h2>
          <p
            data-reveal
            style={{ transitionDelay: '120ms' }}
            className="band-muted mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed"
          >
            From an empty chat to a change that compiles, in four steps.
          </p>
        </div>

        <div className="relative mt-20">
          {/* The line that threads the four steps — behind the badges, which cover it. */}
          <div
            aria-hidden="true"
            className="absolute left-[12.5%] right-[12.5%] top-6 hidden border-t border-dashed border-[#3a362e] sm:block"
          />
          <div className="grid gap-12 sm:grid-cols-4 sm:gap-6">
            {STEPS.map((s, i) => (
              <div
                key={s.title}
                data-reveal
                style={{ transitionDelay: `${i * 80}ms` }}
                className="relative flex flex-col items-center text-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[#4a463d] bg-[#232119] font-display text-[18px] text-[#faf9f5]">
                  {i + 1}
                </div>
                <h3 className="mt-5 font-display text-[19px] font-normal tracking-[-0.01em]">
                  {s.title}
                </h3>
                <p className="band-muted mt-2.5 max-w-[26ch] text-[15px] leading-relaxed">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div data-reveal className="mt-16 flex flex-wrap justify-center gap-3">
          <a
            href={LINKS.downloadPage}
            className="btn px-7 py-3.5 text-[15.5px] font-medium"
            style={{ background: '#faf9f5', color: '#141413' }}
          >
            Download for Windows
          </a>
          <a
            href={LINKS.useCasesPage}
            className="btn px-7 py-3.5 text-[15.5px] text-[#c9c4b8] hover:text-[#faf9f5]"
            style={{ border: '1px solid #3a362e' }}
          >
            See who it&rsquo;s for
          </a>
        </div>
      </div>
    </section>
  );
}
