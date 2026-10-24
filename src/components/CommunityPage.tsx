import { Header } from './Header';
import { Footer } from './Footer';
import { LINKS } from '../data';

export function CommunityPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />

      {/* Hero — spruce accent marks this as the community corner. */}
      <main id="content" className="relative z-10 flex-1">
        <section className="overflow-hidden border-b border-[#e9e6dd]">
          <div aria-hidden="true" className="hero-aura" />
          <div className="relative mx-auto max-w-4xl px-6 pb-16 pt-20 text-center sm:pb-20 sm:pt-24">
            <p className="eyebrow !text-[#1a6b52]">Community</p>
            <h1 className="mx-auto mt-4 max-w-[20ch] font-display text-[40px] leading-[1.05] tracking-[-0.02em] text-[#141413] sm:text-[54px]">
              Build it. Then show it.
            </h1>
            <p className="mx-auto mt-5 max-w-[52ch] text-[18px] leading-relaxed text-[#544f46]">
              Discover is Myto&rsquo;s community feed: short, text-only posts about AI, Myto,
              crypto, and whatever you are building — with website previews attached, comments,
              and follows. Built into every Myto app.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <a
                href={LINKS.discoverPage}
                className="inline-flex items-center rounded-full bg-[#1a6b52] px-8 py-3.5 text-[15.5px] font-medium text-white no-underline shadow-[0_14px_36px_-14px_rgba(26,107,82,0.6)] transition-all duration-200 hover:bg-[#155a44] active:scale-[0.98]"
              >
                Open Discover
              </a>
              <a
                href={LINKS.downloadPage}
                className="inline-flex items-center rounded-full border border-[#e3e1d8] bg-white px-8 py-3.5 text-[15.5px] font-medium text-[#141413] no-underline transition-colors hover:border-[#c9c4b8]"
              >
                Get the app
              </a>
            </div>
          </div>
        </section>

        {/* What you can do */}
        <section className="mx-auto max-w-4xl px-6 py-16">
          <div className="grid gap-10 sm:grid-cols-3">
            {[
              {
                t: 'Post in a sentence',
                b: 'Type, add #topics, paste a link — its site preview renders on the card. No images, no noise; just what you built and what you learned.',
              },
              {
                t: 'React and reply',
                b: 'Like, comment in threads, and repost the posts worth keeping. Everything lands under your account and syncs across the website, desktop, and Android app.',
              },
              {
                t: 'Follow builders',
                b: 'Follow the people whose posts you rate. Their next experiment shows up in your Following tab — and yours in theirs.',
              },
            ].map((c) => (
              <div key={c.t} data-reveal className="border-t-2 border-[#1a6b52] pt-5">
                <h2 className="font-display text-[19px] tracking-[-0.01em] text-[#141413]">{c.t}</h2>
                <p className="mt-2.5 text-[14.5px] leading-relaxed text-[#544f46]">{c.b}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it stays safe */}
        <section className="border-t border-[#e9e6dd] bg-white">
          <div className="mx-auto max-w-3xl px-6 py-14">
            <h2 className="font-display text-[24px] tracking-[-0.01em] text-[#141413]">
              Ground rules
            </h2>
            <ul className="mt-5 space-y-3 text-[15px] leading-relaxed text-[#544f46]">
              <li>· Text only — no image uploads, so the feed stays fast and clean.</li>
              <li>· Every post is written under a signed-in account; the server pins authorship.</li>
              <li>· Reading is public. Writing needs your Google or GitHub sign-in.</li>
              <li>· Your keys and chats are separate, private, and governed by the same rules as the rest of Myto.</li>
            </ul>
            <p className="mt-6 text-[13px] text-[#9c988e]">
              The full policy lives on the <a href="/policy" className="underline decoration-[#cbc6ba] underline-offset-2 hover:decoration-[#141413]">privacy page</a>.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-16 text-center">
          <h2 className="font-display text-[26px] tracking-[-0.01em] text-[#141413]">
            The first post is still open.
          </h2>
          <p className="mx-auto mt-3 max-w-[44ch] text-[15.5px] leading-relaxed text-[#544f46]">
            Sign in, say what you are building, and start the feed.
          </p>
          <a
            href={LINKS.discoverPage}
            className="mt-7 inline-flex items-center rounded-full bg-[#1a6b52] px-8 py-3.5 text-[15.5px] font-medium text-white no-underline transition-all duration-200 hover:bg-[#155a44] active:scale-[0.98]"
          >
            Write the first post
          </a>
        </section>
      </main>
      <Footer subpage />
    </div>
  );
}
