import { LINKS } from '../data';

/* The explore strip: one quiet row that hands visitors into the site's deeper
   pages. Replaces the generic "learn more" clutter — every tile is a real page
   with a real job, and the row sits between Features and Pricing where the
   natural question is "what else is here?". */
const TILES = [
  {
    href: LINKS.featuresPage,
    title: 'Features',
    body: 'The whole workspace, capability by capability — diffs, terminal, plans, memory.',
  },
  {
    href: LINKS.comparePage,
    title: 'Compare',
    body: 'Local-first versus cloud agents, line by line — including when we lose.',
  },
  {
    href: LINKS.modelsPage,
    title: 'Models',
    body: 'Ollama, OpenAI-compatible endpoints, Anthropic proxies — bring the brain you want.',
  },
  {
    href: LINKS.communityPage,
    title: 'Community',
    body: 'Discover: the text-first feed where builders post what they shipped.',
  },
  {
    href: LINKS.guidePage,
    title: 'Guide',
    body: 'The full documentation — quick start, headless CLI, permissions, troubleshooting.',
  },
  {
    href: LINKS.changelogPage,
    title: 'Changelog',
    body: 'Every release, what shipped in it, and links to the builds.',
  },
];

export function ExploreStrip() {
  return (
    <section className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((t, i) => (
            <a
              key={t.title}
              data-reveal
              style={{ transitionDelay: `${(i % 3) * 60}ms` }}
              href={t.href}
              className="group border-t-2 border-[#e3e1d8] pt-5 no-underline transition-colors hover:border-[#141413]"
            >
              <h3 className="font-display text-[19px] tracking-[-0.01em] text-[#141413]">{t.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-[#6b675e]">{t.body}</p>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
