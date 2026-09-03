/**
 * AppGlyph — full-color inline SVG brand logos for the browser launcher tiles.
 *
 * Each case renders a self-contained, full-bleed badge (its own background fill +
 * mark) that fills the tile; the launcher wraps it in an `overflow-hidden
 * rounded-2xl` chip, so the square art reads as a rounded app icon. These are
 * inline SVG on purpose: the app's strict CSP (`img-src 'self' data:`) blocks
 * loading real favicons/logos from the web, so the launcher must stay offline.
 *
 * This module exports ONLY a component, so React Fast Refresh stays happy. To add
 * an app, add a `case` here whose key matches its entry in `lib/browser/apps.ts`.
 */

/** A full-color brand logo for one launcher app, keyed to an ESSENTIAL_APPS entry. */
export function AppGlyph({ appKey }: { appKey: string }) {
  const p = { width: '100%', height: '100%', viewBox: '0 0 48 48', 'aria-hidden': true } as const
  switch (appKey) {
    case 'gmail':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#fff" />
          <g fill="none" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round">
            <path stroke="#4285F4" d="M11.5 33.5V18.5" />
            <path stroke="#EA4335" d="M11.5 18.5 24 27.5" />
            <path stroke="#FBBC05" d="M24 27.5 36.5 18.5" />
            <path stroke="#34A853" d="M36.5 18.5v15" />
          </g>
        </svg>
      )
    case 'whatsapp':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#25D366" />
          <path fill="#fff" d="M24 12.5c-6.9 0-12.5 5.6-12.5 12.5 0 2.2.6 4.3 1.6 6.1L11.5 37l6.1-1.6c1.8 1 3.8 1.5 5.9 1.5h.5c6.9 0 12.5-5.6 12.5-12.5S30.9 12.5 24 12.5Z" />
          <path fill="#25D366" d="M19.6 18.8c-.3-.7-.6-.7-.9-.7h-.8c-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.4s1.5 3.9 1.7 4.2c.2.3 2.9 4.6 7.2 6.3 3.6 1.4 4.3 1.1 5.1 1 .8-.1 2.5-1 2.9-2 .3-1 .3-1.8.2-2-.1-.2-.4-.3-.9-.5s-2.5-1.2-2.9-1.4c-.4-.1-.7-.2-.9.2-.3.4-1.1 1.4-1.3 1.6-.2.2-.5.3-.9.1-.5-.2-2-.7-3.8-2.4-1.4-1.3-2.4-2.8-2.6-3.3-.2-.4 0-.7.2-.9l.7-.8c.2-.3.3-.4.4-.7.1-.3 0-.5 0-.7Z" />
        </svg>
      )
    case 'telegram':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#229ED9" />
          <path fill="#fff" d="M34.6 15.2 12.8 23.6c-1.2.5-1.2 1.7 0 2.1l5.6 1.7 2.1 6.8c.3.9 1 1 1.6.4l3-2.9 5.9 4.4c.6.4 1.4.2 1.6-.6l4-18.9c.2-.9-.6-1.5-1.4-1.2Z" />
          <path fill="#C8DAEA" d="M20.5 34.6c-.3 0-.5-.2-.6-.5l-1.9-6 12.7-8-8.7 9.4-1.1 4.7c-.1.3-.3.4-.4.4Z" />
        </svg>
      )
    case 'instagram':
      return (
        <svg {...p}>
          <defs>
            <radialGradient id="sylorIg" cx="30%" cy="107%" r="140%">
              <stop offset="0" stopColor="#FDD35B" />
              <stop offset="0.28" stopColor="#FA8C3B" />
              <stop offset="0.5" stopColor="#F5274E" />
              <stop offset="0.72" stopColor="#B12A9B" />
              <stop offset="1" stopColor="#4C63D2" />
            </radialGradient>
          </defs>
          <rect width="48" height="48" fill="url(#sylorIg)" />
          <rect x="14" y="14" width="20" height="20" rx="6" fill="none" stroke="#fff" strokeWidth="2.6" />
          <circle cx="24" cy="24" r="5.4" fill="none" stroke="#fff" strokeWidth="2.6" />
          <circle cx="30.8" cy="17.2" r="1.7" fill="#fff" />
        </svg>
      )
    case 'x':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#000" />
          <path fill="#fff" d="M28.2 22.8 37.5 12h-2.2l-8.1 9.4L20.7 12H13l9.8 14.3L13 37h2.2l8.6-10 6.9 10H38L27.8 22.8Zm-3 3.5-1-1.4-7.9-11.3h3.4l6.4 9.2 1 1.4 8.3 11.9h-3.4l-6.8-9.8Z" />
        </svg>
      )
    case 'facebook':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#1877F2" />
          <path fill="#fff" d="M30.3 25.6 31.1 20.4h-5V17c0-1.4.7-2.8 3-2.8h2.3V9.8s-2.1-.4-4-.4c-4.1 0-6.8 2.5-6.8 7v3.9h-4.6v5.2h4.6V38h5.6V25.6Z" />
        </svg>
      )
    case 'linkedin':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#0A66C2" />
          <circle cx="16" cy="16.4" r="2.8" fill="#fff" />
          <rect x="13.3" y="21" width="5.4" height="15" fill="#fff" />
          <path fill="#fff" d="M21.6 21h5.2v2.1c.8-1.3 2.5-2.6 5-2.6 4.2 0 6.2 2.8 6.2 6.9V36h-5.4v-7.6c0-2-.7-3.4-2.5-3.4-1.4 0-2.2 1-2.6 1.9-.1.3-.2.8-.2 1.2V36h-5.3s.1-13.8 0-15Z" />
        </svg>
      )
    case 'youtube':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#fff" />
          <rect x="7" y="15" width="34" height="18" rx="5.5" fill="#FF0000" />
          <path fill="#fff" d="M21 20.3v7.4l6.4-3.7z" />
        </svg>
      )
    case 'google':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#fff" />
          <g transform="translate(12 12)">
            <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.4H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z" />
            <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A11.9 11.9 0 0 0 12 24Z" />
            <path fill="#FBBC05" d="M5.4 15.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.4V6.6H1.4A11.9 11.9 0 0 0 0 12c0 1.9.5 3.7 1.4 5.4z" />
            <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A11.5 11.5 0 0 0 12 0 11.9 11.9 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
          </g>
        </svg>
      )
    case 'github':
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#181717" />
          <g transform="translate(6 6) scale(1.5)">
            <path fill="#fff" d="M12 3.4a8.6 8.6 0 0 0-2.7 16.8c.4.1.6-.2.6-.4v-1.5c-2.4.5-2.9-1.1-2.9-1.1-.4-1-1-1.3-1-1.3-.8-.5.1-.5.1-.5.9.1 1.3.9 1.3.9.8 1.3 2.1.9 2.6.7.1-.6.3-1 .6-1.2-1.9-.2-3.9-1-3.9-4.2 0-.9.3-1.7.9-2.3-.1-.2-.4-1.1.1-2.4 0 0 .7-.2 2.4.9a8.2 8.2 0 0 1 4.3 0c1.6-1.1 2.3-.9 2.3-.9.5 1.3.2 2.2.1 2.4.6.6.9 1.4.9 2.3 0 3.2-2 4-3.9 4.2.3.3.6.8.6 1.7v2.4c0 .2.2.5.6.4A8.6 8.6 0 0 0 12 3.4Z" />
          </g>
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <rect width="48" height="48" fill="#64748B" />
          <g transform="translate(12 12)" fill="none" stroke="#fff" strokeWidth="1.6">
            <circle cx="12" cy="12" r="8" />
            <path d="M4 12h16M12 4c2.4 2.2 3.6 5 3.6 8S14.4 20 12 20M12 4C9.6 6.2 8.4 9 8.4 12s1.2 5.8 3.6 8" />
          </g>
        </svg>
      )
  }
}
