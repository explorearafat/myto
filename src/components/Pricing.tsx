import { LINKS } from '../data';

/* Deliberately slim — the reference has a Pricing entry, and Sylor's answer is
   short and honest: the app is free, you only pay whoever serves your model. */
export function Pricing() {
  return (
    <section id="pricing" className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div
          data-reveal
          className="mx-auto max-w-2xl rounded-2xl border border-[#e4e1d8] bg-white px-8 py-12 text-center shadow-[0_24px_60px_-40px_rgba(20,20,19,0.35)]"
        >
          <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-[#9c988e]">
            Pricing
          </p>
          <h2 className="mt-4 font-display font-normal text-[34px] tracking-[-0.02em] text-[#141413] sm:text-[42px]">
            Free. You bring the model.
          </h2>
          <p className="mx-auto mt-5 max-w-[46ch] text-[17px] leading-relaxed text-[#544f46]">
            The Sylor app costs nothing. Your only spend is whatever your model provider charges —
            and that is <span className="font-medium text-[#141413]">zero</span> when the model runs
            locally on your machine.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[14px] font-medium text-[#6b675e]">
            <span>No subscription</span>
            <span aria-hidden="true" className="text-[#cdc8bc]">
              •
            </span>
            <span>No account required</span>
            <span aria-hidden="true" className="text-[#cdc8bc]">
              •
            </span>
            <span>Local models cost nothing</span>
          </div>
          <a
            href={LINKS.downloadPage}
            className="mt-9 inline-flex items-center rounded-lg bg-[#141413] px-6 py-3 text-[15px] font-medium text-[#faf9f5] no-underline transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
          >
            Get Sylor free
          </a>
        </div>
      </div>
    </section>
  );
}
