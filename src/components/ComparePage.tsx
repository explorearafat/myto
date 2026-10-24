import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';

const ROWS: Array<{ label: string; myto: string; cloud: string }> = [
  { label: 'Where your code runs', myto: 'On your machine, in your folder', cloud: 'On the vendor\u2019s cloud sandbox' },
  { label: 'Which model', myto: 'Any — local Ollama or your own endpoint', cloud: 'Whichever the vendor sells you' },
  { label: 'Who pays for tokens', myto: 'Your own provider, at your own rate', cloud: 'A subscription with usage caps' },
  { label: 'Edit approval', myto: 'Every diff, before it is written', cloud: 'Varies by product and plan' },
  { label: 'Works offline', myto: 'Yes, with a local model', cloud: 'No' },
  { label: 'Your API keys', myto: 'Stored under your own account, owner-only', cloud: 'Managed by the vendor' },
  { label: 'Native mobile app', myto: 'Android today, iOS planned', cloud: 'Varies' },
  { label: 'Community feed', myto: 'Built in — Discover', cloud: 'No' },
];

export function ComparePage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-4xl flex-1 px-6 pb-24 pt-20">
        <p className="eyebrow">Compare</p>
        <h1 className="mt-4 max-w-[26ch] font-display text-[44px] leading-[1.04] tracking-[-0.025em] text-[#141413] sm:text-[58px]">
          Local-first versus the cloud.
        </h1>
        <p className="mt-5 max-w-[58ch] text-[18px] leading-relaxed text-[#544f46]">
          Cloud coding agents are capable — and they all make the same trade: your code, your
          context, and your budget live on someone else&rsquo;s server. Myto makes the opposite
          trade. Here is the difference, line by line.
        </p>

        <div className="mt-12 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[14.5px]">
            <thead>
              <tr className="border-b-2 border-[#141413]">
                <th className="w-[34%] py-3 pr-4 font-medium text-[#9c988e]">&nbsp;</th>
                <th className="py-3 pr-4 font-display text-[17px] font-normal tracking-[-0.01em] text-[#141413]">
                  Myto
                </th>
                <th className="py-3 font-medium text-[#6b675e]">Typical cloud agent</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.label} className="border-b border-[#e9e6dd] align-top">
                  <td className="py-3.5 pr-4 font-medium text-[#141413]">{r.label}</td>
                  <td className="py-3.5 pr-4 leading-relaxed text-[#33312c]">{r.myto}</td>
                  <td className="py-3.5 leading-relaxed text-[#6b675e]">{r.cloud}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-12 grid gap-8 sm:grid-cols-2">
          <div className="rounded-2xl border border-[#e9e6dd] bg-white p-6">
            <h2 className="font-display text-[20px] tracking-[-0.01em] text-[#141413]">
              When Myto is the better pick
            </h2>
            <ul className="mt-4 space-y-2.5 text-[14.5px] leading-relaxed text-[#544f46]">
              <li>· Your code cannot leave your machine — client work, contracts, compliance</li>
              <li>· You already pay for a model provider and want your agent on the same bill</li>
              <li>· You want to inspect and approve every change, not trust a black box</li>
              <li>· You work where the internet is unreliable — a local model keeps going</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-[#e9e6dd] bg-white p-6">
            <h2 className="font-display text-[20px] tracking-[-0.01em] text-[#141413]">
              When a cloud agent fits
            </h2>
            <ul className="mt-4 space-y-2.5 text-[14.5px] leading-relaxed text-[#544f46]">
              <li>· You want zero setup and do not mind a managed sandbox</li>
              <li>· Your team standardised on one vendor&rsquo;s model</li>
              <li>· You need features Myto does not ship yet</li>
            </ul>
            <p className="mt-4 text-[13px] leading-relaxed text-[#9c988e]">
              We would rather tell you this than pretend the trade does not exist.
            </p>
          </div>
        </div>

        <div className="mt-14 text-center">
          <a
            href={LINKS.downloadPage}
            className="inline-flex items-center rounded-full bg-[#141413] px-8 py-3.5 text-[15.5px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98]"
          >
            Try Myto — free
          </a>
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
