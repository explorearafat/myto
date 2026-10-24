// /features — the capability deep-dive. Each capability gets a drawn object
// from objects.tsx next to it, so the page shows the product rather than
// listing adjectives. One alternating rhythm, hairline dividers, no cards.

import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';
import { AppWindowMockup, PlanChecklist } from './objects';

interface Block {
  title: string;
  body: string;
  points: string[];
  object?: 'window' | 'plan';
}

const BLOCKS: Block[] = [
  {
    title: 'Diff-first, permissioned edits',
    body: 'Myto never writes a file behind your back. Every change arrives as a before/after diff you approve line by line — and commands, network calls, and destructive steps ask before they run.',
    points: [
      'Reads run automatically; writes always show the diff',
      'Three permission tiers: ask every time, auto-approve edits, or autonomous',
      'Checkpoints capture every change — rewind any run',
    ],
  },
  {
    title: 'A plan you can watch',
    body: 'Multi-step work gets a live checklist: the agent lays out the steps, works them one at a time, and the panel ticks off real files as they land on disk — not when the model claims they did.',
    points: [
      'Steps tick from actual disk state, not model confidence',
      'A 45-minute budget and step counter keep long runs honest',
      'Stall guards end a stuck run instead of burning hours',
    ],
    object: 'plan',
  },
  {
    title: 'A real terminal, really used',
    body: 'Builds, tests, linters, dev servers — Myto runs them in your workspace, reads the actual output, and fixes what actually broke. Verification is the loop, not a claim.',
    points: [
      'run_command and run_dev_server with live output in the Terminal pane',
      'A verify command gates "done" — red build means it keeps working',
      'Interactive shell when you want to drive',
    ],
  },
  {
    title: 'Whole-project memory',
    body: 'MYTO.md and the project journal carry decisions forward between sessions, so Myto does not relearn your repository from zero every morning.',
    points: [
      'Journal records what was done and why, per project',
      'User-level memory keeps your preferences across projects',
      'Recall is keyword-driven and offline',
    ],
  },
  {
    title: 'Sub-agents, browser, and schedules',
    body: 'Hand read-only investigations to parallel sub-agents, let Myto open its own sandboxed browser to check the page it just built, and schedule recurring prompts.',
    points: [
      'spawn_agents runs up to five investigations in parallel',
      'The Myto Browser checks rendered pages under a blank profile',
      'Scheduled tasks run on a cron you control',
    ],
    object: 'window',
  },
];

export function FeaturesPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-6 pb-20 pt-14">
        <p className="eyebrow">Features</p>
        <h1 className="mt-4 max-w-[24ch] font-display text-[40px] leading-[1.05] tracking-[-0.02em] text-[#141413] sm:text-[52px]">
          A workspace, not a chat box.
        </h1>
        <p className="mt-5 max-w-[58ch] text-[18px] leading-relaxed text-[#544f46]">
          Everything below ships in the app today, runs with the model you choose, and works
          from your project folder on your machine.
        </p>

        <div className="mt-16 space-y-20">
          {BLOCKS.map((b, i) => (
            <section
              key={b.title}
              data-reveal
              className={
                'grid items-center gap-10 border-t border-[#e9e6dd] pt-12 lg:grid-cols-[1fr_380px] ' +
                (i % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : '')
              }
            >
              <div>
                <h2 className="font-display text-[28px] leading-tight tracking-[-0.01em] text-[#141413] sm:text-[32px]">
                  {b.title}
                </h2>
                <p className="mt-4 max-w-[60ch] text-[16px] leading-8 text-[#544f46]">{b.body}</p>
                <ul className="mt-5 space-y-2.5">
                  {b.points.map((p) => (
                    <li key={p} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-[#33312c]">
                      <span className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-[#1a6b52]" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex justify-center lg:justify-end">
                {b.object === 'plan' ? (
                  <PlanChecklist />
                ) : b.object === 'window' ? (
                  <div className="w-full max-w-[420px]">
                    <AppWindowMockup />
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>

        {/* Closing CTA */}
        <div className="mt-20 rounded-2xl border border-[#e9e6dd] bg-white px-8 py-10 text-center">
          <h2 className="font-display text-[26px] tracking-[-0.01em] text-[#141413]">
            All of it, with your model.
          </h2>
          <p className="mx-auto mt-3 max-w-[48ch] text-[15.5px] leading-relaxed text-[#544f46]">
            Local Ollama or any OpenAI-compatible endpoint — Myto never locks you to one
            provider, and the app costs nothing.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              href={LINKS.downloadPage}
              className="inline-flex items-center rounded-full bg-[#141413] px-7 py-3 text-[15px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98]"
            >
              Download Myto
            </a>
            <a
              href={LINKS.modelsPage}
              className="inline-flex items-center rounded-full border border-[#e3e1d8] bg-white px-7 py-3 text-[15px] font-medium text-[#141413] no-underline transition-colors hover:border-[#c9c4b8]"
            >
              See how models work
            </a>
          </div>
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
