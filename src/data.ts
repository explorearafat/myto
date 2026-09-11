// Single source of truth for the marketing pages. Section copy (models, steps,
// features, docs) lives inside each component; this file holds only the facts
// that must not drift — links, the current release, and the platform matrix.

export const LINKS = {
  // Sylor is closed-source. The source repo is private, and private-repo release
  // assets are not anonymously downloadable — so every public download points at
  // the `sylor-dist` mirror, which holds only the built installers, never source.
  /** Direct Windows installer (public downloads mirror). */
  download: 'https://github.com/explorearafat/sylor-dist/releases/latest/download/Sylor-Setup.exe',
  /** Native Android APK (public downloads mirror). */
  androidApk: 'https://github.com/explorearafat/sylor-dist/releases/latest/download/sylor.apk',
  /** The platform chooser — where the header/footer Download links point. */
  downloadPage: '/download',
  /** The Sylor chat — a full chat interface, client-side, that answers questions about Sylor. */
  chatPage: '/chat',
  /** All published installers (downloads mirror — no source). */
  releases: 'https://github.com/explorearafat/sylor-dist/releases/latest',
  /** Live web build — try it with zero install. */
  web: 'https://sylorcode.vercel.app',
};

/**
 * The current published release. Read off `gh release view` — bump this when a
 * new tag ships, or the download page will quietly understate the version.
 */
export const RELEASE = {
  version: 'v0.2.1',
  date: '11 September 2026',
  size: '131 MB',
};

export interface Platform {
  name: string;
  /** Short status, shown as-is next to the name. */
  status: string;
  ready: boolean;
  requires: string;
  body: string;
  href?: string;
  cta?: string;
}

/** The /download page. Statuses are deliberately blunt — no fake "soon" links. */
export const PLATFORMS: Platform[] = [
  {
    name: 'Windows',
    status: 'Available now',
    ready: true,
    requires: 'Windows 10 or 11, 64-bit',
    body: 'The installer everyone uses today. It is self-signed, so SmartScreen warns on first run — click More info, then Run anyway.',
    href: LINKS.download,
    cta: 'Download the installer',
  },
  {
    name: 'macOS',
    status: 'Planned',
    ready: false,
    requires: 'Apple silicon and Intel',
    body: 'Not built yet. Sylor runs on Electron, so this is packaging and signing work rather than a rewrite — the releases page is the place to watch.',
  },
  {
    name: 'Linux',
    status: 'Planned',
    ready: false,
    requires: 'x86-64',
    body: 'Same position as macOS: the workspace itself already runs cross-platform, and the packaging is what is missing.',
  },
  {
    name: 'Android',
    status: 'Available now',
    ready: true,
    requires: 'Recent Android phones and tablets',
    body: 'A native chat app, built with Flutter — sign in, pick a model, and stream replies on your phone. Like the Windows build it is self-signed, so Android asks you to allow the install the first time.',
    href: LINKS.androidApk,
    cta: 'Download the APK',
  },
];
