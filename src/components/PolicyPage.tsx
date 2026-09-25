import { ArrowLeft } from 'lucide-react';
import { useReveals } from '../lib/reveal';
import { Footer } from './Footer';
import { Header } from './Header';

/*
 * Template legal scaffolding. This is a good-faith DRAFT that describes how Myto
 * actually works (bring-your-own-key, closed-source, owner-only device records) —
 * it is NOT counsel-reviewed copy. The banner at the top says so, and the real
 * documents should replace these bodies before any launch that needs them.
 */
interface PolicySection {
  id: string;
  title: string;
  paragraphs: string[];
}

const SECTIONS: PolicySection[] = [
  {
    id: 'privacy',
    title: 'Privacy Policy',
    paragraphs: [
      'Myto is a bring-your-own-key product. The model API keys and endpoints you enter are stored under your own account and are used only to relay your requests to the provider you chose. They are never sold, shared with third parties, or used to train any model.',
      'We store the minimum needed to run your account: your Google profile basics (name, email, photo) from sign-in, the conversations you keep on your own devices, and a record of the devices signed in to your account. We do not build advertising profiles and we do not sell personal data.',
      'You can remove a device record or delete your account at any time; doing so removes the associated records under our control.',
    ],
  },
  {
    id: 'terms',
    title: 'Terms of Service',
    paragraphs: [
      'Myto is provided on an as-is basis, without warranty of any kind. You are responsible for the code Myto helps you write and for reviewing changes before you run or ship them.',
      'You agree to use Myto lawfully and to comply with the terms of whatever model provider you connect through your own API key. Your use of a third-party model is governed by that provider’s terms, not ours.',
      'Myto is closed-source software. You may use the published builds; you may not redistribute, decompile, or resell them.',
    ],
  },
  // PLACEHOLDER_SECTIONS
  {
    id: 'data',
    title: 'Data & BYOK-key handling',
    paragraphs: [
      'Your API keys live in your account’s configuration document and are readable and writable only by you — owner-only access rules enforce this at the database level. Requests are relayed through a stateless proxy that never logs your key and holds no copy of it after the request completes.',
      'Conversations are stored locally on the device where you have them; they are not uploaded to a Myto server. Device sign-in records (browser, operating system, approximate location by IP, and last-seen time) are kept so you can see and revoke access, and are visible only to you.',
      'When you connect a model provider, your prompts and code context are sent to that provider to generate a response. What the provider does with that data is governed by the provider’s own policy.',
    ],
  },
  {
    id: 'cookies',
    title: 'Cookies & local storage',
    paragraphs: [
      'Myto uses browser storage for essential functions only: keeping you signed in, remembering a per-device identifier for the device list, and storing your local conversations and preferences. We do not use third-party advertising or tracking cookies.',
    ],
  },
  {
    id: 'contact',
    title: 'Contact',
    paragraphs: [
      'Questions about privacy, data, or these terms can be raised through the project’s public repository or the contact address published there. This draft will be replaced with a counsel-reviewed version and a formal contact and entity line before any release that relies on it.',
    ],
  },
];

export function PolicyPage() {
  useReveals();

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <a className="skip-link" href="#doc">
        Skip to the policy
      </a>
      <Header subpage />
      <main id="doc" className="flex-1">
        <section className="relative overflow-hidden border-b border-[#e9e6dd]">
          <div aria-hidden="true" className="hero-aura" />
          <div className="relative mx-auto max-w-3xl px-6 pt-20 pb-14 sm:pt-24">
            <p data-reveal className="eyebrow">
              Legal
            </p>
            <h1
              data-reveal
              style={{ transitionDelay: '60ms' }}
              className="mt-4 font-display font-normal text-[40px] leading-[1.04] tracking-[-0.02em] text-[#141413] sm:text-[52px]"
            >
              Privacy and Policy
            </h1>
            <p
              data-reveal
              style={{ transitionDelay: '120ms' }}
              className="mt-5 max-w-[54ch] text-[17px] leading-relaxed text-[#544f46]"
            >
              How Myto handles your data, your bring-your-own-key credentials, and your account.
              The short version: your keys are yours, your conversations stay on your devices, and
              nothing here is used to train a model.
            </p>
            <div
              data-reveal
              style={{ transitionDelay: '180ms' }}
              className="mt-6 rounded-xl border border-[#e4d9b8] bg-[#faf4e2] px-4 py-3 text-[13.5px] leading-relaxed text-[#6b5f3e]"
            >
              <strong className="font-semibold">Draft.</strong> This is template scaffolding that
              describes how Myto works today — it has not been reviewed by legal counsel. Replace
              it with counsel-reviewed copy before relying on it.
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-14 sm:py-16">
          <div className="flex flex-col gap-12">
            {SECTIONS.map((s) => (
              <article key={s.id} id={s.id} data-reveal className="scroll-mt-24">
                <h2 className="font-display font-normal text-[26px] tracking-[-0.02em] text-[#141413] sm:text-[30px]">
                  {s.title}
                </h2>
                <div className="mt-4 flex flex-col gap-4">
                  {s.paragraphs.map((p, i) => (
                    <p key={i} className="text-[15.5px] leading-relaxed text-[#544f46]">
                      {p}
                    </p>
                  ))}
                </div>
              </article>
            ))}
          </div>

          <p className="mt-14 text-[13px] text-[#9c988e]">Last updated: 24 September 2026 (draft).</p>
          <div data-reveal className="mt-6">
            <a
              href="/"
              className="inline-flex items-center gap-1.5 text-[14px] font-medium text-[#141413] no-underline underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to Myto
            </a>
          </div>
        </section>
      </main>
      <Footer subpage />
    </div>
  );
}
