/*
 * Scroll reveals, done with one IntersectionObserver for the whole page.
 *
 * Anything marked `data-reveal` starts slightly down and transparent, then
 * settles once it scrolls into view. There is no animation library and no
 * scroll listener — the observer fires a handful of times and then unhooks
 * itself, so the page costs nothing to scroll.
 *
 * The hidden starting state lives behind `.reveal-on` on <html>, which this
 * module adds before React renders (see armReveals). If the bundle never loads,
 * the class never lands and every section is simply visible — the failure mode
 * is a plain page, not an empty one.
 */

import { useEffect } from 'react';

const ROOT_CLASS = 'reveal-on';

/** Called from main.tsx before render, so the first paint already has the offset. */
export function armReveals(): void {
  if (typeof document === 'undefined') return;
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add(ROOT_CLASS);
}

export function useReveals(): void {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!('IntersectionObserver' in window)) {
      document.documentElement.classList.remove(ROOT_CLASS);
      return;
    }

    const show = (el: HTMLElement) => el.classList.add('is-visible');

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target as HTMLElement);
          observer.unobserve(entry.target);
        }
      },
      // Trigger a little before the element's top edge crosses the fold, so the
      // movement reads as "arriving" rather than "catching up". The inset is a
      // fixed 40px, not a percentage: at maximum scroll that band always falls
      // inside the footer, which holds no reveals, so nothing can end up stuck
      // in an area the page can never scroll past.
      { rootMargin: '0px 0px -40px 0px', threshold: 0 },
    );

    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, []);
}
