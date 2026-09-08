import { Download } from 'lucide-react';
import { LINKS } from '../data';
import { Backdrop } from './Backdrop';
import { Words } from './Words';

const STEPS = [
  'Open a project or Git repo. Sylor maps it read-only first.',
  'Describe a feature, refactor, or bug in plain language.',
  'Review the full diff before anything is written.',
  'Sylor runs your build and works through whatever broke.',
];

export function Install() {
  return (
    <section
      id="install"
      className="relative overflow-hidden border-t border-[#e4e1d8] bg-[#f0eee6]"
    >
      {/* Same ruling as the hero, fading upward — the page closes the way it opened. */}
      <Backdrop fade="up" />
      <div className="relative mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h2
          data-reveal="words"
          className="text-[24px] font-semibold tracking-[-0.02em] text-[#141413] sm:text-[28px]"
        >
          <Words text="Install" />
        </h2>
        <a
          data-reveal
          style={{ transitionDelay: '70ms' }}
          href={LINKS.downloadPage}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-[#cf5535] px-5 py-2.5 text-[15px] font-medium text-white no-underline transition-colors duration-150 hover:bg-[#b8482c] active:translate-y-px"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download Sylor
        </a>
        <ol
          data-reveal
          style={{ transitionDelay: '120ms' }}
          className="mt-8 space-y-3 text-[15px] leading-relaxed text-[#544f46]"
        >
          {STEPS.map((s, i) => (
            <li
              key={s}
              className="reveal-line flex gap-3"
              style={{ transitionDelay: `${200 + i * 90}ms` }}
            >
              <span className="mt-0.5 text-[13px] font-semibold text-[#6b675e]">{i + 1}.</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>

        <dl
          data-reveal
          className="mt-10 grid gap-x-10 gap-y-6 border-t border-[#e4e1d8] pt-7 sm:grid-cols-2"
        >
          <div>
            <dt className="text-[13px] font-semibold text-[#141413]">What you need</dt>
            <dd className="mt-1 text-[14px] leading-relaxed text-[#544f46]">
              Windows 10 or 11, 64-bit, and a model — Ollama running locally at{' '}
              <span className="text-[#141413]">localhost:11434</span>, or any OpenAI-compatible
              endpoint you point Sylor at in Settings.
            </dd>
          </div>
          <div>
            <dt className="text-[13px] font-semibold text-[#141413]">Or skip the window</dt>
            <dd className="mt-1 text-[14px] leading-relaxed text-[#544f46]">
              The same engine runs headless:{' '}
              <span className="text-[#141413]">sylor -p "fix the failing test"</span>, with{' '}
              <span className="text-[#141413]">--json</span> when a script needs to read the result.
            </dd>
          </div>
        </dl>

        <p data-reveal className="mt-8 text-[13px] leading-relaxed text-[#6b675e]">
          The Windows build is self-signed, so SmartScreen may warn on first run — click{' '}
          <span className="text-[#141413]">More info → Run anyway</span>.{' '}
          <a
            href={LINKS.releases}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#141413] underline decoration-[#cbc6ba] transition-colors duration-150 hover:decoration-[#cf5535]"
          >
            All releases on GitHub
          </a>
          .
        </p>
      </div>
    </section>
  );
}
