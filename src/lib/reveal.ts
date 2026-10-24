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

    // Anything already inside the viewport reveals immediately, so the hero is
    // painted on the first frame instead of one observer tick later.
    const fold = window.innerHeight || document.documentElement.clientHeight;
    for (const el of targets) {
      if (el.getBoundingClientRect().top < fold) show(el);
    }

    // Safety net. If the observer never delivers a single entry — a hidden or
    // zero-size pane, a headless screenshot, an embedded webview — nothing
    // would ever un-hide and the page would render empty. That contradicts the
    // contract at the top of this file: the failure mode must be a plain
    // visible page. Dropping the root class reveals every section at once.
    let fired = false;
    const bail = window.setTimeout(() => {
      if (!fired) document.documentElement.classList.remove(ROOT_CLASS);
    }, 1000);

    const observer = new IntersectionObserver(
      (entries) => {
        fired = true;
        window.clearTimeout(bail);
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
    return () => {
      window.clearTimeout(bail);
      observer.disconnect();
    };
  }, []);
}
