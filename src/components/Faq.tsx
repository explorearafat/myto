import { FAQ } from '../data';
import { Words } from './Words';

export function Faq() {
  return (
    <section id="faq">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h2
          data-reveal="words"
          className="text-[24px] font-semibold tracking-[-0.02em] text-[#141413] sm:text-[28px]"
        >
          <Words text="Questions" />
        </h2>
        {/* Answers are always open — nothing to click, nothing to unfold. */}
        <dl className="mt-8 divide-y divide-[#e4e1d8]">
          {FAQ.map((item) => (
            <div key={item.q} data-reveal className="py-5 first:pt-0 last:pb-0">
              <dt className="text-[15px] font-semibold text-[#141413]">{item.q}</dt>
              <dd
                className="reveal-line mt-1.5 max-w-[70ch] text-[15px] leading-relaxed text-[#544f46]"
                style={{ transitionDelay: '150ms' }}
              >
                {item.a}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
