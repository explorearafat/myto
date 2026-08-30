/**
 * AppGlyph — inline SVG brand marks for the Sylorium launcher tiles.
 *
 * Rendered as a single `currentColor` glyph so the launcher tile can supply the
 * brand color (a colored chip with white glyph). These are hand-simplified marks,
 * not the official logos, and they are inline SVG on purpose: the app's strict CSP
 * blocks loading favicons/logos from the web, so the launcher must stay offline.
 *
 * This module exports ONLY a component, so React Fast Refresh stays happy. To add
 * an app, add a `case` here whose key matches its entry in `lib/sylorium/apps.ts`.
 */

/** A brand mark for one launcher app, keyed to an {@link ESSENTIAL_APPS} entry. */
export function AppGlyph({ appKey, size = 22 }: { appKey: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const
  switch (appKey) {
    case 'gmail':
      return (
        <svg {...p}>
          <rect x="3" y="5.5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'whatsapp':
      return (
        <svg {...p}>
          <path
            d="M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.4-1.1A8.5 8.5 0 1 0 12 3.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M9.3 8.4c-.2 0-.5.1-.7.4-.3.3-.8.9-.8 2.1s.9 2.4 1 2.6c.2.2 1.8 2.8 4.4 3.6 1.3.4 1.8.3 2.2.2.5-.1 1.3-.6 1.5-1.1.2-.5.2-1 .1-1.1l-1.9-.9c-.2-.1-.4 0-.6.2l-.5.7c-.1.1-.3.2-.5.1-.5-.2-1.2-.5-1.9-1.3-.5-.5-.7-1.1-.8-1.3-.1-.2 0-.3.1-.4l.4-.5c.1-.1.1-.3 0-.5l-.8-1.9c-.1-.2-.3-.3-.5-.3Z"
            fill="currentColor"
          />
        </svg>
      )
    case 'telegram':
      return (
        <svg {...p}>
          <path
            d="M20.7 4.3 3.4 11c-.7.3-.7 1.2.1 1.4l4.3 1.3 1.6 5.1c.2.5.8.6 1.2.2l2.3-2.5 4.4 3.2c.5.3 1.1.1 1.2-.5l3-13.2c.2-.6-.4-1.1-1-.9Z"
            fill="currentColor"
          />
        </svg>
      )
    case 'instagram':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3.8" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16.6" cy="7.4" r="1.1" fill="currentColor" />
        </svg>
      )
    case 'x':
      return (
        <svg {...p}>
          <path
            d="M4.5 4h3.4l4 5.7L16.5 4H20l-6.3 7.9L20.4 20H17l-4.3-6.1L7.8 20H4.2l6.7-8.4L4.5 4Z"
            fill="currentColor"
          />
        </svg>
      )
    case 'facebook':
      return (
        <svg {...p}>
          <path
            d="M14.6 8.4H13c-.5 0-.9.4-.9.9V12h2.5l-.4 2.6h-2.1V21H9.5v-6.4H7.6V12h1.9V9c0-2 1.2-3.4 3.3-3.4.9 0 1.8.1 1.8.1v2.7Z"
            fill="currentColor"
          />
        </svg>
      )
    case 'linkedin':
      return (
        <svg {...p}>
          <circle cx="7" cy="6.9" r="1.5" fill="currentColor" />
          <rect x="5.7" y="9.7" width="2.6" height="7.6" rx="0.4" fill="currentColor" />
          <path
            d="M11 17.3V9.7h2.5v1.1c.5-.8 1.4-1.3 2.5-1.3 2 0 3.3 1.5 3.3 3.9v3.9h-2.6v-3.5c0-1.1-.5-1.8-1.5-1.8s-1.6.7-1.6 1.8v3.5H11Z"
            fill="currentColor"
          />
        </svg>
      )
    case 'youtube':
      return (
        <svg {...p}>
          <rect x="3" y="6" width="18" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M10.5 9.3l4.6 2.7-4.6 2.7V9.3Z" fill="currentColor" />
        </svg>
      )
    case 'google':
      return (
        <svg {...p}>
          <path
            d="M17.4 8.4A6 6 0 1 0 18.2 12H12"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'github':
      return (
        <svg {...p}>
          <path
            d="M12 3.4a8.6 8.6 0 0 0-2.7 16.8c.4.1.6-.2.6-.4v-1.5c-2.4.5-2.9-1.1-2.9-1.1-.4-1-1-1.3-1-1.3-.8-.5.1-.5.1-.5.9.1 1.3.9 1.3.9.8 1.3 2.1.9 2.6.7.1-.6.3-1 .6-1.2-1.9-.2-3.9-1-3.9-4.2 0-.9.3-1.7.9-2.3-.1-.2-.4-1.1.1-2.4 0 0 .7-.2 2.4.9a8.2 8.2 0 0 1 4.3 0c1.6-1.1 2.3-.9 2.3-.9.5 1.3.2 2.2.1 2.4.6.6.9 1.4.9 2.3 0 3.2-2 4-3.9 4.2.3.3.6.8.6 1.7v2.4c0 .2.2.5.6.4A8.6 8.6 0 0 0 12 3.4Z"
            fill="currentColor"
          />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
          <path d="M4 12h16M12 4c2.4 2.2 3.6 5 3.6 8S14.4 20 12 20M12 4C9.6 6.2 8.4 9 8.4 12s1.2 5.8 3.6 8" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )
  }
}
