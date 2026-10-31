import { useEffect, useState, type ReactNode } from 'react'
import { runSpeedTest, speedVerdict } from '@renderer/lib/speedTest'
import type { BrowserTarget, OutputStyle, Theme } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { ConnectorsPane } from '@renderer/components/ConnectorsPane'
import { AssistantPane } from '@renderer/components/AssistantPane'
import { SkillsPane } from '@renderer/components/SkillsPane'
import { PluginsPane } from '@renderer/components/PluginsPane'
import { ScheduledTasksPane } from '@renderer/components/ScheduledTasksPane'
import { CredentialsPane } from '@renderer/components/CredentialsPane'

/** The Settings window's left-rail categories. */
type SettingsCategory =
  | 'assistant'
  | 'appearance'
  | 'model'
  | 'tools'
  | 'calls'
  | 'connectors'
  | 'skills'
  | 'plugins'
  | 'scheduled'
  | 'credentials'

/** Title + one-line subtitle shown in each category pane's header. */
const CATEGORY_META: Record<SettingsCategory, { label: string; subtitle: string }> = {
  assistant: {
    label: 'Assistant',
    subtitle: 'A personal assistant that can use this computer — policy-gated, Windows first.'
  },
  appearance: { label: 'Appearance', subtitle: 'Theme and visual style.' },
  model: { label: 'Model', subtitle: 'The model Myto talks to, from your Myto account.' },
  tools: { label: 'Tools', subtitle: 'What Myto can do beyond chatting — search the web, run code.' },
  calls: {
    label: 'Calls',
    subtitle: 'Myto Remote — call this PC from the Myto phone app and talk to your agent.'
  },
  connectors: {
    label: 'Connectors',
    subtitle: 'MCP servers that give Myto extra tools — files, APIs, and more.'
  },
  skills: {
    label: 'Skills',
    subtitle: 'Reusable instruction packs Myto pulls in when a task matches.'
  },
  plugins: {
    label: 'Plugins',
    subtitle: 'Bundles that install skills and connectors together in one step.'
  },
  scheduled: {
    label: 'Scheduled',
    subtitle: 'Prompts Myto runs on a schedule, each in its own fresh session.'
  },
  credentials: {
    label: 'Credentials',
    subtitle: 'Save a token once; Myto uses it for matching terminal tasks — values stay hidden.'
  }
}

/** Small monochrome glyph for each category, tinted by the nav's active state. */
function CategoryIcon({ id }: { id: SettingsCategory }): ReactNode {
  switch (id) {
    case 'assistant':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="6" r="3.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.5 14c.8-2.6 2.9-4 5.5-4s4.7 1.4 5.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'appearance':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" />
        </svg>
      )
    case 'model':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'tools':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M10.8 2.6a2.8 2.8 0 0 0-3.6 3.6l-4.4 4.4a1.1 1.1 0 1 0 1.6 1.6l4.4-4.4a2.8 2.8 0 0 0 3.6-3.6l-1.7 1.7-1.5-.4-.4-1.5 1.7-1.7z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'connectors':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6 10l4-4M5.2 7.2 3.6 8.8a2 2 0 1 0 2.8 2.8l1.6-1.6M10.8 8.8l1.6-1.6a2 2 0 1 0-2.8-2.8L8 6"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'calls':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.2 2.6 5 2.2c.5-.1 1 .1 1.2.6l.9 2.1c.2.4.1.9-.3 1.2l-1.1 1c.7 1.6 2 2.9 3.6 3.6l1-1.1c.3-.4.8-.5 1.2-.3l2.1.9c.5.2.7.7.6 1.2l-.4 1.8c-.1.5-.6.9-1.1.9A11.3 11.3 0 0 1 2.3 3.7c0-.5.4-1 .9-1.1z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'skills':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'plugins':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11.25 9v4.5M9 11.25h4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'scheduled':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'credentials':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="5.25" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M7.6 8.1 13 13.5M11 11.6l1.4-1.4M9.4 10l1.3-1.3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
  }
}

const CATEGORY_ORDER: SettingsCategory[] = [
  'assistant',
  'model',
  'tools',
  'calls',
  'connectors',
  'skills',
  'plugins',
  'scheduled',
  'credentials',
  'appearance'
]

// ─────────────────────────────────────────────────────────────────────────────
// Reusable controls
// ─────────────────────────────────────────────────────────────────────────────

/** A settings row: title (+ optional description) on the left, a control on the right. */
function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text">{title}</div>
        {description && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** A segmented control for a small enum (theme, on/off…). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-lg border border-border bg-bg p-0.5">
      {options.map((opt) => {
        const active = opt.id === value
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={
              'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ' +
              (active ? 'bg-primary text-bg shadow-sm' : 'text-muted hover:text-text')
            }
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Appearance pane (store-backed; applies immediately)
// ─────────────────────────────────────────────────────────────────────────────

const THEME_OPTIONS: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

/** Appearance pane: color theme. */
function AppearancePane() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <div className="divide-y divide-border">
      <SettingRow
        title="Theme"
        description="Light is a warm paper palette; dark is a low-glare palette. Applies instantly across the app."
      >
        <Segmented
          ariaLabel="Theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={(v) => void setTheme(v)}
        />
      </SettingRow>
    </div>
  )
}

const ON_OFF = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' }
] as const

/** The assistant's writing-voice presets (#13); `default` adds no directive. */
const OUTPUT_STYLE_OPTIONS: ReadonlyArray<{ id: OutputStyle; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'concise', label: 'Concise' },
  { id: 'explanatory', label: 'Explanatory' },
  { id: 'learning', label: 'Learning' }
]

/** Cowork's browser target (Track 2): off, an in-app sandboxed window, or the user's own Chrome. */
const BROWSER_TARGET_OPTIONS: ReadonlyArray<{ id: BrowserTarget; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'in-app', label: 'In-app' },
  { id: 'system-chrome', label: 'System Chrome' }
]

/** Tools pane: the master tool-use switch and the gated code-execution opt-in. */
function ToolsPane() {
  const tools = useAppStore((s) => s.settings.tools)
  const setTools = useAppStore((s) => s.setTools)
  const outputStyle = useAppStore((s) => s.settings.outputStyle)
  const setOutputStyle = useAppStore((s) => s.setOutputStyle)
  const nativeTools = useAppStore((s) => s.settings.nativeTools)
  const setNativeTools = useAppStore((s) => s.setNativeTools)
  const terminalConsent = useAppStore((s) => s.settings.cowork.terminalConsent)
  const setTerminalConsent = useAppStore((s) => s.setCoworkTerminalConsent)
  const browserTarget = useAppStore((s) => s.settings.cowork.browserTarget)
  const setBrowserTarget = useAppStore((s) => s.setCoworkBrowserTarget)
  const keepAliveInTray = useAppStore((s) => s.settings.background.keepAliveInTray)
  const setBackgroundKeepAlive = useAppStore((s) => s.setBackgroundKeepAlive)
  return (
    <div className="divide-y divide-border">
      <SettingRow
        title="Tool use"
        description="Let Myto search the web, fetch pages, and look things up on Wikipedia while it answers. Results appear as cards in the chat."
      >
        <Segmented
          ariaLabel="Tool use"
          value={tools.enabled ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setTools({ enabled: v === 'on' })}
        />
      </SettingRow>
      <SettingRow
        title="Run code on this machine"
        description="Allow Myto to execute python, JavaScript, or bash snippets locally and read the output. This runs code with your account's privileges — only enable it if you trust what you ask for. Off by default; requires Tool use to be on."
      >
        <Segmented
          ariaLabel="Run code on this machine"
          value={tools.codeExecution ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setTools({ codeExecution: v === 'on' })}
        />
      </SettingRow>
      <SettingRow
        title="Response style"
        description="How Myto writes back to you. Concise keeps it short; Explanatory narrates the “why” as it works; Learning leaves clearly-marked spots for you to fill in. Applies across Chat, Cowork and Build."
      >
        <Segmented
          ariaLabel="Response style"
          value={outputStyle}
          options={OUTPUT_STYLE_OPTIONS}
          onChange={(v) => void setOutputStyle(v)}
        />
      </SettingRow>
      <SettingRow
        title="Native function-calling"
        description="Use the provider's own tool-calling API instead of Myto's text protocol, when the endpoint supports it (OpenAI- or Anthropic-shaped gateways). On by default — faster, and far less truncation-prone on agentic runs; falls back to the text protocol automatically when unsupported."
      >
        <Segmented
          ariaLabel="Native function-calling"
          value={nativeTools ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setNativeTools(v === 'on')}
        />
      </SettingRow>
      <SettingRow
        title="Interactive shell"
        description="Enable the Shell tab in Build's Terminal pane — a real shell you type into, scoped to the working folder. Commands run directly on your machine with no per-command approval, so only enable it if you trust that access. Off by default."
      >
        <Segmented
          ariaLabel="Interactive shell"
          value={terminalConsent ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setTerminalConsent(v === 'on')}
        />
      </SettingRow>
      <SettingRow
        title="Browser"
        description="Let Myto drive a web browser — read pages, fill forms, click through sites — working from a text outline, no vision needed. Works in both Cowork and Build. In-app is a sandboxed window with no logins. System Chrome uses your own Chrome with your real logins: powerful, but Myto acts as you, so only pick it when you trust the task. Myto always asks before it clicks or types. Off by default."
      >
        <Segmented
          ariaLabel="Browser"
          value={browserTarget ?? 'off'}
          options={BROWSER_TARGET_OPTIONS}
          onChange={(v) => void setBrowserTarget(v)}
        />
      </SettingRow>
      <SettingRow
        title="Setup Myto Browser"
        description="Open a browser window and sign in to Gmail, WhatsApp, Facebook, Telegram, and anything else by hand. Myto reuses these logins when it browses for you — your passwords never pass through the model."
      >
        <button
          type="button"
          onClick={() => void window.myto.cowork.openBrowserSetup()}
          className="rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg shadow-sm transition-colors hover:opacity-90"
        >
          Open browser
        </button>
      </SettingRow>
      <SettingRow
        title="Run in background"
        description="Keep Myto running in the system tray after you close the window, so scheduled tasks and any task already in progress keep going. A tray icon (Show / Quit) appears while this is on; Quit exits fully. This does not relaunch Myto after you fully quit or restart your computer. Off by default."
      >
        <Segmented
          ariaLabel="Run in background"
          value={keepAliveInTray ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setBackgroundKeepAlive(v === 'on')}
        />
      </SettingRow>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Calls pane (Myto Remote)
// ─────────────────────────────────────────────────────────────────────────────

const CALL_PERMISSION_OPTIONS: ReadonlyArray<{ id: 'ask' | 'autoReadOnly' | 'autoDev'; label: string }> = [
  { id: 'ask', label: 'Ask always' },
  { id: 'autoReadOnly', label: 'Auto read-only' },
  { id: 'autoDev', label: 'Auto dev' }
]

/** Scan-to-pair: the QR opens Myto on the phone and instantly calls this PC. */
function PairPhoneCard({ pairLink, qrDataUrl }: { pairLink: string; qrDataUrl: string }): ReactNode {
  if (!pairLink) {
    return (
      <SettingRow
        title="Pair your phone"
        description="Sign in to Myto first — the pairing QR appears once the desktop knows your account."
      >
        <span className="text-[12px] text-muted">Awaiting sign-in…</span>
      </SettingRow>
    )
  }
  return (
    <SettingRow
      title="Pair your phone"
      description="Scan this with your phone's camera (first time only): Myto opens and calls this PC instantly. After that, calls start normally from the phone's Call tab."
    >
      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="Scan with your phone to pair and call this PC"
          width={132}
          height={132}
          className="rounded-lg border border-border bg-white p-1.5"
        />
      ) : (
        <span className="text-[12px] text-muted">Generating…</span>
      )}
    </SettingRow>
  )
}

/**
 * Myto Remote: the phone calls this PC. Everything sensitive stays gated — the
 * permission tier below controls what the phone may run without confirmation,
 * and destructive/elevated commands ALWAYS ask regardless of tier.
 */
function CallsPane() {
  const call = useAppStore((s) => s.settings.call)
  const setCallSettings = useAppStore((s) => s.setCallSettings)
  const turnText = call.turn.urls.join(', ')
  const [pairLink, setPairLink] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')

  // The pairing QR: the phone's camera opens Myto via the myto://call deep
  // link and instantly places the first call to this PC.
  useEffect(() => {
    void window.myto.call.getState().then(async (snapshot) => {
      setPairLink(snapshot.pairLink)
      if (snapshot.pairLink) {
        try {
          const QR = (await import('qrcode')).default
          setQrDataUrl(await QR.toDataURL(snapshot.pairLink, { width: 180, margin: 1 }))
        } catch {
          setQrDataUrl('')
        }
      }
    })
  }, [])

  return (
    <div className="divide-y divide-border">
      <PairPhoneCard pairLink={pairLink} qrDataUrl={qrDataUrl} />
      <SettingRow
        title="Call work folder"
        description="The folder Myto works in during calls — voice-driven files and tasks land here, separate from your main workspace. When you say “ei folder” on a call, this is where Myto goes. Auto-created on the first call; pick a folder to change it."
      >
        <div className="flex flex-col items-end gap-2">
          <span className="max-w-72 truncate font-mono text-[11.5px] text-muted" title={call.callWorkspaceDir}>
            {call.callWorkspaceDir || 'Auto: Documents\\Myto Call Work'}
          </span>
          <button
            type="button"
            onClick={async () => {
              const picked = await window.myto.cowork.pickWorkspace()
              if (picked) void setCallSettings({ callWorkspaceDir: picked })
            }}
            className="rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-bg shadow-sm transition-colors hover:opacity-90"
          >
            Choose folder
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="Voice calls"
        description="Publish presence and answer calls from the Myto phone app (signed into the same account). Calls are end-to-end WebRTC audio; signaling goes through your own Firestore, owner-only."
      >
        <Segmented
          ariaLabel="Voice calls"
          value={call.enabled ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setCallSettings({ enabled: v === 'on' })}
        />
      </SettingRow>
      <SettingRow
        title="Answer automatically"
        description="Myto answers after the ring window (~5–7s, real ringing — the connection starts only at accept). Turn off to keep the desktop silent; the phone then always lands on “no answer”."
      >
        <Segmented
          ariaLabel="Answer automatically"
          value={call.autoAnswer ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setCallSettings({ autoAnswer: v === 'on' })}
        />
      </SettingRow>
      <SettingRow
        title="Command permission tier"
        description="What the phone may run on this PC without asking. Ask always confirms every dev command; Auto read-only only confirms writes/exec; Auto dev also runs builds/tests on its own. Destructive and elevated commands ALWAYS ask, in every tier."
      >
        <Segmented
          ariaLabel="Command permission tier"
          value={call.permissionMode}
          options={CALL_PERMISSION_OPTIONS}
          onChange={(v) => void setCallSettings({ permissionMode: v })}
        />      </SettingRow>
      <SettingRow
        title="Call back when a task finishes"
        description="When a task Myto started from a call completes (or blocks), it calls you back and speaks the summary. Missed callbacks retry, then fall back to a notification."
      >
        <Segmented
          ariaLabel="Call back when a task finishes"
          value={call.callbacks.enabled ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => void setCallSettings({ callbacks: { ...call.callbacks, enabled: v === 'on' } })}
        />
      </SettingRow>
      <SettingRow
        title="Desktop speech recognition (fallback)"
        description="If the phone's own voice input fails during calls, the desktop can transcribe the phone's mic audio instead. Paste any OpenAI-compatible /audio/transcriptions endpoint — a FREE Groq key (console.groq.com) with whisper-large-v3-turbo works great. Empty = off (phone recognizer only)."
      >
        <div className="flex w-72 flex-col gap-2">
          <input
            type="text"
            value={call.stt.endpoint}
            onChange={(e) => void setCallSettings({ stt: { ...call.stt, endpoint: e.target.value } })}
            placeholder="https://api.groq.com/openai/v1/audio/transcriptions"
            className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary"
          />
          <div className="flex gap-2">
            <input
              type="password"
              value={call.stt.apiKey}
              onChange={(e) => void setCallSettings({ stt: { ...call.stt, apiKey: e.target.value } })}
              placeholder="API key"
              className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary"
            />
            <input
              type="text"
              value={call.stt.model}
              onChange={(e) => void setCallSettings({ stt: { ...call.stt, model: e.target.value } })}
              placeholder="model"
              className="w-32 rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary"
            />
          </div>
        </div>
      </SettingRow>
      <SettingRow
        title="TURN relay"
        description="Fallback relay for strict NATs (carrier networks, some offices). Defaults to the free public OpenRelay; replace with your own server for production use. Comma-separated URLs."
      >
        <div className="flex w-72 flex-col gap-2">
          <input
            type="text"
            value={turnText}
            onChange={(e) =>
              void setCallSettings({
                turn: {
                  ...call.turn,
                  urls: e.target.value
                    .split(',')
                    .map((u) => u.trim())
                    .filter(Boolean)
                }
              })
            }
            placeholder="turn:host:3478, turn:host:443?transport=tcp"
            className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={call.turn.username}
              onChange={(e) => void setCallSettings({ turn: { ...call.turn, username: e.target.value } })}
              placeholder="username"
              className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary"
            />
            <input
              type="password"
              value={call.turn.credential}
              onChange={(e) => void setCallSettings({ turn: { ...call.turn, credential: e.target.value } })}
              placeholder="credential"
              className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary"
            />
          </div>
        </div>
      </SettingRow>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Model pane (read-only mirror of the account's Firestore config)
// ─────────────────────────────────────────────────────────────────────────────

/** Mask an API key so the panel can show it's set without revealing it. */
function maskKey(key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (k.length <= 8) return '••••••••'
  return `${k.slice(0, 3)}••••••••${k.slice(-4)}`
}

/**
 * The model pane is now a read-only summary. The base URL / key / auth scheme and
 * the model list all come from the signed-in account's Firestore config (the same
 * one the website's Authentication page edits), mirrored into the local settings
 * by useAppStore.applyByokConfig. There's nothing to edit here — models are managed
 * on the website.
 */
function ModelPane() {
  const gateway = useAppStore((s) => s.settings.gateway)
  const models = useAppStore((s) => s.models)
  const modelId = useAppStore((s) => s.settings.modelId)
  const configured = gateway.baseUrl.trim().length > 0 && models.length > 0

  return (
    <div className="space-y-5">
      {!configured && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-[12px] leading-relaxed text-amber-500">
          No model is configured for your account yet. Add your endpoint and models on the Myto
          website → Authentication page, then they'll appear here automatically.
        </div>
      )}

      <section className="space-y-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Connection</span>
        <dl className="divide-y divide-border rounded-lg border border-border bg-bg">
          <div className="flex items-center justify-between gap-6 px-3.5 py-2.5">
            <dt className="text-[12px] text-muted">Base URL</dt>
            <dd className="min-w-0 truncate text-[13px] text-text">
              {gateway.baseUrl.trim() || <span className="text-muted">Not set</span>}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-6 px-3.5 py-2.5">
            <dt className="text-[12px] text-muted">Auth</dt>
            <dd className="text-[13px] text-text">{gateway.authSchema}</dd>
          </div>
          <div className="flex items-center justify-between gap-6 px-3.5 py-2.5">
            <dt className="text-[12px] text-muted">API key</dt>
            <dd className="font-mono text-[13px] text-text">
              {maskKey(gateway.apiKey) || <span className="font-sans text-muted">None</span>}
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
          Models ({models.length})
        </span>
        {models.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-bg">
            {models.map((m) => (
              <ModelSpeedRow key={m.id} modelId={m.id} name={m.name} active={m.id === modelId} />
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted">No models yet.</p>
        )}
        <p className="text-[11.5px] leading-relaxed text-muted">
          Speed = measured streaming rate of a tiny probe reply. Below ~5 tok/s every
          response crawls no matter how fast the app is — pick a faster model or a
          quicker provider endpoint.
        </p>
      </section>

      <p className="text-[12px] leading-relaxed text-muted">
        Manage your models on the Myto website → Authentication page. Changes sync here
        automatically the next time this account's config updates.
      </p>

      <div className="rounded-xl border border-border bg-bg p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
            Media routing
          </span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-muted">
            automatic
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          Requests route by the model&rsquo;s kind, detected from its id: an image or video
          model (flux, dall-e, veo, sora…) generates media in the chat; everything else
          answers as text. Renaming the active model to an image/video id flips the routing
          instantly — no endpoint reconfiguration needed.
        </p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The Settings window
// ─────────────────────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  // The model selector deep-links here via openSettings('model'). The panel is
  // mounted fresh on each open, so seeding the initial category from the
  // requested tab is all it takes to land there.
  const settingsTab = useAppStore((s) => s.settingsTab)

  const [category, setCategory] = useState<SettingsCategory>(settingsTab ?? 'model')

  const meta = CATEGORY_META[category]

  return (
    <div className="absolute inset-0 z-40 flex bg-bg">
      <div className="flex h-full w-full overflow-hidden bg-surface">
        {/* Category rail */}
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-bg p-2">
          <div className="px-2.5 pb-2 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Settings
          </div>
          {CATEGORY_ORDER.map((id) => {
            const active = id === category
            return (
              <button
                key={id}
                type="button"
                onClick={() => setCategory(id)}
                className={
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ' +
                  (active
                    ? 'bg-surface-2 font-medium text-text'
                    : 'text-muted hover:bg-surface-2/60 hover:text-text')
                }
              >
                <span className={active ? 'text-primary' : 'text-muted'}>
                  <CategoryIcon id={id} />
                </span>
                {CATEGORY_META[id].label}
              </button>
            )
          })}
        </nav>

        {/* Content column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-border px-6 py-4">
            <div>
              <h2 className="text-[15px] font-semibold text-text">{meta.label}</h2>
              <p className="mt-0.5 text-[12px] text-muted">{meta.subtitle}</p>
            </div>
            <button
              type="button"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
              className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Scrollable pane. Cap the content to a comfortable reading width and
              center it so forms don't stretch edge-to-edge on wide windows. */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-3xl">
              {category === 'assistant' && <AssistantPane />}
              {category === 'appearance' && <AppearancePane />}
              {category === 'tools' && <ToolsPane />}
              {category === 'calls' && <CallsPane />}
              {category === 'model' && <ModelPane />}
              {category === 'connectors' && <ConnectorsPane />}
              {category === 'skills' && <SkillsPane />}
              {category === 'plugins' && <PluginsPane />}
              {category === 'scheduled' && <ScheduledTasksPane />}
              {category === 'credentials' && <CredentialsPane />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


/**
 * One model row with its measured streaming speed and a test button. The speed
 * comes from the connection doctor (lib/speedTest.ts) — a tiny probe completion
 * timed end to end. This is the honest "why are replies slow" answer: the app is
 * as fast as the pipe, and the badge shows the pipe.
 */
function ModelSpeedRow({ modelId, name, active }: { modelId: string; name: string; active: boolean }) {
  const result = useAppStore((s) => s.speedResults[modelId])
  const [running, setRunning] = useState(false)

  const verdict = result ? speedVerdict(result.tokensPerSec) : null
  const verdictColor =
    verdict === 'fast'
      ? 'text-green-500'
      : verdict === 'ok'
        ? 'text-amber-500'
        : 'text-red-500'
  const verdictLabel =
    verdict === 'fast' ? 'Fast' : verdict === 'ok' ? 'Okay' : 'Slow'

  return (
    <li className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-[13px]">
      <span className={'min-w-0 truncate ' + (active ? 'text-primary' : 'text-text')}>
        {name}
        <span className="ml-2 shrink-0 font-mono text-[10.5px] text-muted">{modelId}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {running ? (
          <span className="font-mono text-[11px] text-muted">testing…</span>
        ) : result ? (
          <span className={'text-right font-mono text-[11px] ' + verdictColor} title={`first token: ${result.ttftMs}ms`}>
            {verdictLabel} · {result.tokensPerSec} tok/s
          </span>
        ) : null}
        <button
          type="button"
          disabled={running}
          onClick={async () => {
            setRunning(true)
            try {
              await runSpeedTest(modelId)
            } finally {
              setRunning(false)
            }
          }}
          className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-text disabled:opacity-50"
        >
          {running ? '…' : 'Test'}
        </button>
      </span>
    </li>
  )
}
