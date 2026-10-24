interface Feature {
  title: string;
  body: string;
}

/* Six things Myto genuinely does — no filler, no metrics. */
const FEATURES: Feature[] = [
  {
    title: 'Multi-model support',
    body: 'Local via Ollama or any OpenAI-compatible endpoint. Switch models per task and set reasoning effort per turn.',
  },
  {
    title: 'Whole-project context',
    body: 'Myto reads across your codebase and carries notes forward in MYTO.md, so it never relearns the same thing twice.',
  },
  {
    title: 'A real terminal',
    body: 'A full shell in the workspace. Myto runs builds, tests, and dev servers, then reads the output like you would.',
  },
  {
    title: 'Diff-first & permissioned',
    body: 'Every edit is a diff you approve. Commands, network access, and destructive steps ask first — or run autonomously if you say so.',
  },
  {
    title: 'MCP & Markdown skills',
    body: 'Add MCP servers and reusable skills. Each connector states what it can reach and stays off until you switch it on.',
  },
  {
    title: 'It verifies its work',
    body: 'Runs your build and tests, opens the dev server to inspect the page it changed, and re-checks until the change passes.',
  },
];

export function Features() {
  return (
    <section id="features" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
        <div className="max-w-2xl">
          <p
            data-reveal
            className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#9c988e]"
          >
            Capabilities
          </p>
          <h2
            data-reveal
            style={{ transitionDelay: '60ms' }}
            className="mt-3 font-display text-[36px] font-normal tracking-[-0.02em] text-[#141413] sm:text-[46px]"
          >
            A full coding workspace
          </h2>
          <p
            data-reveal
            style={{ transitionDelay: '120ms' }}
            className="mt-4 max-w-[52ch] text-[18px] leading-8 text-[#544f46]"
          >
            Not a chat box bolted onto an editor — the tools you would expect from a coding session,
            in one window.
          </p>
        </div>

        {/* Plain editorial list: a Georgia heading, then its description below — no cards. */}
        <div className="mt-16 max-w-3xl space-y-14">
          {FEATURES.map((f, i) => (
            <div key={f.title} data-reveal style={{ transitionDelay: `${(i % 3) * 60}ms` }}>
              <h3 className="font-display text-[25px] font-normal tracking-[-0.01em] text-[#141413]">
                {f.title}
              </h3>
              <p className="mt-2.5 max-w-[64ch] text-[16.5px] leading-8 text-[#544f46]">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
