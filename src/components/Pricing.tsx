import { Check } from 'lucide-react';
import { LINKS } from '../data';

/* Deliberately slim — the reference has a Pricing entry, and Myto's answer is
   short and honest: the app is free, you only pay whoever serves your model. */
const INCLUDED = [
  'No subscription, ever',
  'No account required',
  'Every feature — no paid tiers',
  'Local models cost nothing to run',
];

export function Pricing() {
  return (
    <section id="pricing" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div
          data-reveal
          className="mx-auto max-w-3xl overflow-hidden rounded-3xl border border-[#e4e1d8] bg-white shadow-[0_24px_60px_-40px_rgba(20,20,19,0.35)]"
        >
          <div className="grid sm:grid-cols-2">
            {/* The pitch. */}
            <div className="p-8 sm:p-10">
              <p className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#9c988e]">
                Pricing
              </p>
              <div className="mt-5 flex items-end gap-2.5">
                <span className="font-display text-[64px] leading-[0.85] text-[#141413] sm:text-[72px]">
                  $0
                </span>
                <span className="mb-2 text-[14px] font-medium text-[#9c988e]">for the app</span>
              </div>
              <h2 className="mt-6 font-display font-normal text-[26px] tracking-[-0.02em] text-[#141413]">
                Free. You bring the model.
              </h2>
              <p className="mt-3 max-w-[42ch] text-[16px] leading-relaxed text-[#544f46]">
                The Myto app costs nothing. Your only spend is whatever your model provider charges —
                and that is <span className="font-medium text-[#141413]">zero</span> when the model
                runs locally on your machine.
              </p>
              <a
                href={LINKS.downloadPage}
                className="mt-8 inline-flex w-full items-center justify-center rounded-full bg-[#141413] px-7 py-3 text-[15px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.98] sm:w-auto"
              >
                Get Myto free
              </a>
            </div>

            {/* What that gets you. */}
            <div className="border-t border-[#eceae2] bg-[#fbfaf6] p-8 sm:border-l sm:border-t-0 sm:p-10">
              <p className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#9c988e]">
                What's included
              </p>
              <ul className="mt-6 space-y-4">
                {INCLUDED.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border border-[#e3e1d8] bg-white text-[#141413]">
                      <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                    </span>
                    <span className="text-[15.5px] leading-6 text-[#4a453d]">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
