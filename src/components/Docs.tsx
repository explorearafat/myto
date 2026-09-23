import { useState } from 'react';
import { Check, Copy, ArrowRight } from 'lucide-react';
import { copyToClipboard } from '../lib/clipboard';
import { LINKS } from '../data';

/* A contents rail like the reference's docs sidebar. These are section labels,
   not routes — the real docs live in the app; the assistant answers the rest. */
const TOC = [
  'Quick start',
  'Installation',
  'Choosing a model',
  'Using the CLI',
  'Skills & MCP',
  'FAQ',
];

/* Honest quick start: Myto is a desktop app you can also drive headlessly.
   Deliberately NOT `npm install -g myto` — Myto ships no npm package. */
const CODE = `# Install the app, open your project, then describe the first task —
# or drive the very same engine straight from your terminal:

myto -p "add a dark-mode toggle to the Settings page"

# machine-readable output, for scripts and CI:
myto -p "list every TODO under src/" --json`;

export function Docs() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyToClipboard(CODE)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <section id="docs" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="text-center">
          <h2
            data-reveal
            className="font-display font-normal text-[32px] tracking-[-0.02em] text-[#141413] sm:text-[40px]"
          >
            Documentation
          </h2>
          <p
            data-reveal
            style={{ transitionDelay: '70ms' }}
            className="mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#6b675e]"
          >
            Up and running in a minute. The assistant answers anything this leaves out.
          </p>
        </div>

        <div className="mt-14 grid gap-8 lg:grid-cols-[220px_1fr]">
          {/* Contents rail. */}
          <aside data-reveal className="lg:pt-2">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#9c988e]">
              Getting started
            </p>
            <ul className="mt-4 space-y-1">
              {TOC.map((item, i) => (
                <li
                  key={item}
                  className={
                    'rounded-lg px-3 py-2 text-[14px] ' +
                    (i === 0
                      ? 'bg-[#f0efe9] font-medium text-[#57544e]'
                      : 'text-[#6b675e]')
                  }
                >
                  {item}
                </li>
              ))}
            </ul>
          </aside>

          {/* Quick start. */}
          <div data-reveal style={{ transitionDelay: '90ms' }}>
            <h3 className="font-display font-normal text-[24px] tracking-[-0.01em] text-[#141413]">
              Quick start
            </h3>
            <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-[#544f46]">
              Myto is a desktop workspace — install it, open a folder, and start a conversation.
              Prefer the terminal? The same engine runs headlessly:
            </p>

            <div className="mt-6 overflow-hidden rounded-xl border border-[#e4e1d8] bg-[#fbf9f3]">
              <div className="flex items-center justify-between border-b border-[#eceae2] px-4 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#dcd8cd]" aria-hidden="true" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#dcd8cd]" aria-hidden="true" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#dcd8cd]" aria-hidden="true" />
                  <span className="ml-2 text-[12px] font-medium text-[#9c988e]">Terminal</span>
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
                    const space = line.indexOf(' ');
                    const cmd = space === -1 ? line : line.slice(0, space);
                    const rest = space === -1 ? '' : line.slice(space);
                    return (
                      <div key={i} className="text-[#2b2721]">
                        <span className="text-[#57544e]">{cmd}</span>
                        {rest}
                      </div>
                    );
                  })}
                </code>
              </pre>
            </div>

            <a
              href={LINKS.chatPage}
              className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-medium text-[#57544e] no-underline transition-colors duration-150 hover:text-[#141413]"
            >
              Ask the assistant a setup question
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
