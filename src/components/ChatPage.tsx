import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight,
  ArrowUp,
  Blocks,
  Check,
  ChevronDown,
  Code2,
  FolderKanban,
  LogOut,
  MessageSquare,
  Mic,
  PanelLeft,
  Plug,
  Plus,
  Settings2,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';
import { LINKS } from '../data';
import { matchAnswer } from '../chatKb';
import { SylorStar } from './SylorStar';
import { MessageActions } from './MessageActions';
import { Markdown } from '../lib/markdown';
import { ToolCard } from './ToolCard';
import { parseToolBlocks, hasToolBlocks } from '../lib/toolBlocks';
import { streamChat, type ChatWireMessage } from '../lib/chatClient';
import { ORACULUM_MODELS, DEFAULT_MODEL_ID, modelName } from '../shared/models';
import { profileSummary, type UserProfile } from '../shared/profile';

/*
 * The Sylor chat, modeled closely on claude.ai/new: a left sidebar (brand, New chat, the
 * Code/Projects/Artifacts/Customize sections, recents, and an account chip) beside a main
 * column that opens on a time-of-day greeting over one rounded input, then collapses into a
 * transcript with the input pinned below once a message is sent.
 *
 * Replies are real: each turn POSTs the conversation to our own /api/chat gateway (which holds
 * the upstream keys, enforces a per-user token quota, and fails over across a model pool) and
 * streams the answer back token by token. The visitor picks between two branded "Oraculum"
 * models; both route across the same pool server-side. If the gateway is unreachable (e.g. local
 * dev with no keys), the turn falls back to the built-in knowledge base so the page still answers.
 *
 * Type follows Claude's split: Georgia (`.font-display`) for the greeting, Inter for everything else.
 */

/** localStorage keys + fallbacks. */
const NAME_KEY = 'sylor.chat.name';
const DEFAULT_NAME = 'Arafat';
const MODEL_KEY = 'sylor.chat.model';

type View = 'chat' | 'code' | 'projects' | 'artifacts' | 'customize';

type TurnStatus = 'thinking' | 'streaming' | 'done' | 'error';

interface Turn {
  id: number;
  question: string;
  modelId: string;
  text: string;
  status: TurnStatus;
  errorCode?: string;
  resetSeconds?: number;
}

/** Sidebar sections below "New chat". Each swaps the main column to a short section view. */
const NAV: { view: Exclude<View, 'chat'>; label: string; icon: LucideIcon }[] = [
  { view: 'code', label: 'Code', icon: Code2 },
  { view: 'projects', label: 'Projects', icon: FolderKanban },
  { view: 'artifacts', label: 'Artifacts', icon: Shapes },
  { view: 'customize', label: 'Customize', icon: Settings2 },
];

/** Copy for the non-chat section views — every line traces to a real Sylor capability. */
const SECTIONS: Record<Exclude<View, 'chat'>, { icon: LucideIcon; title: string; body: string }> = {
  code: {
    icon: Code2,
    title: 'Code',
    body: 'In the Sylor app this is where code lives — it reads your project, plans the work, shows every change as a diff, then runs your build to check the change compiles.',
  },
  projects: {
    icon: FolderKanban,
    title: 'Projects',
    body: 'Open a project folder and Sylor carries its context forward in SYLOR.md — across sessions, folder switches, and restarts, so it never relearns your codebase from scratch.',
  },
  artifacts: {
    icon: Shapes,
    title: 'Artifacts',
    body: 'Preview what Sylor builds: start your dev server beside the chat and let it read the live page — the DOM and computed styles — to confirm a change actually landed.',
  },
  customize: {
    icon: Settings2,
    title: 'Customize',
    body: 'Extend Sylor with Skills, MCP servers, and connectors. Each one states what it can reach and stays off until you turn it on.',
  },
};

/** The three things "Customize" gathers, shown as cards on that section view. */
const CUSTOMIZE_ITEMS: { icon: LucideIcon; label: string; body: string }[] = [
  { icon: Sparkles, label: 'Skills', body: 'Markdown procedures Sylor can follow on request.' },
  { icon: Blocks, label: 'MCP servers', body: 'Connect tools over the Model Context Protocol.' },
  { icon: Plug, label: 'Connectors', body: 'Local files, network, or system — labelled and opt-in.' },
];

const ICON_BTN =
  'flex h-9 w-9 items-center justify-center rounded-lg text-[#6b675e] transition-colors duration-150 hover:bg-[#f0eee6] hover:text-[#141413]';

/** Time-of-day greeting, matching Claude's "Good evening" line. */
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The greeting name: a personalized value from localStorage, else the default. */
function getUserName(): string {
  try {
    const n = localStorage.getItem(NAME_KEY);
    if (n && n.trim()) return n.trim();
  } catch {
    // localStorage can be unavailable (private mode); the default is fine.
  }
  return DEFAULT_NAME;
}

/** Initial model selection, restored from localStorage when valid. */
function getInitialModel(): string {
  try {
    const v = localStorage.getItem(MODEL_KEY);
    if (v && ORACULUM_MODELS.some((m) => m.id === v)) return v;
  } catch {
    // ignore
  }
  return DEFAULT_MODEL_ID;
}

/**
 * The offline fallback: when the gateway is unreachable, answer from the built-in knowledge base
 * so the page is still useful. The matched answer is rendered as Markdown, the same path as a
 * live reply, so there is only one render surface.
 */
function kbMarkdown(question: string): string {
  const a = matchAnswer(question);
  const parts: string[] = [];
  if (a.heading) parts.push(`**${a.heading}**`);
  parts.push(a.lead);
  if (a.bullets && a.bullets.length > 0) parts.push(a.bullets.map((b) => `- ${b}`).join('\n'));
  if (a.cta) parts.push(`[${a.cta.label}](${a.cta.href})`);
  return parts.join('\n\n');
}

/**
 * The compact "who's asking" note prepended to each request so replies fit the visitor. It's sent
 * as a leading user message and never shown in the transcript. Returns null when there's no profile
 * to describe, so callers can simply skip it.
 */
function contextMessage(profile?: UserProfile): ChatWireMessage | null {
  const summary = profileSummary(profile);
  if (!summary) return null;
  return {
    role: 'user',
    content: `(Context about who you're talking to — ${summary}. Address them by name and tailor answers to their role. Don't repeat this back.)`,
  };
}

/** Live `prefers-reduced-motion`, so the streaming caret can be suppressed. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** The calm caveat shown when a visitor has spent their free token budget. */
function QuotaCard({ resetSeconds }: { resetSeconds?: number }) {
  const hrs = resetSeconds ? Math.max(1, Math.round(resetSeconds / 3600)) : null;
  return (
    <div className="rounded-xl border border-[#e4b8a8] bg-[#f9ede8] px-4 py-3 text-[14px] leading-relaxed text-[#8a3b22]">
      You’ve used the free Oraculum tokens for now
      {hrs ? ` — they reset in about ${hrs} hour${hrs > 1 ? 's' : ''}` : ''}. Sylor’s full chat runs
      in the app with your own model, unmetered.
    </div>
  );
}

/**
 * One assistant reply. Presentational: it renders whatever the turn currently holds — a "Thinking…"
 * strip, the streamed Markdown with a blinking caret, a done answer, or the quota card.
 */
function AgentReply({
  turn,
  streaming,
  onRegenerate,
}: {
  turn: Turn;
  streaming: boolean;
  onRegenerate?: (id: number) => void;
}) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="chat-in mt-5 flex gap-3" aria-live="polite">
      <SylorStar size={26} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {turn.status === 'thinking' ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-[#6b675e]">
            <span className="thinking-dot" aria-hidden="true" />
            Thinking…
          </div>
        ) : turn.status === 'error' && turn.errorCode === 'quota' ? (
          <QuotaCard resetSeconds={turn.resetSeconds} />
        ) : (
          <div>
            {turn.text ? (
              hasToolBlocks(turn.text) ? (
                <div className="space-y-3">
                  {parseToolBlocks(turn.text).map((seg, si) =>
                    seg.kind === 'tool' ? (
                      <div key={si}>
                        <ToolCard tool={seg} />
                      </div>
                    ) : (
                      <div key={si}>
                        <Markdown text={seg.text} />
                      </div>
                    ),
                  )}
                </div>
              ) : (
                <Markdown text={turn.text} />
              )
            ) : null}
            {streaming && !reduced ? (
              <span
                className="caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-[#cf5535] align-middle"
                aria-hidden="true"
              />
            ) : null}
            {turn.status === 'done' && !turn.text ? (
              <p className="text-[13px] italic text-[#9c988e]">Stopped.</p>
            ) : null}
            {turn.status === 'done' && turn.text ? (
              <MessageActions
                text={turn.text}
                onRegenerate={onRegenerate ? () => onRegenerate(turn.id) : undefined}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** A non-chat section view (Code / Projects / Artifacts / Customize). */
function SectionView({ view }: { view: Exclude<View, 'chat'> }) {
  const section = SECTIONS[view];
  const Icon = section.icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12 text-center">
      <div className="w-full max-w-md">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#e4e1d8] bg-white text-[#cf5535]">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="font-display mt-5 text-[26px] font-normal leading-tight text-[#141413]">
          {section.title}
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-[#6b675e]">{section.body}</p>

        {view === 'customize' ? (
          <div className="mt-6 grid gap-2 text-left">
            {CUSTOMIZE_ITEMS.map((item) => {
              const RowIcon = item.icon;
              return (
                <div
                  key={item.label}
                  className="flex items-start gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3"
                >
                  <RowIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#cf5535]" aria-hidden="true" />
                  <div>
                    <p className="text-[14px] font-medium text-[#141413]">{item.label}</p>
                    <p className="text-[13px] leading-relaxed text-[#6b675e]">{item.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <a
          href={LINKS.downloadPage}
          className="mt-7 inline-flex items-center gap-2 rounded-md bg-[#cf5535] px-4 py-2 text-[14px] font-medium text-white no-underline transition-colors duration-150 hover:bg-[#b8482c] active:translate-y-px"
        >
          Get Sylor
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

interface ChatPageProps {
  /** The signed-in user's profile — drives the greeting, the account chip, and reply context. */
  profile?: UserProfile;
  /** Sign the user out; when provided, a sign-out control appears on the account chip. */
  onSignOut?: () => void;
}

export function ChatPage({ profile, onSignOut }: ChatPageProps = {}) {
  const reduced = usePrefersReducedMotion();
  const [greeting] = useState(getGreeting);
  const name = profile?.nickname?.trim() || profile?.name?.trim() || getUserName();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [view, setView] = useState<View>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>(getInitialModel);
  const [streamingId, setStreamingId] = useState<number | null>(null);

  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const turnsRef = useRef<Turn[]>([]);

  const started = turns.length > 0;
  const busy = streamingId !== null;

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  // Abort any in-flight request when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const startStream = useCallback((id: number, modelId: string, messages: ChatWireMessage[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;
    setStreamingId(id);

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
    const finish = () => {
      streamingRef.current = false;
      abortRef.current = null;
      setStreamingId((cur) => (cur === id ? null : cur));
    };

    void streamChat({
      model: modelId,
      messages,
      signal: controller.signal,
      onToken: (chunk) => patch((t) => ({ ...t, status: 'streaming', text: t.text + chunk })),
      onDone: () => {
        // A live reply with no content, or an unreachable gateway, falls back to the KB answer.
        patch((t) => ({ ...t, status: 'done', text: t.text || kbMarkdown(t.question) }));
        finish();
      },
      onError: (code, info) => {
        patch((t) =>
          code === 'quota'
            ? { ...t, status: 'error', errorCode: 'quota', resetSeconds: info?.resetSeconds }
            : { ...t, status: 'done', text: t.text || kbMarkdown(t.question) },
        );
        finish();
      },
    });
  }, []);

  const askText = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || streamingRef.current) return;
      const id = nextId.current++;
      const modelId = selectedModelId;

      // Build the wire history from completed turns, then this new question.
      const messages: ChatWireMessage[] = [];
      // Lead with a compact note about who's asking so replies fit them. Sent, never shown.
      const ctx = contextMessage(profile);
      if (ctx) messages.push(ctx);
      for (const t of turnsRef.current) {
        if (t.status === 'done' && t.text) {
          messages.push({ role: 'user', content: t.question });
          messages.push({ role: 'assistant', content: t.text });
        }
      }
      messages.push({ role: 'user', content: q });

      setTurns((prev) => [...prev, { id, question: q, modelId, text: '', status: 'thinking' }]);
      setInput('');
      startStream(id, modelId, messages);
    },
    [selectedModelId, startStream, profile],
  );

  // Re-run one earlier turn: rebuild the wire history from the turns before it (so the model has
  // the same context it did the first time), reset that turn to a fresh "Thinking…" state, and
  // stream a new answer in place. Its original question and model are kept.
  const regenerate = useCallback(
    (id: number) => {
      if (streamingRef.current) return;
      const target = turnsRef.current.find((t) => t.id === id);
      if (!target) return;

      const messages: ChatWireMessage[] = [];
      const ctx = contextMessage(profile);
      if (ctx) messages.push(ctx);
      for (const t of turnsRef.current) {
        if (t.id === id) break;
        if (t.status === 'done' && t.text) {
          messages.push({ role: 'user', content: t.question });
          messages.push({ role: 'assistant', content: t.text });
        }
      }
      messages.push({ role: 'user', content: target.question });

      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, text: '', status: 'thinking', errorCode: undefined, resetSeconds: undefined }
            : t,
        ),
      );
      startStream(id, target.modelId, messages);
    },
    [profile, startStream],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    const id = streamingId;
    setStreamingId(null);
    if (id != null) {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'done' } : t)));
    }
  }, [streamingId]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setStreamingId(null);
    setTurns([]);
    setInput('');
    setView('chat');
    setSidebarOpen(false);
  }, []);

  const selectView = useCallback((next: View) => {
    setView(next);
    setSidebarOpen(false);
  }, []);

  const pickModel = useCallback((id: string) => {
    setSelectedModelId(id);
    try {
      localStorage.setItem(MODEL_KEY, id);
    } catch {
      // ignore
    }
    detailsRef.current?.removeAttribute('open');
  }, []);

  // Auto-grow the textarea up to a cap, then let it scroll.
  const grow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    grow();
  }, [input, grow, view]);

  useEffect(() => {
    const raf = requestAnimationFrame(grow);
    window.addEventListener('resize', grow);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', grow);
    };
  }, [grow]);

  // Keep the newest content in view as it streams.
  useEffect(() => {
    if (view !== 'chat') return;
    if (turns.length > 0) {
      endRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'end' });
    }
  }, [turns, view, reduced]);

  // Keep the caret in the box after each send (not on every streamed token).
  useEffect(() => {
    if (view === 'chat') taRef.current?.focus();
  }, [turns.length, view]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) askText(input);
    }
  };

  // One composer, placed by whichever chat state is live — they never coexist, so the shared
  // ref always attaches to the rendered textarea.
  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) askText(input);
      }}
      className="rounded-3xl border border-[#e4e1d8] bg-white shadow-[0_1px_2px_rgba(20,20,19,0.04)] transition-[border-color,box-shadow] duration-150 focus-within:border-[#cbc6ba] focus-within:shadow-[0_0_0_4px_rgba(207,85,53,0.10)]"
    >
      <label htmlFor="chat-input" className="sr-only">
        Message Sylor
      </label>
      <textarea
        id="chat-input"
        ref={taRef}
        rows={1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={started ? 'Reply to Sylor…' : 'How can I help you today?'}
        className="composer-input block max-h-[200px] w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15px] leading-relaxed text-[#141413] outline-none placeholder:text-[#9c988e]"
      />
      <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
        <div className="flex items-center gap-1">
          <button type="button" className={ICON_BTN} title="Attach" aria-label="Attach">
            <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Tools"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[#544f46] transition-colors duration-150 hover:bg-[#f0eee6] hover:text-[#141413]"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Tools
          </button>
        </div>
        <div className="flex items-center gap-1">
          <details ref={detailsRef} className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[#544f46] transition-colors duration-150 hover:bg-[#f0eee6] hover:text-[#141413] [&::-webkit-details-marker]:hidden">
              <SylorStar size={16} />
              {modelName(selectedModelId)}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </summary>
            <div className="absolute right-0 bottom-full z-10 mb-2 w-72 rounded-xl border border-[#e4e1d8] bg-white p-1.5 shadow-[0_8px_28px_rgba(20,20,19,0.12)]">
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-[#9c988e]">
                Model
              </p>
              {ORACULUM_MODELS.map((m) => {
                const active = m.id === selectedModelId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => pickModel(m.id)}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[#f0eee6]"
                  >
                    <Check
                      className={
                        'mt-0.5 h-4 w-4 shrink-0 ' + (active ? 'text-[#cf5535]' : 'text-transparent')
                      }
                      aria-hidden="true"
                    />
                    <span>
                      <span className="block text-[13px] text-[#141413]">{m.name}</span>
                      <span className="block text-[12px] text-[#6b675e]">{m.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </details>
          <button type="button" className={ICON_BTN} title="Voice" aria-label="Voice input">
            <Mic className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          {busy ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop"
              title="Stop"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#141413] text-white transition-colors duration-150 hover:bg-[#000] active:translate-y-px"
            >
              <Square className="h-[15px] w-[15px]" fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#cf5535] text-white transition-colors duration-150 hover:bg-[#b8482c] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#e0c4ba]"
            >
              <ArrowUp className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  );

  const disclaimer = (
    <p className="mt-2 text-center text-[11px] text-[#9c988e]">
      Sylor can make mistakes. Double-check important info.
    </p>
  );

  const navRow = (active: boolean) =>
    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] transition-colors duration-150 ' +
    (active ? 'bg-[#e7e3d9] text-[#141413]' : 'text-[#544f46] hover:bg-[#ece9e0] hover:text-[#141413]');

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[#faf9f5] text-[#141413]">
      <a className="skip-link" href="#chat-input">
        Skip to the message box
      </a>

      {/* Dim the app behind the sidebar on mobile while it's open. */}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-[#141413]/20 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      {/* Sidebar: fixed slide-in on mobile, a static column from md up. */}
      <aside
        className={
          'fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-[#e4e1d8] bg-[#f2efe7] transition-transform duration-200 md:static md:z-auto md:translate-x-0 ' +
          (sidebarOpen ? 'translate-x-0' : '-translate-x-full')
        }
      >
        <div className="flex items-center gap-2 px-3 py-3">
          <a
            href="/"
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 no-underline transition-colors duration-150 hover:bg-[#ece9e0]"
          >
            <SylorStar size={24} />
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-[#141413]">
              Sylor
            </span>
          </a>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className={ICON_BTN + ' ml-auto md:hidden'}
            aria-label="Close menu"
          >
            <PanelLeft className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>

        <div className="px-3">
          <button
            type="button"
            onClick={newChat}
            className="flex w-full items-center gap-3 rounded-lg border border-[#e4e1d8] bg-white px-3 py-2 text-left text-[14px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba]"
          >
            <SquarePen className="h-4 w-4 text-[#cf5535]" aria-hidden="true" />
            New chat
          </button>
        </div>

        <nav className="mt-2 space-y-0.5 px-3">
          {NAV.map((item) => {
            const ItemIcon = item.icon;
            return (
              <button
                key={item.view}
                type="button"
                onClick={() => selectView(item.view)}
                className={navRow(view === item.view)}
              >
                <ItemIcon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Recents: the live conversation, so there's a way back after visiting a section. */}
        {started ? (
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3">
            <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-[#9c988e]">
              Recents
            </p>
            <button
              type="button"
              onClick={() => selectView('chat')}
              className={navRow(view === 'chat')}
            >
              <MessageSquare className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              <span className="truncate">{turns[0].question}</span>
            </button>
          </div>
        ) : (
          <div className="min-h-0 flex-1" />
        )}

        {/* Account chip. The initial and name read from the same source as the greeting. */}
        <div className="border-t border-[#e4e1d8] p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
            {profile?.photoURL ? (
              <img
                src={profile.photoURL}
                alt=""
                referrerPolicy="no-referrer"
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#cf5535] text-[13px] font-semibold text-white">
                {name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-[#141413]">{name}</p>
              <p className="truncate text-[12px] text-[#6b675e]">{profile?.email || 'Free plan'}</p>
            </div>
            {onSignOut ? (
              <button
                type="button"
                onClick={onSignOut}
                className={ICON_BTN}
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar — the sidebar is hidden by default below md. */}
        <div className="flex items-center gap-1 border-b border-[#e4e1d8] px-2 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className={ICON_BTN}
            aria-label="Open menu"
          >
            <PanelLeft className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <a href="/" className="text-[15px] font-semibold text-[#141413] no-underline">
            Sylor
          </a>
          <button
            type="button"
            onClick={newChat}
            className={ICON_BTN + ' ml-auto'}
            aria-label="New chat"
          >
            <SquarePen className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>

        <main className="flex min-h-0 flex-1 flex-col">
          {view !== 'chat' ? (
            <SectionView view={view} />
          ) : !started ? (
            /* New chat: the greeting over a centered input. */
            <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
              <div className="chat-in w-full max-w-2xl">
                <div className="mb-7 flex items-center justify-center gap-3">
                  <SylorStar className="h-7 w-7 shrink-0" />
                  <h1 className="font-display text-[28px] font-normal leading-tight text-[#141413] sm:text-[36px]">
                    {greeting}, {name}
                  </h1>
                </div>
                {composer}
                {disclaimer}
              </div>
            </div>
          ) : (
            /* Started: a scrolling transcript with the input pinned below. */
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
                  <div role="log" aria-label="Conversation with Sylor" className="space-y-6">
                    {turns.map((t) => (
                      <div key={t.id}>
                        <div className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl bg-[#f0eee6] px-4 py-2.5 text-[15px] leading-relaxed text-[#141413]">
                            {t.question}
                          </div>
                        </div>
                        <AgentReply
                          turn={t}
                          streaming={streamingId === t.id}
                          onRegenerate={regenerate}
                        />
                      </div>
                    ))}
                  </div>
                  {/* A faint caveat under the newest reply — Claude's per-response note. */}
                  <p className="pl-[38px] text-[12px] leading-relaxed text-[#141413]/40">
                    Sylor can make mistakes. Double-check important info.
                  </p>
                  <div ref={endRef} />
                </div>
              </div>

              <div className="shrink-0 bg-[#faf9f5]">
                <div className="mx-auto w-full max-w-3xl px-4 pb-3">{composer}</div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
