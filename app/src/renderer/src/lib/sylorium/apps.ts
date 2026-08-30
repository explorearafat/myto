/**
 * The curated set of web apps shown on the Sylorium launcher (the browser pane's
 * home screen). This is a small, hand-picked list of the sites the user reaches
 * for most — not a general bookmark manager. Each entry drives one launcher tile;
 * clicking it navigates the active tab to `url`.
 *
 * Icons are rendered by {@link AppGlyph} (appIcons.tsx) keyed on `key`, as inline
 * SVG brand marks — the app's strict CSP blocks loading logos from the web, so the
 * launcher must stay fully offline. To add an app: add an entry here and a matching
 * `case` in AppGlyph.
 */

/** One launcher tile: a recognizable brand mark that opens a real site. */
export interface EssentialApp {
  /** Stable key; also selects the brand glyph in {@link AppGlyph}. */
  key: string
  /** Short label under the tile. */
  label: string
  /** The site to open (https). Loaded via the normal, user-driven nav path. */
  url: string
  /** Brand color for the tile's glyph chip (inline style — not a theme token). */
  color: string
}

/** The launcher's apps, in display order. Edit freely — the grid reflows. */
export const ESSENTIAL_APPS: EssentialApp[] = [
  { key: 'gmail', label: 'Gmail', url: 'https://mail.google.com', color: '#EA4335' },
  { key: 'whatsapp', label: 'WhatsApp', url: 'https://web.whatsapp.com', color: '#25D366' },
  { key: 'telegram', label: 'Telegram', url: 'https://web.telegram.org', color: '#229ED9' },
  { key: 'instagram', label: 'Instagram', url: 'https://www.instagram.com', color: '#E1306C' },
  { key: 'x', label: 'X', url: 'https://x.com', color: '#0F1419' },
  { key: 'facebook', label: 'Facebook', url: 'https://www.facebook.com', color: '#1877F2' },
  { key: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com', color: '#0A66C2' },
  { key: 'youtube', label: 'YouTube', url: 'https://www.youtube.com', color: '#FF0000' },
  { key: 'google', label: 'Google', url: 'https://www.google.com', color: '#4285F4' },
  { key: 'github', label: 'GitHub', url: 'https://github.com', color: '#181717' }
]
