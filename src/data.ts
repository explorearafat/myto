// Single source of truth for the marketing pages. Section copy (models, steps,
// features, docs) lives inside each component; this file holds only the facts
// that must not drift — links, the current release, and the platform matrix.

export const LINKS = {
  // Myto is closed-source. The source repo is private, and private-repo release
  // assets are not anonymously downloadable — so every public download points at
  // the `myto-dist` mirror, which holds only the built installers, never source.
  /** Direct Windows installer (public downloads mirror). */
  download: 'https://github.com/explorearafat/myto-dist/releases/latest/download/Myto-Setup.exe',
  /** Native Android APK (public downloads mirror). */
  androidApk: 'https://github.com/explorearafat/myto-dist/releases/latest/download/myto.apk',
  /** The platform chooser — where the header/footer Download links point. */
  downloadPage: '/download',
  /** The Myto chat — a full chat interface, client-side, that answers questions about Myto. */
  chatPage: '/chat',
  /** All published installers (downloads mirror — no source). */
  releases: 'https://github.com/explorearafat/myto-dist/releases/latest',
  /** Live web build — try it with zero install. */
  web: 'https://mytocode.vercel.app',
};

/**
 * The current published release. Read off `gh release view` — bump this when a
 * new tag ships, or the download page will quietly understate the version.
 */
export const RELEASE = {
  version: 'v0.5.0',
  date: '23 September 2026',
  size: '131 MB',
};

export interface Platform {
  name: string;
  /** Short status, shown as-is next to the name. */
  status: string;
  ready: boolean;
  requires: string;
  body: string;
  /** Optional secondary caveat, shown as a smaller muted line under the body. */
  note?: string;
  href?: string;
  cta?: string;
  /** Installer size, shown on the download card next to the file name. Ready platforms only. */
  size?: string;
  /** Per-platform version label; falls back to RELEASE.version when unset. */
  version?: string;
}

/*
 * The /download page renders these as alternating left/right blocks, so the ORDER
 * here is load-bearing: index parity (`i % 2`) decides which side the media sits on.
 * Android (left), Windows (right), iOS (left), Linux (right), macOS (left).
 */
export const PLATFORMS: Platform[] = [
  {
    name: 'Android',
    status: 'Available now',
    ready: true,
    requires: 'Recent Android phones and tablets',
    body: 'A native chat app, built with Flutter — sign in, pick a model, and stream replies on your phone. Like the Windows build it is self-signed, so Android asks you to allow the install the first time.',
    href: LINKS.androidApk,
    cta: 'Download the APK',
    size: '53 MB',
  },
  {
    name: 'Windows',
    status: 'Available now',
    ready: true,
    requires: 'Windows 10 or 11, 64-bit',
    body: 'The full desktop workspace — the build everyone runs today. Read your project, edit with approval, run the build, all in one window.',
    note: 'Self-signed, so SmartScreen warns on first run: click More info, then Run anyway.',
    href: LINKS.download,
    cta: 'Download the installer',
    size: '129 MB',
  },
  {
    name: 'iOS',
    status: 'Planned',
    ready: false,
    requires: 'iPhone and iPad',
    body: 'Not built yet. The Flutter chat app that powers Android is the same codebase iOS will use, so this is App Store packaging and signing rather than a rewrite.',
  },
  {
    name: 'Linux',
    status: 'Planned',
    ready: false,
    requires: 'x86-64',
    body: 'The workspace itself already runs cross-platform; the packaging is what is missing. The releases page is where a Linux build will show up first.',
  },
  {
    name: 'macOS',
    status: 'Planned',
    ready: false,
    requires: 'Apple silicon and Intel',
    body: 'Not built yet. Myto runs on Electron, so this is packaging and signing work rather than a rewrite — the releases page is the place to watch.',
  },
];
