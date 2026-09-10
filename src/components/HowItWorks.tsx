/* Truthful to how Sylor actually runs: choose a model, describe the work, approve
   each diff, and let it verify against your build. */
const STEPS = [
  {
    title: 'Choose your model',
    body: 'Point Sylor at a local Ollama or any OpenAI-compatible endpoint.',
  },
  {
    title: 'Describe the task',
    body: 'Say what to build, fix, or explain — in plain language, in your project.',
  },
  {
    title: 'Review each diff',
    body: 'Every edit arrives as a diff you approve. Commands and network access ask first.',
  },
  {
    title: 'Ship it verified',
    body: 'Sylor runs your build and tests, reads the errors, and fixes until it passes.',
  },
];

export function HowItWorks() {
  return (
    <section className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="text-center">
          <h2
            data-reveal
            className="font-display font-normal text-[32px] tracking-[-0.02em] text-[#141413] sm:text-[40px]"
          >
            How it works
          </h2>
          <p
            data-reveal
            style={{ transitionDelay: '70ms' }}
            className="mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#6b675e]"
          >
            From an empty chat to a change that compiles, in four steps.
          </p>
        </div>

        <div className="relative mt-16">
          {/* The line that threads the four steps — behind the badges, which cover it. */}
          <div
            aria-hidden="true"
            className="absolute left-[12.5%] right-[12.5%] top-6 hidden border-t border-dashed border-[#ddd8ca] sm:block"
          />
          <div className="grid gap-12 sm:grid-cols-4 sm:gap-6">
            {STEPS.map((s, i) => (
              <div
                key={s.title}
                data-reveal
                style={{ transitionDelay: `${i * 80}ms` }}
                className="relative flex flex-col items-center text-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[#e6b8ac] bg-[#faf1ee] font-display text-[18px] text-[#cf5535]">
                  {i + 1}
                </div>
                <h3 className="mt-5 font-display font-normal text-[19px] tracking-[-0.01em] text-[#141413]">
                  {s.title}
                </h3>
                <p className="mt-2.5 max-w-[26ch] text-[15px] leading-relaxed text-[#544f46]">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
