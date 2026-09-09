import { FAQ } from '../data';

export function Faq() {
  return (
    <section id="faq">
      <div className="mx-auto max-w-5xl px-6 py-16 text-center sm:py-24">
        <p data-reveal className="eyebrow">
          Questions
        </p>
        <h2
          data-reveal
          style={{ transitionDelay: '60ms' }}
          className="mx-auto mt-5 text-[30px] font-semibold tracking-[-0.025em] text-[#141413] sm:text-[42px]"
        >
          Straight answers
        </h2>
        {/* Answers are always open — nothing to click, nothing to unfold. */}
        <dl className="mx-auto mt-12 grid max-w-4xl gap-x-12 gap-y-9 text-left md:grid-cols-2">
          {FAQ.map((item) => (
            <div key={item.q} data-reveal>
              <dt className="text-[17px] font-semibold text-[#141413]">{item.q}</dt>
              <dd
                className="reveal-line mt-2 max-w-[54ch] text-[15px] leading-relaxed text-[#544f46]"
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
