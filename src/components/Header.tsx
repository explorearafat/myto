import { SylorLogo } from './SylorLogo';
import { LINKS } from '../data';

/* Plain anchors — no scroll-spy, no listeners, nothing recomputing on scroll. */
const NAV = [
  { label: 'Screenshots', hash: '#inside' },
  { label: 'Features', hash: '#features' },
  { label: 'FAQ', hash: '#faq' },
];

interface HeaderProps {
  /**
   * On a subpage the section anchors have to jump back to the product page, and
   * the Download button would only point at the page you are already on.
   */
  subpage?: boolean;
}

export function Header({ subpage = false }: HeaderProps) {
  return (
    <header className="border-b border-[#e4e1d8] bg-[#faf9f5]">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
        <a href={subpage ? '/' : '#top'} className="flex items-center gap-2 no-underline">
          <SylorLogo size={26} showBubbles={false} />
          <span className="text-[15px] font-semibold text-[#141413]">Sylor</span>
        </a>
        <nav className="flex items-center gap-5 text-[14px]">
          {NAV.map((n) => (
            <a
              key={n.hash}
              href={subpage ? `/${n.hash}` : n.hash}
              className="hidden text-[#6b675e] no-underline transition-colors duration-150 hover:text-[#141413] sm:inline"
            >
              {n.label}
            </a>
          ))}
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#6b675e] no-underline transition-colors duration-150 hover:text-[#141413]"
          >
            GitHub
          </a>
          {subpage ? null : (
            <a
              href={LINKS.downloadPage}
              className="rounded-md bg-[#cf5535] px-3.5 py-1.5 font-medium text-white no-underline transition-colors duration-150 hover:bg-[#b8482c] active:translate-y-px"
            >
              Download
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}
