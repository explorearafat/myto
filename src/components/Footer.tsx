import { ArrowRight } from 'lucide-react';
import { MytoMark } from './MytoMark';

interface FooterProps {
  subpage?: boolean;
}

export function Footer({ subpage = false }: FooterProps) {
  return (
    <footer className="border-t border-[#e4e1d8]">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <a
              href={subpage ? '/' : '#top'}
              className="flex items-center gap-2.5 no-underline"
            >
              <MytoMark size={22} />
              <span className="font-display text-[20px] leading-none tracking-[-0.01em] text-[#141413]">
                Myto
              </span>
            </a>
            <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.2em] text-[#9c988e]">
              Build · Chat · Cowork
            </p>
            <p className="mt-2.5 max-w-[34ch] text-[14px] leading-relaxed text-[#6b675e]">
              The AI coding agent for modern developers.
            </p>
          </div>

          {/* Privacy & policy — a short legal/business note with the full documents on /policy. */}
          <div className="max-w-[42ch]">
            <h2 className="font-display font-normal text-[22px] leading-tight tracking-[-0.01em] text-[#141413]">
              Privacy and Policy
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-[#6b675e]">
              Myto is bring-your-own-key: your API keys and model endpoints are stored under your
              own account and are never shared, resold, or used to train anything. Sign-in and
              device records exist only to keep your account secure, and you can remove them at
              any time. Myto is operated as a closed-source product; the full privacy, terms, and
              data-handling documents are linked below.
            </p>
            <a
              href="/policy"
              className="group mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-[#141413] no-underline underline decoration-[#cbc6ba] underline-offset-2 transition-colors duration-150 hover:decoration-[#141413]"
            >
              See more
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </a>
          </div>
        </div>

        <div className="mt-10 border-t border-[#eceae2] pt-6 text-[13px] text-[#9c988e]">
          © 2026 Myto. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
