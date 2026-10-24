import { DemoClip } from './DemoClip';

/* "Watch it work" — the auto-playing clip sits beside the claim, so the
   visitor sees the agent cycle through a real task before reading a word of
   the feature list. */
export function DemoSection() {
  return (
    <section className="border-b border-[#e9e6dd]">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 sm:py-28 lg:grid-cols-2">
        <div data-reveal>
          <p className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#9c988e]">
            Live, not simulated
          </p>
          <h2 className="mt-3 font-display text-[34px] font-normal leading-[1.06] tracking-[-0.02em] text-[#141413] sm:text-[44px]">
            Watch a task go from one line to verified.
          </h2>
          <p className="mt-5 max-w-[50ch] text-[17px] leading-relaxed text-[#544f46]">
            The plan panel ticks as real files land. The terminal runs the actual
            build. And the reply streams the moment your model starts answering —
            wherever you are: desktop, phone, or browser.
          </p>
          <ul className="mt-7 space-y-3 text-[15px] leading-relaxed text-[#33312c]">
            <li className="flex gap-2.5"><span className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-[#1a6b52]" />Streaming replies — the words arrive as the model thinks</li>
            <li className="flex gap-2.5"><span className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-[#1a6b52]" />A plan panel fed by the real filesystem, not model confidence</li>
            <li className="flex gap-2.5"><span className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-[#1a6b52]" />Same account everywhere: desktop, Android, and this site</li>
          </ul>
        </div>
        <div data-reveal style={{ transitionDelay: '120ms' }} className="flex justify-center lg:justify-end">
          <DemoClip />
        </div>
      </div>
    </section>
  );
}
