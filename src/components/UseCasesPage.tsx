import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';

const CASES = [
  {
    who: 'The student',
    title: 'Learn by shipping, not by scaffolding',
    body: 'Point Myto at your course project, describe the assignment in one line, and watch the plan panel build it step by step. Every edit is a diff, so you see how a real project takes shape — and the model runs on a free local Ollama, so nothing shows up on a card.',
    steps: 'Describe → watch the plan → read the diffs → run it',
  },
  {
    who: 'The freelancer',
    title: 'Five client repos, one workflow',
    body: 'Each client gets a project with its own memory: Myto journals what it did in every folder, so context survives between sessions. Approve diffs on the desktop during the day, check the run from your phone, and keep every client\u2019s code on your own machine.',
    steps: 'Pick the folder → batch the fixes → verify each build → invoice',
  },
  {
    who: 'The open-source maintainer',
    title: 'Triage without burning your evening',
    body: 'Spawn read-only sub-agents to investigate five issues in parallel, then have Myto draft the fixes as diffs you review. The headless CLI runs the same agent in CI-shaped one-shot mode with JSON output.',
    steps: 'Spawn investigations → pick the plan → approve diffs → merge',
  },
  {
    who: 'The tinkerer',
    title: 'Your models, your rules',
    body: 'Swap between a local Ollama model for private work and a frontier endpoint for the hard stuff — per task, with reasoning effort per turn. Join the Discover community to trade prompts and see what others build.',
    steps: 'Add an endpoint → build → post it to Discover',
  },
];

export function UseCasesPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-4xl flex-1 px-6 pb-20 pt-14">
        <p className="eyebrow">Use cases</p>
        <h1 className="mt-4 max-w-[26ch] font-display text-[40px] leading-[1.05] tracking-[-0.02em] text-[#141413] sm:text-[52px]">
          Built for how you already work.
        </h1>
        <p className="mt-5 max-w-[58ch] text-[18px] leading-relaxed text-[#544f46]">
          Myto is one agent that adapts to the person driving it. Four of the most common
          shapes that takes:
        </p>

        <div className="mt-14 space-y-14">
          {CASES.map((c, i) => (
            <section key={c.who} data-reveal className="grid gap-6 border-t border-[#e9e6dd] pt-10 sm:grid-cols-[180px_1fr]">
              <div>
                <p className="font-mono text-[12px] text-[#9c988e]">{String(i + 1).padStart(2, '0')}</p>
                <p className="mt-1 font-display text-[19px] tracking-[-0.01em] text-[#141413]">{c.who}</p>
              </div>
              <div>
                <h2 className="font-display text-[24px] leading-tight tracking-[-0.01em] text-[#141413]">
                  {c.title}
                </h2>
                <p className="mt-3 max-w-[64ch] text-[15.5px] leading-8 text-[#544f46]">{c.body}</p>
                <p className="mt-4 font-mono text-[12.5px] text-[#9c988e]">{c.steps}</p>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-16 rounded-2xl border border-[#e9e6dd] bg-white px-8 py-10 text-center">
          <h2 className="font-display text-[24px] tracking-[-0.01em] text-[#141413]">
            Your shape is probably the fifth one.
          </h2>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              href={LINKS.downloadPage}
              className="inline-flex items-center rounded-full bg-[#141413] px-7 py-3 text-[15px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98]"
            >
              Download Myto
            </a>
            <a
              href={LINKS.communityPage}
              className="inline-flex items-center rounded-full border border-[#e3e1d8] bg-white px-7 py-3 text-[15px] font-medium text-[#141413] no-underline transition-colors hover:border-[#c9c4b8]"
            >
              Meet the community
            </a>
          </div>
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
