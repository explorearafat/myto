import { SylorStar } from './SylorStar';
import { LINKS } from '../data';

const FOOTER_LINKS = [
  { label: 'Download', href: LINKS.downloadPage, external: false },
  { label: 'Chat', href: LINKS.chatPage, external: false },
  { label: 'Releases', href: LINKS.releases, external: true },
  { label: 'Try in browser', href: LINKS.web, external: true },
];

export function Footer() {
  return (
    <footer className="border-t border-[#e4e1d8]">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-5 px-6 py-10 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2.5">
          <SylorStar size={20} />
          <span className="text-[14px] font-semibold text-[#141413]">Sylor</span>
          <span className="text-[13px] text-[#9c988e]">© 2026</span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[14px]">
          {FOOTER_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target={l.external ? '_blank' : undefined}
              rel={l.external ? 'noopener noreferrer' : undefined}
              className="font-medium text-[#6b675e] no-underline transition-colors duration-150 hover:text-[#141413]"
            >
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
