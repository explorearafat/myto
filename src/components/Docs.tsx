import { useState, type ReactNode } from 'react';
import { Check, Copy, ArrowRight, Globe, MessageCircle } from 'lucide-react';
import { copyToClipboard } from '../lib/clipboard';
import { LINKS } from '../data';

/* Contents rail — each entry maps to a body below. Selecting one swaps the shown
   body with a keyed cross-fade (see the Docs component). Not routes: the real
   docs open inside the app; these get you started. */
const SECTIONS: { id: string; title: string }[] = [
  { id: 'quick-start', title: 'Quick start' },
  { id: 'installation', title: 'Installation' },
  { id: 'choosing-a-model', title: 'Choosing a model' },
  { id: 'using-the-cli', title: 'Using the CLI' },
  { id: 'skills-mcp', title: 'Skills & MCP' },
  { id: 'faq', title: 'FAQ' },
];

/* Honest quick start: Myto is a desktop app you can also drive headlessly.
   Deliberately NOT `npm install -g myto` — Myto ships no npm package. */
const CODE = `# Install the app, open your project, then describe the first task —
# or drive the very same engine straight from your terminal:

myto -p "add a dark-mode toggle to the Settings page"

# machine-readable output, for scripts and CI:
myto -p "list every TODO under src/" --json`;

function Prose({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="font-display font-normal text-[24px] tracking-[-0.01em] text-[#141413]">
        {title}
      </h3>
      <div className="mt-3 flex flex-col gap-4 text-[15px] leading-relaxed text-[#544f46]">
        {children}
      </div>
    </div>
  );
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="font-medium text-[#141413] no-underline underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
    >
      {children}
    </a>
  );
}

function QuickStart() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(CODE)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="min-w-0">
      <h3 className="font-display font-normal text-[24px] tracking-[-0.01em] text-[#141413]">
        Quick start
      </h3>
      <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-[#544f46]">
        Myto is a desktop workspace — install it, open a folder, and start a conversation.
        Prefer the terminal? The same engine runs headlessly:
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-[#e4e1d8] bg-[#fbf9f3] shadow-[0_18px_44px_-30px_rgba(20,20,19,0.35)]">
        <div className="flex items-center justify-between border-b border-[#eceae2] px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#dcd8cd]" aria-hidden="true" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#dcd8cd]" aria-hidden="true" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#dcd8cd]" aria-hidden="true" />
            <span className="ml-2 font-mono text-[12px] text-[#9c988e]">myto — bash</span>
          </div>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#6b675e] transition-colors duration-150 hover:bg-[#f0ede4] hover:text-[#141413]"
            aria-label={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[#141413]" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto px-5 py-4 text-[13.5px] leading-relaxed">
          <code className="font-mono">
            {CODE.split('\n').map((line, i) => {
              if (line.trim() === '') return <div key={i} className="h-3" />;
              if (line.startsWith('#'))
                return (
                  <div key={i} className="text-[#9c988e]">
                    {line}
                  </div>
                );
              return (
                <div key={i} className="text-[#2b2721]">
                  <span className="select-none text-[#c7c2b6]">$ </span>
                  {line}
                </div>
              );
            })}
          </code>
        </pre>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <a
          href={LINKS.web}
          className="group flex flex-1 items-center justify-between gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3.5 no-underline transition-colors duration-150 hover:border-[#d8d3c8] hover:bg-[#fbfaf6]"
        >
          <span className="flex items-center gap-3">
            <Globe className="h-[18px] w-[18px] flex-none text-[#57544e]" strokeWidth={1.75} aria-hidden="true" />
            <span>
              <span className="block text-[14px] font-medium text-[#141413]">Try it in your browser</span>
              <span className="block text-[12.5px] text-[#9c988e]">The web build — zero install</span>
            </span>
          </span>
          <ArrowRight className="h-4 w-4 flex-none text-[#9c988e] transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
        </a>
        <a
          href={LINKS.chatPage}
          className="group flex flex-1 items-center justify-between gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3.5 no-underline transition-colors duration-150 hover:border-[#d8d3c8] hover:bg-[#fbfaf6]"
        >
          <span className="flex items-center gap-3">
            <MessageCircle className="h-[18px] w-[18px] flex-none text-[#57544e]" strokeWidth={1.75} aria-hidden="true" />
            <span>
              <span className="block text-[14px] font-medium text-[#141413]">Ask the assistant</span>
              <span className="block text-[12.5px] text-[#9c988e]">Answers your setup questions</span>
            </span>
          </span>
          <ArrowRight className="h-4 w-4 flex-none text-[#9c988e] transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
function Installation() {
  return (
    <Prose title="Installation">
      <p className="max-w-[62ch]">
        Grab a build from the <DocLink href="/download">download page</DocLink>. Windows and Android
        are ready today; macOS and Linux are planned.
      </p>
      <p className="max-w-[62ch]">
        The installers are self-signed, so the first launch shows a caution. On Windows, SmartScreen
        asks — click <span className="font-medium text-[#141413]">More info → Run anyway</span>. On
        Android, allow the install from your browser or files app when prompted.
      </p>
      <p className="max-w-[62ch]">
        Nothing else to set up: open the app, sign in with Google, and open a project folder.
      </p>
    </Prose>
  );
}

function ChoosingModel() {
  return (
    <Prose title="Choosing a model">
      <p className="max-w-[62ch]">
        Myto is bring-your-own-key. You point it at a model instead of paying Myto for one, so it
        works with whatever you already use.
      </p>
      <p className="max-w-[62ch]">
        Set your provider on the{' '}
        <DocLink href="/authentication">authentication page</DocLink>: a{' '}
        <span className="font-medium text-[#141413]">Base URL</span>, an{' '}
        <span className="font-medium text-[#141413]">API key</span>, and the model ids you want. Any
        OpenAI-compatible endpoint works, as does Anthropic; for a fully local, offline setup, run
        Ollama on <span className="font-mono text-[13.5px]">localhost:11434</span>.
      </p>
      <p className="max-w-[62ch]">
        Your key is stored under your own account and is never shared or used for training.
      </p>
    </Prose>
  );
}

function UsingCli() {
  return (
    <Prose title="Using the CLI">
      <p className="max-w-[62ch]">
        The same engine that powers the app runs from your terminal. Use{' '}
        <span className="font-mono text-[13.5px]">myto -p "…"</span> for a one-shot task, and add{' '}
        <span className="font-mono text-[13.5px]">--json</span> for machine-readable output in
        scripts and CI.
      </p>
      <p className="max-w-[62ch]">
        Run <span className="font-mono text-[13.5px]">myto</span> with no prompt to open an
        interactive session in the current folder — the same conversation, approvals, and tools as
        the app, in the terminal.
      </p>
    </Prose>
  );
}
function SkillsMcp() {
  return (
    <Prose title="Skills & MCP">
      <p className="max-w-[62ch]">
        Myto extends the same three ways the desktop assistants do.{' '}
        <span className="font-medium text-[#141413]">Connectors</span> are MCP servers — connect one
        and its tools appear to the agent, failure-isolated so a broken server never takes the rest
        down.
      </p>
      <p className="max-w-[62ch]">
        <span className="font-medium text-[#141413]">Skills</span> are reusable instructions you
        save once and invoke by name, and <span className="font-medium text-[#141413]">plugins</span>{' '}
        bundle skills and connectors together so a whole workflow installs in one step.
      </p>
      <p className="max-w-[62ch]">
        All three are opt-in and managed from Settings inside the app.
      </p>
    </Prose>
  );
}

function Faq() {
  return (
    <Prose title="FAQ">
      <p className="max-w-[62ch]">
        <span className="font-medium text-[#141413]">Which platforms are ready?</span> Windows and
        Android today; macOS, Linux, and iOS are planned.
      </p>
      <p className="max-w-[62ch]">
        <span className="font-medium text-[#141413]">What does it cost?</span> Myto is free — you
        bring your own model, so you only pay whatever your provider charges (nothing, for a local
        Ollama).
      </p>
      <p className="max-w-[62ch]">
        <span className="font-medium text-[#141413]">Is it private?</span> Your keys and
        conversations stay under your own account; keys are never shared or used for training. See
        the <DocLink href="/policy">privacy &amp; policy</DocLink> page.
      </p>
      <p className="max-w-[62ch]">
        <span className="font-medium text-[#141413]">Where is the source?</span> Myto is
        closed-source; the builds are served from the public myto-dist mirror.
      </p>
    </Prose>
  );
}

const BODIES: Record<string, () => ReactNode> = {
  'quick-start': QuickStart,
  installation: Installation,
  'choosing-a-model': ChoosingModel,
  'using-the-cli': UsingCli,
  'skills-mcp': SkillsMcp,
  faq: Faq,
};

export function Docs() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const Body = BODIES[activeId] ?? QuickStart;

  return (
    <section id="docs" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="max-w-2xl">
          <p
            data-reveal
            className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#9c988e]"
          >
            Documentation
          </p>
          <h2
            data-reveal
            style={{ transitionDelay: '60ms' }}
            className="mt-3 font-display font-normal text-[32px] tracking-[-0.02em] text-[#141413] sm:text-[40px]"
          >
            Up and running in a minute
          </h2>
          <p
            data-reveal
            style={{ transitionDelay: '120ms' }}
            className="mt-4 max-w-[48ch] text-[17px] leading-relaxed text-[#544f46]"
          >
            Install, open a folder, describe the first task. Pick a topic — the panel updates in
            place.
          </p>
        </div>

        <div className="mt-12 grid gap-10 lg:grid-cols-[210px_1fr]">
          {/* Contents rail — real buttons that switch the body, active state driven by state. */}
          <aside data-reveal className="lg:pt-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#9c988e]">
              Getting started
            </p>
            <ul className="mt-4 border-l border-[#e9e6dd]">
              {SECTIONS.map((s) => {
                const active = s.id === activeId;
                return (
                  <li key={s.id} className="-ml-px">
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      aria-current={active ? 'true' : undefined}
                      className={
                        'block w-full border-l-2 py-1.5 pl-4 text-left text-[14px] transition-colors duration-150 ' +
                        (active
                          ? 'border-[#141413] font-medium text-[#141413]'
                          : 'border-transparent text-[#6b675e] hover:border-[#d8d5cc] hover:text-[#141413]')
                      }
                    >
                      {s.title}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-5 text-[12px] leading-relaxed text-[#9c988e]">
              The full guide opens inside the app.
            </p>
          </aside>

          {/* Body — keyed by activeId so it re-mounts and replays the mount fade on switch.
              `.chat-in` is flattened under prefers-reduced-motion. */}
          <div data-reveal style={{ transitionDelay: '90ms' }} className="min-w-0">
            <div key={activeId} className="chat-in">
              <Body />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
