// Single source of truth for the marketing pages. Section copy (models, steps,
// features, docs) lives inside each component; this file holds only the facts
// that must not drift — links, the current release, and the platform matrix.

export const LINKS = {
  // The `myto` repo is public, so its release assets are anonymously
  // downloadable — every download link points straight at the latest release
  // there, and updates automatically whenever a new tag ships.
  /** Direct Windows installer (latest GitHub release). */
  download: 'https://github.com/explorearafat/myto/releases/latest/download/Myto-Setup.exe',
  /**
   * Native Android APK — pinned to the CURRENT release tag, NOT /releases/latest/.
   * The /latest/ URL keeps one path across releases, so phone browsers (and
   * download managers) happily serve a week-old cached APK; a version-scoped
   * URL is unique per release and can never go stale. Bump together with
   * RELEASE.version below.
   */
  androidApk: 'https://github.com/explorearafat/myto/releases/download/v0.12.2/myto.apk',
  /** The platform chooser — where the header/footer Download links point. */
  downloadPage: '/download',
  /** The Myto chat — a full chat interface, client-side, that answers questions about Myto. */
  chatPage: '/chat',
  /** The Discover community feed. */
  discoverPage: '/discover',
  /** Deep-dive capability pages. */
  featuresPage: '/features',
  /** Who Myto is for, with real scenarios. */
  useCasesPage: '/use-cases',
  /** Myto vs typical cloud coding agents. */
  comparePage: '/compare',
  /** "Bring any model" — providers, Ollama, BYOK. */
  modelsPage: '/models',
  /** Release history. */
  changelogPage: '/changelog',
  /** The community landing that hands off to /discover. */
  communityPage: '/community',
  /** Full documentation. */
  guidePage: '/guide',
  /** The generated-media vault. */
  artifactsPage: '/artifacts',
  /** All published installers (latest GitHub release). */
  releases: 'https://github.com/explorearafat/myto/releases/latest',
  /** Live web build — try it with zero install. */
  web: 'https://mytocode.vercel.app',
};

/**
 * The current published release. Read off `gh release view` — bump this when a
 * new tag ships, or the download page will quietly understate the version.
 */
export const RELEASE = {
  version: 'v0.12.2',
  date: '30 October 2026',
  size: '278 MB',
};

/**
 * The terminal CLI. It's published to npm as `mytocode` (the bare name `myto`
 * was blocked by npm as too similar to existing packages), but the command it
 * installs is still `myto`. Bump `version` when a new build ships and refresh
 * the served tarball in public/cli so the offline install stays in step.
 */
export const CLI = {
  /** The command users actually type after installing. */
  command: 'myto',
  /** Published npm package name. */
  pkg: 'mytocode',
  version: '1.0.0',
  /** Node runtime the bundled `dist/cli.js` targets. */
  node: 'Node.js 20 or newer',
  /** The one-line global install from the npm registry. */
  install: 'npm install -g mytocode',
  /** Offline fallback: the signed tarball this site serves (Vite copies public/ to root). */
  tarballPath: '/cli/mytocode-1.0.0.tgz',
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
 * Android (left), Windows (right), iOS (left).
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
    size: '55 MB',
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
    size: '265 MB',
  },
  {
    name: 'iOS',
    status: 'Planned',
    ready: false,
    requires: 'iPhone and iPad',
    body: 'Not built yet. The Flutter chat app that powers Android is the same codebase iOS will use, so this is App Store packaging and signing rather than a rewrite.',
  },
];
