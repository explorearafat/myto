import { SylorLogo } from './SylorLogo';
import { LINKS } from '../data';

const FOOTER_LINKS = [
  { label: 'Download', href: LINKS.downloadPage, external: false },
  { label: 'GitHub', href: LINKS.repo, external: true },
  { label: 'Releases', href: LINKS.releases, external: true },
  { label: 'Try in browser', href: LINKS.web, external: true },
];

export function Footer() {
  return (
    <footer className="border-t border-[#e4e1d8]">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <SylorLogo size={20} showBubbles={false} />
          <span className="text-[14px] font-medium text-[#141413]">Sylor</span>
          <span className="text-[13px] text-[#6b675e]">© 2026</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px]">
          {FOOTER_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target={l.external ? '_blank' : undefined}
              rel={l.external ? 'noopener noreferrer' : undefined}
              className="text-[#6b675e] no-underline transition-colors duration-150 hover:text-[#141413]"
            >
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
