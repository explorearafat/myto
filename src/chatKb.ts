// The agentic chat demo's brain. Everything here runs client-side — no model, no
// network, no key. A visitor's question is matched against this curated knowledge base
// (every fact traces to data.ts / public/llms.txt), and the page animates the matched
// answer's thinking steps before revealing it. Off-topic questions fall back honestly.

import { LINKS } from './data';

export interface ChatAnswer {
  /** Stable id — referenced by SUGGESTED and by other answers' `related`. */
  id: string;
  /** Lowercased match terms. Single words match on token boundary; phrases match as substrings. */
  keywords: string[];
  /** The canonical question — the chip label, and what a suggested/related click asks. */
  question: string;
  /** The thinking steps shown one-by-one before the answer lands. 2–4 reads best. */
  steps: string[];
  /** Optional short serif title, shown above the lead — the "heading" of the reply. */
  heading?: string;
  /** Opening sentence of the answer. */
  lead: string;
  /** Optional organized points under the lead. */
  bullets?: string[];
  /** Optional action button (e.g. Download). */
  cta?: { label: string; href: string; external?: boolean };
  /** Ids of follow-up questions, rendered as chips under the answer. */
  related?: string[];
}

/** Generic thinking steps for the fallback and any entry that omits its own. */
const DEFAULT_STEPS = ['Reading your question', 'Looking through what Sylor does', 'Organizing the answer'];

export const CHAT_KB: ChatAnswer[] = [
  {
    id: 'what-is-sylor',
    keywords: [
      'what is sylor',
      'what does sylor',
      'what sylor',
      'about sylor',
      'tell me about',
      'overview',
      'what can',
      'what is this',
      'sylor',
    ],
    question: 'What is Sylor?',
    steps: ['Reading your question', 'Summarizing what Sylor is', 'Organizing the answer'],
    heading: 'A local-first coding workspace',
    lead: 'Sylor is a local-first AI coding workspace. It reads your project, uses the tools you approve, and turns working ideas into working software — on your own machine.',
    bullets: [
      'Understands a codebase, plans the work, then makes precise edits',
      'Shows every change as a diff before anything is written to disk',
      'Extends with MCP connectors and Markdown skills, and runs your build to check its own work',
    ],
    related: ['workflow', 'privacy', 'get-it'],
  },
  {
    id: 'privacy',
    keywords: [
      'privacy',
      'private',
      'my code',
      'leave my machine',
      'leave my computer',
      'data',
      'secure',
      'security',
      'send my code',
      'upload',
      'confidential',
      'local-first',
      'local first',
    ],
    question: 'Does my code leave my machine?',
    steps: ['Reading your question', "Checking Sylor's privacy model", 'Organizing the answer'],
    heading: 'Your code stays on your machine',
    lead: 'Sylor works from the project on your disk, so your code stays local. Model requests go wherever you point them.',
    bullets: [
      'A local Ollama at http://localhost:11434 never leaves your machine',
      'A hosted endpoint receives only the context that a given request needs',
      "Nothing is sent anywhere you didn't configure",
    ],
    related: ['models', 'offline', 'approvals'],
  },
  {
    id: 'models',
    keywords: [
      'model',
      'models',
      'which model',
      'ollama',
      'openai',
      'endpoint',
      'llm',
      'gpt',
      'claude',
      'anthropic',
      'reasoning effort',
    ],
    question: 'Which models can I use?',
    steps: ['Reading your question', 'Checking supported model options', 'Organizing the answer'],
    heading: 'Bring your own model',
    lead: 'Anything Ollama serves locally, or any OpenAI-compatible endpoint.',
    bullets: [
      'Set the base URL and key in Settings, then pick a model',
      'Run fully local with Ollama, or point at a hosted provider',
      'Reasoning effort is a per-turn setting, from low to max',
    ],
    related: ['privacy', 'offline', 'cost'],
  },
  {
    id: 'approvals',
    keywords: [
      'edit',
      'edits',
      'without asking',
      'approve',
      'approval',
      'permission',
      'permissions',
      'diff',
      'autonomous',
      'safe',
      'delete',
      'destructive',
      'command',
    ],
    question: 'Will it edit files without asking?',
    steps: ['Reading your question', 'Checking the approval model', 'Organizing the answer'],
    heading: 'You approve every change',
    lead: 'Reads happen on their own; anything that changes your project asks first.',
    bullets: [
      'Edits arrive as a diff you approve before they touch disk',
      'Commands, network access, and destructive steps ask first',
      'Choose ask-every-time, auto-approve-edits, or fully autonomous',
    ],
    related: ['workflow', 'privacy', 'what-is-sylor'],
  },
  {
    id: 'cost',
    keywords: ['cost', 'price', 'pricing', 'free', 'pay', 'paid', 'money', 'subscription', 'license', 'expensive'],
    question: 'What does it cost?',
    steps: ['Reading your question', 'Checking pricing', 'Organizing the answer'],
    heading: 'Free to use',
    lead: 'The app is free and the source is on GitHub.',
    bullets: [
      'Your only cost is whatever your model provider charges',
      'Nothing at all if the model runs locally',
    ],
    cta: { label: 'See the source on GitHub', href: LINKS.repo, external: true },
    related: ['models', 'get-it', 'offline'],
  },
  {
    id: 'platforms',
    keywords: [
      'platform',
      'platforms',
      'windows',
      'mac',
      'macos',
      'linux',
      'android',
      'ios',
      'iphone',
      'operating system',
      'supported',
    ],
    question: 'Which platforms are supported?',
    steps: ['Reading your question', 'Checking platform support', 'Organizing the answer'],
    heading: 'Windows today, more soon',
    lead: 'Windows 10 and 11, 64-bit, today. macOS and Linux are planned.',
    bullets: [
      'The Windows installer is available now',
      'macOS and Linux are packaging work, not a rewrite — Sylor runs on Electron',
      'A browser build opens on any phone if you want to look around',
    ],
    cta: { label: 'Open the download page', href: LINKS.downloadPage, external: false },
    related: ['get-it', 'offline'],
  },
  {
    id: 'offline',
    keywords: [
      'offline',
      'no internet',
      'without internet',
      'connection',
      'air-gapped',
      'air gapped',
      'disconnected',
      'network',
    ],
    question: 'Does it work offline?',
    steps: ['Reading your question', 'Checking the offline story', 'Organizing the answer'],
    heading: 'Runs fully offline',
    lead: 'With a local model, yes. The workspace itself needs no connection.',
    bullets: [
      "Only your chosen provider needs the network, and only if it's remote",
      'Point Sylor at a local Ollama and the whole loop runs offline',
    ],
    related: ['models', 'privacy'],
  },
  {
    id: 'workflow',
    keywords: [
      'how does it work',
      'how it works',
      'how does sylor',
      'workflow',
      'process',
      'steps',
      'plan',
      'verify',
      'understand',
      'what happens',
      'agentic',
      'thinking',
      'reason',
    ],
    question: 'How does Sylor work through a task?',
    steps: ['Reading your question', 'Tracing the workflow', 'Planning the answer', 'Organizing it'],
    heading: 'Understand, plan, edit, verify',
    lead: 'It moves through a task the way a careful engineer would — understand, plan, edit, then verify.',
    bullets: [
      'Understand — map the project and find the exact files a task needs',
      'Plan — break the work into steps before touching a file',
      'Edit — change several files, one reviewable diff at a time',
      'Verify — run your build and tests, read the errors, and fix until it passes',
    ],
    related: ['approvals', 'parallel', 'what-is-sylor'],
  },
  {
    id: 'mcp',
    keywords: [
      'mcp',
      'connector',
      'connectors',
      'integration',
      'integrations',
      'tools',
      'server',
      'servers',
      'model context protocol',
    ],
    question: 'How does it use my tools?',
    steps: ['Reading your question', 'Checking connectors and tools', 'Organizing the answer'],
    heading: 'Your tools, connected',
    lead: 'Connect MCP servers and drop in Markdown skills — each one stays off until you turn it on.',
    bullets: [
      'Every connector states what it can reach: local files, the network, your system',
      'Add Markdown skills as reusable procedures',
      'Run builds, scripts, and dev commands in a real terminal',
    ],
    related: ['skills', 'approvals', 'workflow'],
  },
  {
    id: 'skills',
    keywords: [
      'skill',
      'skills',
      'markdown',
      'procedure',
      'procedures',
      'reusable',
      'slash command',
      'slash commands',
      'commands',
      'plugin',
      'plugins',
    ],
    question: 'What are skills and slash commands?',
    steps: ['Reading your question', 'Checking skills and commands', 'Organizing the answer'],
    heading: 'Skills and slash commands',
    lead: 'A folder of Markdown files becomes a set of procedures Sylor can follow on request.',
    bullets: [
      'Skills are plain .md files — reusable steps you write once',
      'A / menu covers built-ins, your saved commands, and anything a plugin adds',
    ],
    related: ['mcp', 'workflow'],
  },
  {
    id: 'sylorium',
    keywords: ['browser', 'sylorium', 'web', 'internet', 'browse', 'website', 'page', 'dom', 'click', 'form'],
    question: 'What is the Sylorium browser?',
    steps: ['Reading your question', 'Checking the Sylorium browser', 'Organizing the answer'],
    heading: 'A browser with an agent',
    lead: 'Sylorium is a real browser inside Sylor, with an agent alongside it.',
    bullets: [
      'Open a page, then ask about it — Sylor reads the structure and works through the steps',
      'Clicks and forms ask first; payments are blocked outright',
    ],
    related: ['approvals', 'what-is-sylor'],
  },
  {
    id: 'parallel',
    keywords: [
      'parallel',
      'sub-agent',
      'subagent',
      'sub agents',
      'sub-agents',
      'background',
      'worktree',
      'at the same time',
      'concurrent',
      'faster',
      'big job',
    ],
    question: 'Can it work on several things at once?',
    steps: ['Reading your question', 'Checking parallel work', 'Organizing the answer'],
    heading: 'Work in parallel',
    lead: 'Larger jobs get split up and run at the same time.',
    bullets: [
      'Hand independent pieces to sub-agents',
      'Keep risky edits in their own git worktree',
      'Leave a run going in the background and start something else',
    ],
    related: ['workflow', 'automate'],
  },
  {
    id: 'automate',
    keywords: [
      'automate',
      'automation',
      'hook',
      'hooks',
      'schedule',
      'scheduled',
      'headless',
      'cli',
      'terminal',
      'script',
      'scripts',
      'ci',
    ],
    question: 'Can I automate it?',
    steps: ['Reading your question', 'Checking automation options', 'Organizing the answer'],
    heading: 'Automate and run headless',
    lead: 'The repetitive part stops being your job.',
    bullets: [
      'Fire hooks on tool events to format, lint, or block a command',
      'Schedule tasks to run on their own',
      'Drive the same engine from a terminal with sylor -p, and --json for scripts',
    ],
    related: ['parallel', 'workflow'],
  },
  {
    id: 'get-it',
    keywords: [
      'download',
      'get it',
      'get sylor',
      'install',
      'installer',
      'try',
      'setup',
      'where',
      'how do i get',
      'obtain',
      'start',
    ],
    question: 'How do I get Sylor?',
    steps: ['Reading your question', 'Checking how to install', 'Organizing the answer'],
    heading: 'Getting started',
    lead: 'The Windows installer is ready today — download it, open a project folder, and describe your first task.',
    bullets: [
      "Windows 10 or 11, 64-bit; it's self-signed, so click More info → Run anyway on first launch",
      "You'll need a model to talk to: a local Ollama, or any OpenAI-compatible endpoint in Settings",
      'Prefer zero install? A browser build is available too',
    ],
    cta: { label: 'Download for Windows', href: LINKS.download, external: true },
    related: ['platforms', 'models', 'cost'],
  },
];

/** Shown when nothing matches — honest that this is a Sylor-only demo. */
export const CHAT_FALLBACK: ChatAnswer = {
  id: 'fallback',
  keywords: [],
  question: '',
  steps: ['Reading your question', 'Looking for a match', 'Organizing what I can help with'],
  lead: "I'm a demo of Sylor's chat, so I answer questions about Sylor itself. Here are a few things I can walk you through:",
  related: ['what-is-sylor', 'workflow', 'privacy', 'models', 'get-it'],
};

/** Ids for the empty-state prompt chips. */
export const SUGGESTED: string[] = ['what-is-sylor', 'workflow', 'privacy', 'models', 'approvals', 'get-it'];

const BY_ID = new Map<string, ChatAnswer>(
  [...CHAT_KB, CHAT_FALLBACK].map((a) => [a.id, a]),
);

/** Resolve an id to its answer, falling back gracefully. */
export function answerById(id: string): ChatAnswer {
  return BY_ID.get(id) ?? CHAT_FALLBACK;
}

/** Ensure every answer has thinking steps to animate. */
export function stepsFor(answer: ChatAnswer): string[] {
  return answer.steps.length > 0 ? answer.steps : DEFAULT_STEPS;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score each entry by keyword hits and return the best over a small threshold, else the
 * fallback. Single-word keywords must match a whole token (so "api" can't hit "rapid");
 * multi-word keywords match as substrings and are weighted heavier. Pure and synchronous.
 */
export function matchAnswer(query: string): ChatAnswer {
  const norm = normalize(query);
  if (!norm) return CHAT_FALLBACK;
  const tokens = new Set(norm.split(' '));

  let best = CHAT_FALLBACK;
  let bestScore = 0;
  for (const entry of CHAT_KB) {
    let score = 0;
    for (const kw of entry.keywords) {
      const k = normalize(kw);
      if (k.includes(' ')) {
        if (norm.includes(k)) score += k.split(' ').length + 1;
      } else if (tokens.has(k)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore > 0 ? best : CHAT_FALLBACK;
}
