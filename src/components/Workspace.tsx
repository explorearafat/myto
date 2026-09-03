import { WORKSPACE } from '../data';
import { Words } from './Words';

export function Workspace() {
  return (
    <section id="workspace" className="border-y border-[#e4e1d8] bg-[#f0eee6]">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h2
          data-reveal="words"
          className="text-[24px] font-semibold tracking-[-0.02em] text-[#141413] sm:text-[28px]"
        >
          <Words text="Everything in one window" />
        </h2>
        <p
          data-reveal
          style={{ transitionDelay: '70ms' }}
          className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-[#6b675e]"
        >
          The whole surface, in one list. Nothing here is a separate purchase or a plugin you have to
          go and find.
        </p>
        <dl className="mt-9 grid gap-x-10 gap-y-7 sm:grid-cols-2">
          {WORKSPACE.map((w, i) => (
            <div key={w.name} data-reveal style={{ transitionDelay: `${(i % 2) * 60}ms` }}>
              <dt className="text-[15px] font-semibold text-[#141413]">{w.name}</dt>
              <dd
                className="reveal-line mt-1 text-[14px] leading-relaxed text-[#544f46]"
                style={{ transitionDelay: `${140 + (i % 2) * 60}ms` }}
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
