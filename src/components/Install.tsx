import { LINKS } from '../data';

const STEPS = [
  'Open a project or Git repo. Sylor maps it read-only first.',
  'Describe a feature, refactor, or bug in plain language.',
  'Review the full diff before anything is written.',
  'Sylor runs your build and works through whatever broke.',
];

export function Install() {
  return (
    <section id="install" className="border-t border-[#e4e1d8]">
      <div className="mx-auto max-w-5xl px-6 py-20 text-center sm:py-28">
        <p data-reveal className="eyebrow">
          Install
        </p>
        <h2
          data-reveal
          style={{ transitionDelay: '60ms' }}
          className="mx-auto mt-5 max-w-[18ch] text-[34px] font-semibold tracking-[-0.03em] text-[#141413] sm:text-[48px]"
        >
          Set up in about a minute.
        </h2>

        <div
          data-reveal
          style={{ transitionDelay: '140ms' }}
          className="mt-8 flex flex-col items-center gap-3"
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

        <ol
          data-reveal
          style={{ transitionDelay: '200ms' }}
          className="mx-auto mt-16 grid max-w-4xl gap-x-8 gap-y-8 text-left sm:grid-cols-2 lg:grid-cols-4"
        >
          {STEPS.map((s, i) => (
            <li key={s} className="reveal-line" style={{ transitionDelay: `${220 + i * 90}ms` }}>
              <div className="text-[12px] font-semibold uppercase tracking-wider text-[#cf5535]">
                Step {i + 1}
              </div>
              <div className="mt-2.5 h-px w-full bg-[#e4e1d8]" />
              <p className="mt-3 text-[14px] leading-relaxed text-[#544f46]">{s}</p>
            </li>
          ))}
        </ol>

        <dl
          data-reveal
          className="mx-auto mt-16 grid max-w-3xl gap-x-10 gap-y-8 border-t border-[#e4e1d8] pt-10 text-left sm:grid-cols-2"
        >
          <div>
            <dt className="text-[14px] font-semibold text-[#141413]">What you need</dt>
            <dd className="mt-2 text-[14px] leading-relaxed text-[#544f46]">
              Windows 10 or 11, 64-bit, and a model — Ollama running locally at{' '}
              <span className="font-medium text-[#141413]">localhost:11434</span>, or any
              OpenAI-compatible endpoint you point Sylor at in Settings.
            </dd>
          </div>
          <div>
            <dt className="text-[14px] font-semibold text-[#141413]">Or skip the window</dt>
            <dd className="mt-2 text-[14px] leading-relaxed text-[#544f46]">
              The same engine runs headless:{' '}
              <span className="font-medium text-[#141413]">sylor -p "fix the failing test"</span>,
              with <span className="font-medium text-[#141413]">--json</span> when a script needs to
              read the result.
            </dd>
          </div>
        </dl>

        <p
          data-reveal
          className="mx-auto mt-10 max-w-[62ch] text-[13px] leading-relaxed text-[#6b675e]"
        >
          The Windows build is self-signed, so SmartScreen may warn on first run — click{' '}
          <span className="font-medium text-[#141413]">More info → Run anyway</span>.{' '}
          <a
            href={LINKS.releases}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[#141413] underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#cf5535]"
          >
            All releases on GitHub
          </a>
          .
        </p>
      </div>
    </section>
  );
}
