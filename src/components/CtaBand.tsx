import { LINKS } from '../data';

/* The closing band before the footer — one clear decision point with both
   paths (install it, or try it in the browser) at full width. */
export function CtaBand() {
  return (
    <section className="dark-band border-t border-[#141413]">
      <div className="mx-auto max-w-4xl px-6 py-24 text-center sm:py-28">
        <h2
          data-reveal
          className="mx-auto max-w-[22ch] font-display text-[36px] font-normal leading-[1.06] tracking-[-0.02em] sm:text-[48px]"
        >
          Your project is waiting. Bring your model.
        </h2>
        <p
          data-reveal
          style={{ transitionDelay: '80ms' }}
          className="band-muted mx-auto mt-5 max-w-[50ch] text-[17px] leading-relaxed"
        >
          Free to download, free to run on a local model, and yours to point at any
          endpoint. Windows and Android today.
        </p>
        <div
          data-reveal
          style={{ transitionDelay: '140ms' }}
          className="mt-10 flex flex-wrap justify-center gap-3"
        >
          <a
            href={LINKS.downloadPage}
            className="btn px-8 py-4 text-[16px] font-medium"
            style={{ background: '#faf9f5', color: '#141413' }}
          >
            Download Myto
          </a>
          <a href={LINKS.chatPage} className="btn btn-ghost px-8 py-4 text-[16px]">
            Try in browser
          </a>
        </div>
        <p data-reveal className="mt-8 text-[12.5px] text-[#8a857a]">
          Windows 10/11 (64-bit) · Android · or the browser build above
        </p>
      </div>
    </section>
  );
}
