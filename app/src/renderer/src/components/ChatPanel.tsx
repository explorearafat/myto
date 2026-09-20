import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChatStore, type ChatMessageUI, type OutgoingAttachment } from '../store/useChatStore'
import { useSessionStore } from '../store/useSessionStore'
import { useAppStore } from '../store/useAppStore'
import { useAuthUser } from '../lib/useAuthUser'
import { Markdown } from './Markdown'
import { FileCard } from './FileCard'
import { ToolCard } from './ToolCard'
import { parseFileBlocks } from '../lib/fileBlocks'
import { ModelSelector } from './ModelSelector'
import { PromptBuilder } from './PromptBuilder'
import { SylorStar } from './SylorStar'
import { SylorLogo } from './SylorLogo'
import type { Attachment } from '@shared/types'

/** Human-readable byte size for an attachment chip (e.g. "12.4 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Whether a file's bytes can usefully be inlined as text for the model. */
function isTextLike(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true
  if (/^application\/(json|xml|javascript|typescript|x-sh|x-yaml|yaml|toml)$/.test(mime))
    return true
  // Fall back on the extension when the OS reports a vague/empty mime.
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return [
    'txt',
    'md',
    'markdown',
    'json',
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'css',
    'html',
    'htm',
    'yml',
    'yaml',
    'py',
    'sh',
    'bash',
    'xml',
    'csv',
    'toml',
    'ini',
    'cfg',
    'conf',
    'log',
    'env'
  ].includes(ext)
}

/** Read a browser File as base64 (without the `data:<mime>;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** A file staged in the composer, already stored (pending, no message yet). */
interface PendingAttachment {
  attachment: Attachment
  /** Data URL for an image thumbnail (images only). */
  thumbnailUrl?: string
  /** Decoded body for text-like files, inlined into the model history. */
  textContent?: string
}

/** Presentational attachment chip: image thumb or file pill, optional remove ×. */
function AttachmentChip({
  name,
  mime,
  size,
  thumbnailUrl,
  onRemove
}: {
  name: string
  mime: string
  size: number
  thumbnailUrl?: string | null
  onRemove?: () => void
}) {
  const isImage = mime.startsWith('image/')
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
      {isImage && thumbnailUrl ? (
        <img src={thumbnailUrl} alt={name} className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded bg-surface-2 text-muted">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </div>
      )}
      <div className="min-w-0">
        <div className="max-w-[140px] truncate text-[11px] font-medium text-text">{name}</div>
        <div className="text-[10px] text-muted">{formatBytes(size)}</div>
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-surface-2 text-muted transition-colors hover:bg-red-500/20 hover:text-red-400"
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M2 2l6 6M8 2l-6 6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}

/** A persisted-message attachment chip; lazily reads an image's data URL. */
function MessageAttachmentChip({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mime.startsWith('image/')
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    void window.sylor.attachments.read(attachment.id).then((url) => {
      if (!cancelled) setThumbnailUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.id, isImage])
  return (
    <AttachmentChip
      name={attachment.name}
      mime={attachment.mime}
      size={attachment.size}
      thumbnailUrl={thumbnailUrl}
    />
  )
}

/** A single icon action button in the message-actions row. */
function ActionButton({
  label,
  active,
  disabled,
  onClick,
  children
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={
        'grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ' +
        (active ? 'text-primary' : 'text-muted hover:text-text')
      }
    >
      {children}
    </button>
  )
}

/**
 * Local-only actions under a finished assistant reply (Claude/ChatGPT-style):
 * Copy to clipboard, Rewrite (regenerate), like/dislike feedback, and Report.
 * Feedback and Report are markers persisted for reload only — nothing is sent.
 */
function MessageActions({ message }: { message: ChatMessageUI }) {
  const running = useChatStore((s) => s.running)
  const setFeedback = useChatStore((s) => s.setFeedback)
  const toggleFlag = useChatStore((s) => s.toggleFlag)
  const regenerate = useChatStore((s) => s.regenerate)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3 8.5l3 3 7-7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="5"
              y="5"
              width="8.5"
              height="8.5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        )}
      </ActionButton>
      <ActionButton label="Rewrite" disabled={running} onClick={() => regenerate(message.id)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ActionButton>
      <ActionButton
        label="Good response"
        active={message.feedback === 'like'}
        onClick={() => setFeedback(message.id, 'like')}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill={message.feedback === 'like' ? 'currentColor' : 'none'}
          aria-hidden="true"
        >
          <path
            d="M5 7v6.5H3.5A1 1 0 0 1 2.5 12.5V8a1 1 0 0 1 1-1H5zm0 0 2.5-5a1.5 1.5 0 0 1 1.5 1.5V6h3.3a1 1 0 0 1 1 1.2l-1 4.5a1.2 1.2 0 0 1-1.2 1H5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </ActionButton>
      <ActionButton
        label="Bad response"
        active={message.feedback === 'dislike'}
        onClick={() => setFeedback(message.id, 'dislike')}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill={message.feedback === 'dislike' ? 'currentColor' : 'none'}
          aria-hidden="true"
          style={{ transform: 'rotate(180deg)' }}
        >
          <path
            d="M5 7v6.5H3.5A1 1 0 0 1 2.5 12.5V8a1 1 0 0 1 1-1H5zm0 0 2.5-5a1.5 1.5 0 0 1 1.5 1.5V6h3.3a1 1 0 0 1 1 1.2l-1 4.5a1.2 1.2 0 0 1-1.2 1H5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </ActionButton>
      <ActionButton
        label={message.flagged ? 'Reported' : 'Report'}
        active={message.flagged}
        onClick={() => toggleFlag(message.id)}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 2v12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path
            d="M3.5 2.8h8.2l-1.6 2.7 1.6 2.7H3.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
            fill={message.flagged ? 'currentColor' : 'none'}
          />
        </svg>
      </ActionButton>
    </div>
  )
}

/**
 * User prose clamped to three lines with a Show more/less toggle. Overflow is
 * measured after layout so the toggle only appears when the text is actually
 * taller than the clamp.
 */
function ClampedUserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 2)
  }, [text, expanded])
  return (
    <div>
      <div
        ref={ref}
        className={
          'whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text ' +
          (expanded ? '' : 'line-clamp-3')
        }
      >
        {text}
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-primary/80 transition-colors hover:text-primary"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

interface MessageProps {
  message: ChatMessageUI
  /** Attachments the user sent with this message (chips above the text). */
  attachments: Attachment[]
}

/** A user turn: right-aligned bubble with its attachments. */
function UserMessage({ message, attachments }: MessageProps) {
  const displayContent = message.content.trimEnd()
  if (displayContent.length === 0 && attachments.length === 0) return null
  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {attachments.map((a) => (
            <MessageAttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {displayContent.length > 0 && (
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-surface-2 px-3.5 py-2">
          <ClampedUserText text={displayContent} />
        </div>
      )}
    </div>
  )
}

/**
 * An assistant turn. Claude-Code-style flat turn: the reply renders directly on
 * the surface — no avatar, no name badge. Only the user's turn keeps a bubble, so
 * the two speakers still read distinctly (user = right-aligned pill, Sylor = flat
 * full-width prose on the background). A small `pl-4` gives the prose a little
 * breathing room from the left edge without reintroducing a gutter.
 */
/**
 * Caption for the live status line above a streaming reply. Prefers the model's
 * own `<status>` (streamed out-of-band and stripped from the text — see
 * main/status.ts); when a model emits none, falls back to a generic verb so the
 * line never sits empty — "Thinking" before any prose, "Writing" once it flows.
 */
function statusCaption(message: ChatMessageUI, displayContent: string): string {
  if (message.status) return message.status
  return displayContent.length > 0 ? 'Writing' : 'Thinking'
}

/**
 * The Claude-style live status line: a small shimmering caption shown above a
 * still-streaming reply. Keyed on the caption so each change remounts the node
 * and replays the fade-in — a soft cross-fade rather than a jarring swap. The
 * parent renders it only while the reply is pending, so it disappears on done.
 */
function StatusLine({ caption }: { caption: string }) {
  return (
    <div className="mb-1.5" aria-live="polite">
      <span
        key={caption}
        className="sylor-thinking sylor-status-in inline-block text-[12px] font-medium"
      >
        {caption}
      </span>
    </div>
  )
}

function AssistantMessage({ message }: { message: ChatMessageUI }) {
  const displayContent = message.content.trimEnd()
  // Split the reply into prose and generated-file blocks so files render as
  // downloadable cards while everything else stays ordinary Markdown. A reply with
  // no file blocks yields a single prose segment — identical to rendering it whole.
  const segments = useMemo(() => parseFileBlocks(displayContent), [displayContent])
  return (
    <div className="min-w-0 pl-4">
      {message.error && (
        <div className="mb-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {message.error}
        </div>
      )}

      {message.pending && <StatusLine caption={statusCaption(message, displayContent)} />}

      {segments.map((seg, i) =>
        seg.kind === 'file' ? (
          <FileCard key={`f${i}`} file={seg} />
        ) : seg.kind === 'tool' ? (
          <ToolCard key={`t${i}`} tool={seg} />
        ) : (
          <Markdown key={`p${i}`} content={seg.text} />
        )
      )}

      {!message.pending && (displayContent.length > 0 || message.error != null) && (
        <MessageActions message={message} />
      )}
    </div>
  )
}

/** Dispatches to the user/assistant layout. */
function Message({ message, attachments }: MessageProps) {
  return message.role === 'user' ? (
    <UserMessage message={message} attachments={attachments} />
  ) : (
    <AssistantMessage message={message} />
  )
}

/** Theme toggle: sun in light, moon in dark. */
function ThemeToggle() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      onClick={() => void setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {theme === 'dark' ? (
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )
}

/**
 * The main surface's top strip: the plan/billing note centered (inert chrome that
 * mirrors the reference app), the Sylor mascot and theme toggle on the right, and
 * — only when the rail is collapsed — a control on the left to reopen it.
 */
function MainTopBar() {
  const railOpen = useAppStore((s) => s.railOpen)
  const toggleRail = useAppStore((s) => s.toggleRail)
  return (
    <div className="relative flex h-11 shrink-0 items-center px-3">
      <div className="flex items-center">
        {!railOpen && (
          <button
            type="button"
            aria-label="Open sidebar"
            title="Open sidebar"
            onClick={toggleRail}
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
              <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <span className="text-[12px] text-muted">
          Free plan ·{' '}
          <button
            type="button"
            title="Upgrade (not available in this build)"
            className="pointer-events-auto font-medium text-primary transition-opacity hover:opacity-80"
          >
            Upgrade
          </button>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <SylorLogo size={22} showBubbles={false} className="opacity-80" title="Sylor" />
        <ThemeToggle />
      </div>
    </div>
  )
}

/** The four real starter leads; "Sylor's choice" picks one of them at random. */
const STARTER_LEADS = [
  'Help me write ',
  'Help me understand ',
  'Help me write code to ',
  'Help me plan '
]

/**
 * The suggestion pills under the landing composer (Write / Learn / Code / Life
 * stuff / Sylor's choice). Each drops a short lead into the composer and focuses
 * it — a gentle on-ramp rather than a canned prompt.
 */
function StarterPills({ onPick }: { onPick: (lead: string) => void }) {
  const items: { label: string; lead: string | null; icon: ReactNode }[] = [
    {
      label: 'Write',
      lead: 'Help me write ',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M11 2l3 3-8 8H3v-3l8-8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )
    },
    {
      label: 'Learn',
      lead: 'Help me understand ',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5L14.5 6 8 9.5 1.5 6 8 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M4.5 7.5v3c0 .8 1.6 1.8 3.5 1.8s3.5-1 3.5-1.8v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    },
    {
      label: 'Code',
      lead: 'Help me write code to ',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 5L3 8l3 3M10 5l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    },
    {
      label: 'Life stuff',
      lead: 'Help me plan ',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6.5h6a2.5 2.5 0 0 1 0 5H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 5.5v7M4.5 3.2c.6.5.6 1.3 0 1.8M6.5 3.2c.6.5.6 1.3 0 1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    },
    {
      label: "Sylor's choice",
      lead: null,
      icon: <SylorStar size={15} />
    }
  ]

  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={() =>
            onPick(it.lead ?? STARTER_LEADS[Math.floor(Math.random() * STARTER_LEADS.length)])
          }
          className="flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-[12.5px] text-text transition-colors hover:border-primary/50 hover:bg-surface-2"
        >
          <span className="grid shrink-0 place-items-center text-muted">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  )
}

/** An inert, reference-matching pill (e.g. the "Medium" reasoning effort). */
function InertPill({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="flex cursor-default items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text/80"
    >
      {label}
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="text-muted">
        <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages)
  const attachments = useChatStore((s) => s.attachments)
  const running = useChatStore((s) => s.running)
  const send = useChatStore((s) => s.send)
  const sessionId = useChatStore((s) => s.sessionId)
  const cancel = useChatStore((s) => s.cancel)
  const composerMode = useChatStore((s) => s.composerMode)
  const promptBlocks = useChatStore((s) => s.promptBlocks)
  const setComposerMode = useChatStore((s) => s.setComposerMode)
  const setPromptBlocks = useChatStore((s) => s.setPromptBlocks)

  // The signed-in account's given name, for the greeting — falling back to the OS
  // account name, then a friendly generic.
  const authUser = useAuthUser()
  const firstName = (authUser?.displayName?.trim() || window.sylor.userName || 'there').split(
    /\s+/
  )[0]

  const [input, setInput] = useState('')
  // Files staged in the composer (already stored on disk as pending rows).
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Group persisted attachments by the user message they were sent with.
  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, Attachment[]>()
    for (const a of attachments) {
      if (a.messageId == null) continue
      const list = map.get(a.messageId)
      if (list) list.push(a)
      else map.set(a.messageId, [a])
    }
    return map
  }, [attachments])

  // Auto-scroll to the newest content as it streams in.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Auto-grow the textarea up to its max height. Reset to one line-height first
  // so the caret sits correctly when the field is empty (a bare `auto` collapses
  // to 0 and leaves the caret half-clipped at the top of the box).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 160)}px`
  }, [input])

  // Store each dropped/selected file as a pending attachment and stage it. Text
  // files also carry their decoded body for inlining into the model history.
  const stageFiles = async (files: File[]): Promise<void> => {
    const sid = useChatStore.getState().sessionId
    if (!sid || files.length === 0) return
    for (const file of files) {
      try {
        const data = await fileToBase64(file)
        const mime = file.type || 'application/octet-stream'
        const attachment = await window.sylor.attachments.add({
          sessionId: sid,
          name: file.name,
          mime,
          data
        })
        const staged: PendingAttachment = { attachment }
        if (mime.startsWith('image/')) {
          staged.thumbnailUrl = `data:${mime};base64,${data}`
        } else if (isTextLike(mime, file.name)) {
          try {
            staged.textContent = await file.text()
          } catch {
            // Unreadable as text: fall back to a metadata-only note.
          }
        }
        setPending((prev) => [...prev, staged])
      } catch (err) {
        console.error('[sylor] failed to stage attachment:', err)
      }
    }
  }

  const removePending = (id: string): void => {
    setPending((prev) => prev.filter((p) => p.attachment.id !== id))
    void window.sylor.attachments.remove(id)
  }

  const onFilesPicked = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files ? Array.from(event.target.files) : []
    void stageFiles(files)
    // Reset so picking the same file again re-fires change.
    event.target.value = ''
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : []
    void stageFiles(files)
  }

  const submit = async (): Promise<void> => {
    const text = input
    if ((text.trim().length === 0 && pending.length === 0) || running) return

    const outgoing: OutgoingAttachment[] = pending.map((p) => ({
      attachment: p.attachment,
      ...(p.textContent != null ? { textContent: p.textContent } : {})
    }))

    // A turn needs a persisted session to save into. On a fresh landing page the
    // chat is an unsaved draft (sessionId == null), so create the row now —
    // lazily, on this first send — before sending and titling it from the prompt.
    if (useChatStore.getState().sessionId == null) {
      await useSessionStore.getState().create()
    }
    setInput('')
    setPending([])
    send(text, outgoing)
    // No-ops once the session has a real title. See useSessionStore.autoName.
    void useSessionStore.getState().autoName(text)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  // Drop a starter lead into the composer and put the caret at its end.
  const prefill = (lead: string): void => {
    setInput(lead)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  const canSend = input.trim().length > 0 || pending.length > 0
  const canAttach = sessionId != null
  const isEmpty = messages.length === 0

  /**
   * The composer card — reused by the landing hero and the pinned bottom bar. A
   * big rounded field with a control row beneath it: attach + Chat/Cowork on the
   * left; model, reasoning effort, mic and send on the right. Cowork, the effort
   * pill and the mic/voice controls are inert chrome that mirrors the reference
   * app; attach, the model picker and send are wired up.
   */
  const renderComposer = (placeholder: string): ReactNode => (
    <div
      onDragOver={(e) => {
        if (!canAttach) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={canAttach ? onDrop : undefined}
    >
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pending.map((p) => (
            <AttachmentChip
              key={p.attachment.id}
              name={p.attachment.name}
              mime={p.attachment.mime}
              size={p.attachment.size}
              thumbnailUrl={p.thumbnailUrl ?? null}
              onRemove={() => removePending(p.attachment.id)}
            />
          ))}
        </div>
      )}

      <div
        className={
          'rounded-[22px] border bg-surface px-3.5 pb-2 pt-3 shadow-sm transition-colors focus-within:border-primary/50 ' +
          (dragging ? 'border-primary' : 'border-border')
        }
      >
        <input ref={fileInputRef} type="file" multiple onChange={onFilesPicked} className="hidden" />
        {composerMode === 'builder' ? (
          <PromptBuilder
            blocks={promptBlocks}
            onChange={setPromptBlocks}
            onCompile={(prompt) => {
              setInput(prompt)
              setComposerMode('text')
              requestAnimationFrame(() => textareaRef.current?.focus())
            }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={dragging ? 'Drop files to attach…' : placeholder}
            className="block max-h-40 min-h-6 w-full resize-none bg-transparent px-1 py-0.5 text-[14px] leading-6 text-text placeholder:text-muted focus:outline-none"
          />
        )}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={composerMode === 'builder' ? 'Back to plain text' : 'Build a structured prompt'}
              title={composerMode === 'builder' ? 'Back to plain text' : 'Prompt DNA — build a structured prompt'}
              onClick={() => setComposerMode(composerMode === 'builder' ? 'text' : 'builder')}
              className={
                'grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors ' +
                (composerMode === 'builder'
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-muted hover:bg-surface-2 hover:text-text')
              }
            >
              <span className="text-[15px] leading-none" aria-hidden="true">
                🧬
              </span>
            </button>

            <button
              type="button"
              aria-label="Attach files"
              title={canAttach ? 'Attach files' : 'Send a message first to attach files'}
              disabled={!canAttach}
              onClick={() => fileInputRef.current?.click()}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>

            {/* Chat / Cowork — Chat is the only mode this build ships; Cowork is inert. */}
            <div className="flex items-center rounded-full border border-border bg-surface p-0.5 text-[12px]">
              <span className="rounded-full bg-surface-2 px-2.5 py-1 font-medium text-text">Chat</span>
              <span
                title="Cowork (not available in this build)"
                className="cursor-default rounded-full px-2.5 py-1 text-muted/70"
              >
                Cowork
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <ModelSelector openUp />
            <InertPill label="Medium" title="Reasoning effort (fixed in this build)" />

            <span
              title="Voice input (not available in this build)"
              className="grid h-8 w-8 cursor-default place-items-center rounded-full text-muted/70"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="6" y="1.5" width="4" height="8.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </span>

            {running ? (
              <button
                type="button"
                onClick={cancel}
                aria-label="Stop"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-text transition-colors hover:bg-border"
              >
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : canSend ? (
              <button
                type="button"
                onClick={() => void submit()}
                aria-label="Send"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-bg transition-opacity hover:opacity-90"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <span
                title="Voice mode (not available in this build)"
                className="grid h-8 w-8 cursor-default place-items-center rounded-full bg-surface-2 text-muted/70"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 8h1.5M5 5v6M8 3v10M11 5.5v5M13.5 8H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col bg-bg">
      <MainTopBar />

      {isEmpty ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 pb-16 pt-8">
            <SylorStar size={40} className="mb-4" />
            <h1 className="mb-7 font-serif text-[28px] font-normal text-text">
              Hey there, {firstName}
            </h1>
            <div className="w-full">
              {renderComposer('How can I help you today?')}
              <StarterPills onPick={prefill} />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-5 px-4 py-5">
              {messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  attachments={attachmentsByMessage.get(message.id) ?? []}
                />
              ))}
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">{renderComposer('Message Sylor…')}</div>
        </>
      )}
    </div>
  )
}
