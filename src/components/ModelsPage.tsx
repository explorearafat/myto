import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';
import { MODEL_BRANDS } from '../lib/modelBrands';

const STEPS = [
  {
    t: 'Pick where the model lives',
    b: 'A local Ollama (http://localhost:11434 by default) for private, offline, free work — or any OpenAI-compatible endpoint in the cloud. Anthropic-format proxies are detected and supported too.',
  },
  {
    t: 'Paste your key once',
    b: 'Add your base URL, API key, and models on the Authentication page. They sync to the desktop app and the Android app under your account — owner-only storage, enforced by Firestore rules.',
  },
  {
    t: 'Switch models per task',
    b: 'A flash model for quick questions, a frontier model for the hard refactor. Reasoning effort is per turn, and the connection doctor measures each model\u2019s real streaming speed so you can see which one is worth using.',
  },
];

export function ModelsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-4xl flex-1 px-6 pb-24 pt-20">
        <p className="eyebrow">Models</p>
        <h1 className="mt-4 max-w-[24ch] font-display text-[44px] leading-[1.04] tracking-[-0.025em] text-[#141413] sm:text-[58px]">
          No lock-in. Any model.
        </h1>
        <p className="mt-5 max-w-[58ch] text-[18px] leading-relaxed text-[#544f46]">
          Myto is the workspace; you bring the brain. That single decision shapes everything
          else — what you pay, where your code goes, and how fast replies stream.
        </p>

        <div data-reveal className="mt-12 flex flex-wrap items-center justify-center gap-x-9 gap-y-5 rounded-2xl border border-[#e9e6dd] bg-white px-6 py-10">
          {MODEL_BRANDS.map((m) => (
            <span key={m.name} className="group inline-flex items-center gap-2.5">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" style={{ color: m.hex }} className="h-[21px] w-[21px] flex-none">
                <path d={m.path} />
              </svg>
              <span className="font-display text-[20px] tracking-[-0.01em] text-[#544f46] transition-colors duration-200 group-hover:text-[#141413]">
                {m.name}
              </span>
            </span>
          ))}
        </div>

        <div className="mt-14 space-y-10">
          {STEPS.map((s, i) => (
            <section key={s.t} data-reveal className="grid gap-4 border-t border-[#e9e6dd] pt-8 sm:grid-cols-[56px_1fr]">
              <span className="grid h-10 w-10 place-items-center rounded-full border border-[#d8d5cc] bg-[#f0efe9] font-display text-[16px] text-[#141413]">
                {i + 1}
              </span>
              <div>
                <h2 className="font-display text-[22px] tracking-[-0.01em] text-[#141413]">{s.t}</h2>
                <p className="mt-2.5 max-w-[64ch] text-[15.5px] leading-8 text-[#544f46]">{s.b}</p>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-14 rounded-2xl border border-[#e9e6dd] bg-white p-7">
          <h2 className="font-display text-[20px] tracking-[-0.01em] text-[#141413]">
            The honest part about speed
          </h2>
          <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[#544f46]">
            Myto streams replies at whatever rate your endpoint produces. A frontier endpoint
            answers fast; a free proxy can crawl at a few tokens per second. The app measures
            each model&rsquo;s real rate in Settings → Models, so you can see the difference
            and pick what deserves your task.
          </p>
        </div>

        <div className="mt-12 text-center">
          <a
            href={LINKS.chatPage}
            className="inline-flex items-center rounded-full bg-[#141413] px-8 py-3.5 text-[15.5px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98]"
          >
            Try it in the browser
          </a>
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
