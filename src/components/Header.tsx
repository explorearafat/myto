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

/* Shared style for the quiet text links. */
const linkCls =
  'px-3 py-1.5 text-[14px] font-medium text-[#544f46] no-underline transition-colors duration-150 hover:text-[#141413]';

export function Header({ subpage = false }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-[#e9e6dd]/70 bg-[#faf9f5]/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href={subpage ? '/' : '#top'} className="flex items-center gap-2.5 no-underline">
          <MytoMark size={22} />
          <span className="font-display text-[21px] leading-none tracking-[-0.01em] text-[#141413]">
            Myto
          </span>
        </a>

        <nav className="flex items-center gap-1">
          {/* Chat / Docs — hidden on small screens where they would crowd. */}
          <div className="hidden items-center gap-1 sm:flex">
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
            className="ml-1.5 inline-flex items-center rounded-lg bg-[#141413] px-4 py-2 text-[14px] font-medium text-[#faf9f5] no-underline transition-colors duration-150 hover:bg-[#2b2721] active:translate-y-px"
          >
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
