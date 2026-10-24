import { useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';

const SECTIONS: Array<{ id: string; title: string; body: ReactNode }> = [
  {
    id: 'quick-start',
    title: 'Quick start',
    body: (
      <>
        <ol className="list-decimal space-y-3 pl-5">
          <li>Download and install the app (Windows), or install the APK on Android.</li>
          <li>Open Myto and sign in with Google or GitHub.</li>
          <li>Add your model endpoint and API key — it syncs from your account automatically.</li>
          <li>Pick a working folder, describe the first task, and approve the diffs.</li>
        </ol>
        <p>
          On the website you can skip installing entirely: <a href={LINKS.chatPage}>the browser chat</a>{' '}
          answers with the same engine, backed by your own key.
        </p>
      </>
    ),
  },
  {
    id: 'models',
    title: 'Models and keys',
    body: (
      <>
        <p>
          Myto speaks to any OpenAI-compatible endpoint, a local Ollama, and Anthropic-format
          proxies (detected automatically from the base URL or a <code>claude-*</code> model id).
          Add a base URL, API key, and model list on the{' '}
          <a href={LINKS.chatPage}>Authentication page</a> — the desktop and Android apps read the
          same config from your account.
        </p>
        <p>
          Reasoning effort is a per-turn setting (low to max). Streaming speed depends on your
          endpoint, and the desktop measures each model&rsquo;s real rate in Settings → Models so
          you can compare honestly.
        </p>
      </>
    ),
  },
  {
    id: 'permissions',
    title: 'Permissions and safety',
    body: (
      <>
        <p>
          Reads run automatically. Writes arrive as diffs you approve. Commands, network calls,
          and destructive steps ask first — or run on their own if you switch to the autonomous
          tier. Every change is captured as a checkpoint you can rewind.
        </p>
        <p>
          Build mode adds a verify gate: give it your build or test command, and the agent cannot
          call a run &ldquo;done&rdquo; while it fails.
        </p>
      </>
    ),
  },
  {
    id: 'headless',
    title: 'Headless CLI',
    body: (
      <>
        <p>
          The desktop install ships a <code>myto</code> command with the same engine, for scripts
          and CI:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-[#1a1917] px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[#e8e5dd]">
          myto -p &quot;list every TODO under src/&quot; --json
        </pre>
        <p>
          The CLI reuses the desktop app&rsquo;s saved settings — point it at a model once in the
          app and both stay in sync.
        </p>
      </>
    ),
  },
  {
    id: 'discover',
    title: 'The Discover community',
    body: (
      <>
        <p>
          Discover is a text-only community feed built into every Myto app. Post short takes with
          #topics, attach a website link (its preview renders on the card), react, comment,
          repost, and follow other builders. Reading is public; writing uses your Myto sign-in.
        </p>
        <p>
          <a href={LINKS.discoverPage}>Open Discover in the browser</a> — or use the Discover tab
          in the app.
        </p>
      </>
    ),
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    body: (
      <>
        <p>
          <strong>Replies are slow.</strong> That is almost always the endpoint, not the app:
          measure it in Settings → Models with the built-in speed test, and switch to a faster
          model or provider.
        </p>
        <p>
          <strong>SmartScreen or Play Protect warns on install.</strong> The builds are
          self-signed, so your OS asks for confirmation once — More info → Run anyway (Windows),
          Allow (Android).
        </p>
        <p>
          <strong>Sign-in loops.</strong> Make sure popups are allowed for the site, then retry —
          the account chooser needs one successful popup to persist the session.
        </p>
      </>
    ),
  },
];

export function GuidePage() {
  const [active, setActive] = useState(SECTIONS[0].id);
  const current = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-6 pb-20 pt-14">
        <p className="eyebrow">Guide</p>
        <h1 className="mt-4 font-display text-[40px] leading-[1.05] tracking-[-0.02em] text-[#141413] sm:text-[52px]">
          The full guide.
        </h1>
        <p className="mt-5 max-w-[56ch] text-[18px] leading-relaxed text-[#544f46]">
          Everything worth knowing, in one place — from the first install to the headless CLI.
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[220px_1fr]">
          {/* Contents rail */}
          <nav className="h-fit lg:sticky lg:top-24">
            <ul className="space-y-1">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActive(s.id)}
                    className={
                      'w-full rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors ' +
                      (active === s.id
                        ? 'bg-[#141413] font-medium text-[#faf9f5]'
                        : 'text-[#544f46] hover:bg-[#f0efe9] hover:text-[#141413]')
                    }
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Body */}
          <article className="min-w-0 border-t border-[#e9e6dd] pt-8">
            <h2 className="font-display text-[28px] tracking-[-0.01em] text-[#141413]">{current.title}</h2>
            <div className="mt-5 max-w-[68ch] space-y-4 text-[15.5px] leading-8 text-[#544f46] [&_a]:font-medium [&_a]:text-[#141413] [&_a]:underline [&_a]:decoration-[#cbc6ba] [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-[#eceae2] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-[#141413]">
              {current.body}
            </div>
          </article>
        </div>

        <div className="mt-16 border-t border-[#e9e6dd] pt-10 text-center">
          <h2 className="font-display text-[24px] tracking-[-0.01em] text-[#141413]">
            Ready? It is one download away.
          </h2>
          <a
            href={LINKS.downloadPage}
            className="mt-6 inline-flex items-center rounded-full bg-[#141413] px-8 py-3.5 text-[15.5px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98]"
          >
            Get Myto
          </a>
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
