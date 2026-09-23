import { MODEL_BRANDS } from '../lib/modelBrands';

/*
 * The reference page's logo wall, told honestly: Myto has no customer logos, so this shows
 * the model families it runs — any of these via a local Ollama or an OpenAI-compatible
 * endpoint. Each name now carries its official brand mark (see ../lib/modelBrands), drawn in
 * the brand colour; the serif wordmark beside it stays neutral so the row reads as editorial,
 * not a rainbow. Marks are decorative — the adjacent text is the accessible label.
 */
export function Models() {
  return (
    <section className="border-b border-[#e9e6dd]">
      <div className="mx-auto max-w-6xl px-6 py-14 text-center sm:py-16">
        <p
          data-reveal
          className="text-[13px] font-medium uppercase tracking-[0.14em] text-[#9c988e]"
        >
          Bring the model you choose
        </p>
        <div
          data-reveal
          style={{ transitionDelay: '80ms' }}
          className="mt-8 flex flex-wrap items-center justify-center gap-x-9 gap-y-5"
        >
          {MODEL_BRANDS.map((m) => (
            <span key={m.name} className="group inline-flex items-center gap-2.5">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="currentColor"
                style={{ color: m.hex }}
                className="h-[21px] w-[21px] flex-none sm:h-[23px] sm:w-[23px]"
              >
                <path d={m.path} />
              </svg>
              <span className="font-display text-[21px] tracking-[-0.01em] text-[#544f46] transition-colors duration-200 group-hover:text-[#141413] sm:text-[24px]">
                {m.name}
              </span>
            </span>
          ))}
        </div>
        <p
          data-reveal
          style={{ transitionDelay: '160ms' }}
          className="mx-auto mt-9 max-w-[52ch] text-[15px] leading-relaxed text-[#6b675e]"
        >
          Run a model locally with Ollama, or set the base URL and key for any OpenAI-compatible
          endpoint. Myto never locks you to one provider.
        </p>
      </div>
    </section>
  );
}
