import {
  Layers,
  FolderTree,
  Terminal,
  ShieldCheck,
  Blocks,
  BadgeCheck,
  type LucideIcon,
} from 'lucide-react';

interface Feature {
  Icon: LucideIcon;
  title: string;
  body: string;
}

/* Six things Sylor genuinely does — no filler, no metrics. */
const FEATURES: Feature[] = [
  {
    Icon: Layers,
    title: 'Multi-model support',
    body: 'Local via Ollama or any OpenAI-compatible endpoint. Switch models per task and set reasoning effort per turn.',
  },
  {
    Icon: FolderTree,
    title: 'Whole-project context',
    body: 'Sylor reads across your codebase and carries notes forward in SYLOR.md, so it never relearns the same thing twice.',
  },
  {
    Icon: Terminal,
    title: 'A real terminal',
    body: 'A full shell in the workspace. Sylor runs builds, tests, and dev servers, then reads the output like you would.',
  },
  {
    Icon: ShieldCheck,
    title: 'Diff-first & permissioned',
    body: 'Every edit is a diff you approve. Commands, network access, and destructive steps ask first — or run autonomously if you say so.',
  },
  {
    Icon: Blocks,
    title: 'MCP & Markdown skills',
    body: 'Add MCP servers and reusable skills. Each connector states what it can reach and stays off until you switch it on.',
  },
  {
    Icon: BadgeCheck,
    title: 'It verifies its work',
    body: 'Runs your build and tests, opens the dev server to inspect the page it changed, and re-checks until the change passes.',
  },
];

export function Features() {
  return (
    <section id="features" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="text-center">
          <h2
            data-reveal
            className="font-display font-medium text-[34px] tracking-[-0.015em] text-[#141413] sm:text-[42px]"
          >
            Key features
          </h2>
          <p
            data-reveal
            style={{ transitionDelay: '70ms' }}
            className="mx-auto mt-4 max-w-[48ch] text-[18px] leading-8 text-[#544f46] max-w-[52ch]"
          >
            A full coding workspace — not a chat box bolted onto an editor.
          </p>
        </div>

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              data-reveal
              style={{ transitionDelay: `${(i % 3) * 60}ms` }}
              className="rounded-2xl border border-[#e4e1d8] bg-white p-7 transition-transform duration-300 hover:scale-[1.02] hover:-translate-y-1 hover:border-[#d8d3c8] hover:shadow-[0_18px_44px_-26px_rgba(20,20,19,0.3)]"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#eadfd9] bg-[#faf1ee] text-[#cf5535]">
                <f.Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </div>
              <h3 className="mt-5 font-display font-normal text-[22px] font-medium tracking-[-0.005em] text-[#141413]">
                {f.title}
              </h3>
              <p className="mt-2.5 text-[16px] leading-7 text-[#4a453d]">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
