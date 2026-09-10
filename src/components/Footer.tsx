import { SylorStar } from './SylorStar';
import { LINKS } from '../data';

/* In-page sections (hash) plus the real subpages. On a subpage the hashes have
   to jump back to the product page — matching the header. */
const SECTIONS = [
  { label: 'Product', hash: '#features' },
  { label: 'Docs', hash: '#docs' },
  { label: 'Pricing', hash: '#pricing' },
];
const PAGES = [
  { label: 'Download', href: LINKS.downloadPage },
  { label: 'Chat', href: LINKS.chatPage },
];

interface FooterProps {
  subpage?: boolean;
}

const linkCls =
  'font-medium text-[#6b675e] no-underline transition-colors duration-150 hover:text-[#141413]';

export function Footer({ subpage = false }: FooterProps) {
  return (
    <footer className="border-t border-[#e4e1d8]">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <a
              href={subpage ? '/' : '#top'}
              className="flex items-center gap-2.5 no-underline"
            >
              <SylorStar size={22} />
              <span className="font-display text-[20px] leading-none tracking-[-0.01em] text-[#141413]">
                Sylor
              </span>
            </a>
            <p className="mt-3.5 max-w-[34ch] text-[14px] leading-relaxed text-[#6b675e]">
              The AI coding agent for modern developers.
            </p>
          </div>

          <nav className="flex flex-wrap gap-x-8 gap-y-3 text-[14px]">
            {SECTIONS.map((n) => (
              <a key={n.hash} href={subpage ? `/${n.hash}` : n.hash} className={linkCls}>
                {n.label}
              </a>
            ))}
            {PAGES.map((p) => (
              <a key={p.href} href={p.href} className={linkCls}>
                {p.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-10 border-t border-[#eceae2] pt-6 text-[13px] text-[#9c988e]">
          © 2026 Sylor. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
