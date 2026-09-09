import { WORKSPACE } from '../data';

export function Workspace() {
  return (
    <section id="workspace" className="border-y border-[#e4e1d8] bg-[#f0eee6]">
      <div className="mx-auto max-w-5xl px-6 py-16 text-center sm:py-24">
        <p data-reveal className="eyebrow">
          Everything in one window
        </p>
        <h2
          data-reveal
          style={{ transitionDelay: '60ms' }}
          className="mx-auto mt-5 max-w-[22ch] text-[30px] font-semibold tracking-[-0.025em] text-[#141413] sm:text-[42px]"
        >
          One window, no add-ons
        </h2>
        <p
          data-reveal
          style={{ transitionDelay: '140ms' }}
          className="mx-auto mt-4 max-w-[58ch] text-[16px] leading-relaxed text-[#544f46]"
        >
          The whole surface, in one list. Nothing here is a separate purchase or a plugin you have to
          go and find.
        </p>
        <dl className="mt-12 grid gap-x-8 gap-y-9 text-left sm:grid-cols-2 lg:grid-cols-3">
          {WORKSPACE.map((w, i) => (
            <div key={w.name} data-reveal style={{ transitionDelay: `${(i % 3) * 55}ms` }}>
              <div className="h-[3px] w-8 rounded-full bg-[#cf5535]" aria-hidden="true" />
              <dt className="mt-3 text-[15px] font-semibold text-[#141413]">{w.name}</dt>
              <dd
                className="reveal-line mt-1.5 text-[14px] leading-relaxed text-[#544f46]"
                style={{ transitionDelay: '130ms' }}
              >
                {w.body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
