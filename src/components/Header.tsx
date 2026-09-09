import { SylorStar } from './SylorStar';
import { LINKS } from '../data';

/* Plain anchors — no scroll-spy, no listeners, nothing recomputing on scroll. */
const NAV = [
  { label: 'Screenshots', hash: '#inside' },
  { label: 'Features', hash: '#features' },
  { label: 'Inside', hash: '#workspace' },
  { label: 'FAQ', hash: '#faq' },
];

interface HeaderProps {
  /**
   * On a subpage the section anchors have to jump back to the product page, and
   * the Download button would only point at the page you are already on.
   */
  subpage?: boolean;
}

/* Shared pill for the quiet text links — rounded to match the CTA's pill shape. */
const linkCls =
  'rounded-full px-3 py-1.5 text-[14px] font-medium text-[#544f46] no-underline transition-colors duration-150 hover:bg-[#f0eee6] hover:text-[#141413]';

export function Header({ subpage = false }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 bg-[#faf9f5]/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3.5">
        <a href={subpage ? '/' : '#top'} className="flex items-center gap-2 no-underline">
          <SylorStar size={22} />
          <span className="text-[16px] font-semibold tracking-[-0.01em] text-[#141413]">Sylor</span>
        </a>

        {/* Centre group — the spread nav of the reference, hidden on small screens. */}
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <a key={n.hash} href={subpage ? `/${n.hash}` : n.hash} className={linkCls}>
              {n.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          {/* A real path, so it reads the same from the product page and any subpage. */}
          <a href={LINKS.chatPage} className={linkCls}>
            Chat
          </a>
          {subpage ? null : (
            <a
              href={LINKS.downloadPage}
              className="ml-1.5 inline-flex items-center rounded-full bg-[#141413] px-4 py-2 text-[14px] font-medium text-[#faf9f5] no-underline transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
            >
              Download
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
