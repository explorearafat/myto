import { MytoMark } from './MytoMark';
import { LINKS } from '../data';

/* Plain anchors — no scroll-spy, no listeners, nothing recomputing on scroll.
   Chat is a real path (renders the same on landing and subpages); Docs is an
   in-page hash that has to jump back to the product page from a subpage. */
const NAV: Array<{ label: string; href?: string; hash?: string }> = [
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

/* Shared style for the quiet text links — an Apple-nav feel: roomy pill hit
   areas that tint softly on hover, readable at phone widths. */
const linkCls =
  'rounded-full px-2.5 py-1.5 text-[13.5px] font-medium text-[#544f46] no-underline transition-colors duration-200 hover:bg-[#141413]/[0.06] hover:text-[#141413] sm:px-3 sm:text-[14px]';

export function Header({ subpage = false }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-[#e9e6dd]/60 bg-[#faf9f5]/72 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-3.5">
        <a href={subpage ? '/' : '#top'} className="flex items-center gap-2.5 no-underline">
          <MytoMark size={22} />
          <span className="font-display text-[21px] leading-none tracking-[-0.01em] text-[#141413]">
            Myto
          </span>
        </a>

        <nav className="flex items-center gap-0.5 sm:gap-1">
          {/* Nav links stay visible at every width — the phone is where visitors
              most need a way into Chat / Discover / Docs. */}
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
            className="ml-1 inline-flex items-center rounded-full bg-[#141413] px-4 py-2 text-[13.5px] font-medium text-[#faf9f5] no-underline transition-all duration-200 hover:bg-[#2b2721] active:scale-[0.97] sm:ml-2 sm:px-5 sm:text-[14px]"
          >
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
