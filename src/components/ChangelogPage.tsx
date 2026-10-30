import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';

const RELEASES = [
  {
    v: 'v0.18.0',
    date: 'October 30, 2026',
    notes: [
      'Myto Remote — a Call tab on the phone: ring your desktop agent and talk to it in natural voice (on-device speech recognition in, en-IN-NeerjaNeural voice out)',
      'Remote PowerShell with permission tiers — read-only flows, dev commands confirm on the ask tier, destructive always asks; every execution audited',
      'Project tasks keep running after you hang up, and Myto calls you back with the result when it finishes (with retries and missed-call notifications)',
      'Desktop presence on the Call tab: online / busy / offline, call history, callback log',
      'Native call UI: 5–7s real ringing, mute, keypad, speaker, hold, live latency and connection quality',
    ],
  },
  {
    v: 'v0.9.2',
    date: 'October 24, 2026',
    notes: [
      'Live-streamed replies — text paints as the model answers instead of landing whole',
      'Speed-first reasoning defaults and a connection doctor that measures each model\u2019s real streaming rate',
      'The plan panel tracks real disk state, so progress ticks even when the model forgets',
      'Long sessions stay smooth: windowed transcript, memoized rows, auto-compaction',
      'Community feed with live link previews on the website and in the app',
    ],
  },
  {
    v: 'v0.9.1',
    date: 'October 24, 2026',
    notes: [
      'Hand-drawn SVG agent avatars across the mobile app',
      'Team-chat typing polish and room reply ordering',
      'Faster agent loop: bounded budgets and stall guards',
    ],
  },
  {
    v: 'v0.9.0',
    date: 'October 24, 2026',
    notes: [
      'Agent 1-to-1 chats and research rooms on mobile — no demo data',
      'Windows and Android as the supported platforms; installers ship together',
      'Website refreshed around the mobile release',
    ],
  },
  {
    v: 'v0.8.0',
    date: 'October 22, 2026',
    notes: [
      'First release with the shared Windows installer and Android APK pipeline',
      'All download links point at live GitHub release assets',
    ],
  },
];

export function ChangelogPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-3xl flex-1 px-6 pb-24 pt-20">
        <p className="eyebrow">Changelog</p>
        <h1 className="mt-4 font-display text-[44px] leading-[1.04] tracking-[-0.025em] text-[#141413] sm:text-[58px]">
          What shipped, when.
        </h1>
        <p className="mt-5 max-w-[56ch] text-[18px] leading-relaxed text-[#544f46]">
          Every release lands on GitHub Releases first — the site&rsquo;s download buttons always
          point at the latest one.
        </p>

        <div className="mt-14 space-y-12">
          {RELEASES.map((r) => (
            <section key={r.v} data-reveal className="border-t border-[#e9e6dd] pt-8">
              <div className="flex flex-wrap items-baseline gap-x-4">
                <h2 className="font-mono text-[18px] font-semibold text-[#141413]">{r.v}</h2>
                <span className="text-[13px] text-[#9c988e]">{r.date}</span>
                <a
                  href={`https://github.com/explorearafat/myto/releases/tag/${r.v}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-medium text-[#1a6b52] underline decoration-[#bcd6cc] underline-offset-2 hover:decoration-[#1a6b52]"
                >
                  release page
                </a>
              </div>
              <ul className="mt-4 space-y-2.5">
                {r.notes.map((n) => (
                  <li key={n} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-[#33312c]">
                    <span className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-[#1a6b52]" />
                    {n}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-16 text-center">
          <a
            href={LINKS.releases}
            className="inline-flex items-center rounded-full border border-[#e3e1d8] bg-white px-7 py-3 text-[15px] font-medium text-[#141413] no-underline transition-colors hover:border-[#c9c4b8]"
          >
            All releases on GitHub
          </a>
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
