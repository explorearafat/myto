import { MytoMark } from './MytoMark';
import { LINKS } from '../data';

/* Plain anchors — no scroll-spy, no listeners, nothing recomputing on scroll. */
const NAV: Array<{ label: string; href?: string; hash?: string }> = [
  { label: 'Features', href: LINKS.featuresPage },
  { label: 'Compare', href: LINKS.comparePage },
  { label: 'Chat', href: LINKS.chatPage },
  { label: 'Discover', href: LINKS.discoverPage },
  { label: 'Docs', hash: '#docs' },
];

interface HeaderProps {
  /**
   * On a subpage the section anchors have to jump back to the product page —
   * `#features` alone would look for the section on the page you are already on.
   */
  subpage?: boolean;
}

/* Quiet text links with an underline that draws in on hover — the Apple-nav
   feel, readable at phone widths. */
const linkCls =
  'nav-link rounded-full px-2 py-1.5 text-[13.5px] font-medium text-[#544f46] no-underline transition-colors duration-200 hover:text-[#141413] sm:px-3 sm:text-[14px]';

export function Header({ subpage = false }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-[#e9e6dd]/50 bg-[#faf9f5]/72 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 sm:py-3">
        <a href={subpage ? '/' : '#top'} className="flex items-center gap-2.5 no-underline">
          <MytoMark size={20} />
          <span className="font-display text-[19px] leading-none tracking-[-0.01em] text-[#141413]">
            Myto
          </span>
        </a>

        <nav className="flex items-center gap-0.5 sm:gap-1">
          <div className="flex items-center">
            {NAV.map((n) => (
              <a
                key={n.label}
                href={n.href ?? (subpage ? `/${n.hash}` : n.hash)}
                className={linkCls}
              >
                {n.label}
              </a>
            ))}
          </div>
          {/* A real path, so it reads the same from the product page and any subpage. */}
          <a
            href={LINKS.downloadPage}
            className="btn btn-dark ml-1 px-4 py-1.5 text-[13px] sm:ml-2 sm:px-5 sm:py-2 sm:text-[13.5px]"
          >
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
