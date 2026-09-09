// Single source of truth for the lean marketing page.

export const LINKS = {
  // Sylor is closed-source. The source repo is private, and private-repo release
  // assets are not anonymously downloadable — so every public download points at
  // the `sylor-dist` mirror, which holds only the built installers, never source.
  /** Direct Windows installer (public downloads mirror). */
  download: 'https://github.com/explorearafat/sylor-dist/releases/latest/download/Sylor-Setup.exe',
  /** Native Android APK (public downloads mirror). Live once the first release with an APK ships. */
  androidApk: 'https://github.com/explorearafat/sylor-dist/releases/latest/download/sylor.apk',
  /** The platform chooser — where every Download button on the site points. */
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
  version: 'v0.1.5',
  date: '30 August 2026',
  size: '116 MB',
};

export interface Feature {
  title: string;
  body: string;
  points: string[];
}

/** Four plain facts under the hero. Not metrics, not badges. */
export const GLANCE: { label: string; value: string }[] = [
  { label: 'Runs', value: 'On your own machine' },
  { label: 'Models', value: 'Local, or your endpoint' },
  { label: 'Extends with', value: 'MCP and Markdown skills' },
  { label: 'Price', value: 'Free' },
];

export interface Shot {
  title: string;
  body: string;
  /** Path under public/ — a real 1440x900 capture of the app. */
  img: string;
  alt: string;
}

/** "A look inside" — alternating screenshot / text rows. */
export const SHOWCASE: Shot[] = [
  {
    title: 'Every change arrives as a diff',
    body: 'Sylor says what it is about to do, then shows the exact edit. Nothing is written until you approve it, and it runs your build afterwards so you know the change compiles.',
    img: '/shots/chat.jpg',
    alt: 'The Sylor chat panel: an assistant reply about theming, with an inline diff of Settings.tsx adding a ThemeToggle import, and a build command below it.',
  },
  {
    title: 'A browser it can actually use',
    body: 'Sylorium is a real browser inside Sylor. Open a page, then ask about it — Sylor reads the structure and works through the steps, and asks first before anything sensitive.',
    img: '/shots/sylorium.jpg',
    alt: 'Sylorium: a browser tab with pinned app tiles on the left and a panel on the right reading "Ask Sylor about the web".',
  },
  {
    title: 'Your tools, permission-gated',
    body: 'Connect MCP servers and drop in Markdown skills. Each connector states what it can reach — local files, the network, your system — and stays off until you turn it on.',
    img: '/shots/connectors.jpg',
    alt: 'The Connectors settings pane listing MCP servers with read-only, local, and network labels, three of six enabled.',
  },
];

/** "What it does" — distilled, honest, plain. */
export const FEATURES: Feature[] = [
  {
    title: 'Understand',
    body: 'Sylor maps your project before it changes anything.',
    points: [
      'Read an unfamiliar codebase across TypeScript, Python, Go, and Rust',
      'Find the exact files a task needs instead of re-reading everything',
      'Carry project notes forward in SYLOR.md rather than relearning them',
    ],
  },
  {
    title: 'Plan & edit',
    body: 'It breaks work into steps, then makes precise edits.',
    points: [
      'Plan multi-step work before touching a single file',
      'Change several files at once, one reviewable action at a time',
      'Show the full diff and wait, instead of writing and apologising',
    ],
  },
  {
    title: 'Use tools',
    body: 'It works with the tools and services you already have.',
    points: [
      'Connect MCP servers — each one states what it can reach',
      'Add Markdown skills as reusable procedures',
      'Run builds, scripts, and dev commands in a real terminal',
    ],
  },
  {
    title: 'Verify',
    body: 'It checks its own work instead of hoping it compiles.',
    points: [
      'Run your build and tests, then read the errors',
      'Open the dev server and inspect the page it just changed',
      'Fix and re-check until everything passes',
    ],
  },
  {
    title: 'Work in parallel',
    body: 'Larger jobs get split up and run at the same time.',
    points: [
      'Hand independent pieces to sub-agents',
      'Keep risky edits in their own git worktree',
      'Leave a run going in the background and start something else',
    ],
  },
  {
    title: 'Automate',
    body: 'The repetitive part stops being your job.',
    points: [
      'Fire hooks on tool events to format, lint, or block a command',
      'Schedule tasks to run on their own',
      'Drive the same engine from a terminal with sylor -p',
    ],
  },
];

export interface WorkspaceItem {
  name: string;
  body: string;
}

/** "Everything in one window" — the concrete surface, in one flat list. */
export const WORKSPACE: WorkspaceItem[] = [
  {
    name: 'Chat with diffs',
    body: 'Every edit appears as a diff, one action at a time, before anything is written to disk.',
  },
  {
    name: 'A real terminal',
    body: 'A full shell in the workspace. Your commands and the agent’s run in the same place.',
  },
  {
    name: 'Live preview',
    body: 'Start your dev server beside the chat — and let Sylor read the DOM and computed styles to confirm a fix landed.',
  },
  {
    name: 'Sylorium browser',
    body: 'A browser inside Sylor with an agent alongside it. Clicks and forms ask first; payments are blocked outright.',
  },
  {
    name: 'MCP connectors',
    body: 'Add servers in Settings. Each is labelled read-only, local, or network, and stays off until you switch it on.',
  },
  {
    name: 'Markdown skills',
    body: 'A folder of .md files becomes a set of procedures Sylor can follow on request.',
  },
  {
    name: 'Slash commands',
    body: 'A / menu for built-ins, your own saved commands, and anything a plugin adds.',
  },
  {
    name: 'Sub-agents',
    body: 'Parallel workers for independent pieces, with optional git-worktree isolation for the risky ones.',
  },
  {
    name: 'Background runs',
    body: 'Send a long job to the background, start a new chat, and come back to it still running.',
  },
  {
    name: 'Project memory',
    body: 'SYLOR.md at the user, project, and folder level, with @import to pull in more when needed.',
  },
  {
    name: 'Automation',
    body: 'Hooks that fire on tool events, and scheduled tasks that run on their own.',
  },
  {
    name: 'Images in chat',
    body: 'Paste a screenshot or a mockup and Sylor works from what it sees.',
  },
  {
    name: 'History that stays',
    body: 'Conversations persist locally and survive restarts, folder switches, and interrupted runs.',
  },
  {
    name: 'Headless mode',
    body: 'sylor -p "fix the failing test" runs the same engine with no window, and --json for scripts.',
  },
];

export interface Qa {
  q: string;
  a: string;
}

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
    body: 'A native chat app, built with Flutter — sign in, pick a model, and stream replies on your phone. Like the Windows build it is self-signed, so Android asks you to allow the install from your browser or files app the first time.',
    href: LINKS.androidApk,
    cta: 'Download the APK',
  },
];

/** Plain questions, plain answers. No accordions. */
export const FAQ: Qa[] = [
  {
    q: 'Does my code leave my machine?',
    a: 'Sylor works from the project on your disk. Model requests go wherever you point them: a local Ollama at http://localhost:11434 never leaves the machine, and a hosted endpoint receives only the context that request needs.',
  },
  {
    q: 'Which models can I use?',
    a: 'Anything Ollama serves locally, or any OpenAI-compatible endpoint — set the base URL and key in Settings, then pick a model. Reasoning effort is a per-turn setting, from low to max.',
  },
  {
    q: 'Will it edit files without asking?',
    a: 'Reads happen on their own. Edits arrive as a diff you approve. Commands, network access, and destructive steps ask first. You can run in ask-every-time, auto-approve-edits, or fully autonomous mode.',
  },
  {
    q: 'What does it cost?',
    a: 'The app is free to use. Your only cost is whatever your model provider charges — nothing at all if the model runs locally.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'Windows 10 and 11, 64-bit, today. macOS and Linux are planned. A browser build is available if you want to look around before installing anything.',
  },
  {
    q: 'Does it work offline?',
    a: 'With a local model, yes. The workspace itself needs no connection — only your chosen provider does, if it happens to be remote.',
  },
];
