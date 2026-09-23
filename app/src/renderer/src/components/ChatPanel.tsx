import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChatStore, type ChatMessageUI, type OutgoingAttachment } from '../store/useChatStore'
import { usePreviewStore } from '../store/usePreviewStore'
import { useSessionStore } from '../store/useSessionStore'
import { useAppStore } from '../store/useAppStore'
import { useAuthUser } from '../lib/useAuthUser'
import { Markdown } from './Markdown'
import { FileCard } from './FileCard'
import { ToolCard } from './ToolCard'
import { parseFileBlocks, toolHeadline, type ToolSegment } from '../lib/fileBlocks'
import {
  startDictation,
  ttsSpeak,
  ttsStop,
  ttsSupported,
  webSpeechSupported,
  type SttSession
} from '../lib/voice'
import { ModelSelector } from './ModelSelector'
import { PromptBuilder } from './PromptBuilder'
import { MytoMark } from './MytoMark'
import type {
  ApprovalRequest,
  CoworkPermissionMode,
  Attachment,
  QuestionRequest,
  ReasoningEffort,
  TodoItem
} from '@shared/types'

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
    void window.myto.attachments.read(attachment.id).then((url) => {
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
 * the two speakers still read distinctly (user = right-aligned pill, Myto = flat
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
        className="myto-thinking myto-status-in inline-block text-[12px] font-medium"
      >
        {caption}
      </span>
    </div>
  )
}

/**
 * The mid-reply permission prompt (Cowork). Shown when the model wants to run a
 * side-effecting tool and the permission tier is set to ask. Answering resumes the
 * blocked main-process loop (allow / allow for the rest of the task / deny).
 */
function ApprovalPrompt({ approval }: { approval: ApprovalRequest }) {
  const decideApproval = useChatStore((s) => s.decideApproval)
  const isExec = approval.sideEffect === 'exec'
  return (
    <div className="my-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <div className="mb-2 flex items-start gap-2 text-[12.5px] leading-snug text-text">
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-amber-500"
        >
          <path
            d="M8 1.5l5 2v4c0 3-2.2 4.8-5 5.5C5.2 12.3 3 10.5 3 7.5v-4l5-2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        <span>
          Myto wants to {isExec ? 'run code' : 'modify a file'} with{' '}
          <strong>{approval.toolName}</strong>
          {approval.detail ? (
            <>
              {' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-[11px]">{approval.detail}</code>
            </>
          ) : null}
          . Allow it?
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => decideApproval(approval.approvalId, 'allow')}
          className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-bg transition-opacity hover:opacity-90"
        >
          Allow once
        </button>
        <button
          type="button"
          onClick={() => decideApproval(approval.approvalId, 'allow_always')}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text transition-colors hover:bg-surface-2"
        >
          Allow for this task
        </button>
        <button
          type="button"
          onClick={() => decideApproval(approval.approvalId, 'deny')}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

/**
 * The mid-reply question card (the `ask_user` tool). Myto asks its own clarifying
 * questions — one or several at once — each with optional quick-pick options plus a
 * free-text field. Answering resumes the blocked loop with the answers. Mirrors
 * {@link ApprovalPrompt}; the same pattern I use when I ask the user before acting.
 */
function QuestionPrompt({ question }: { question: QuestionRequest }) {
  const answerQuestions = useChatStore((s) => s.answerQuestions)
  const [answers, setAnswers] = useState<string[]>(() => question.questions.map(() => ''))
  const setAnswer = (i: number, value: string): void =>
    setAnswers((prev) => prev.map((a, k) => (k === i ? value : a)))
  const canSubmit = answers.some((a) => a.trim().length > 0)

  return (
    <div className="my-2 rounded-xl border border-primary/40 bg-primary/5 px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-primary">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6.2 6.2a1.9 1.9 0 1 1 2.4 1.8c-.5.2-.7.5-.7 1M8 11.2h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Myto is asking
      </div>
      <div className="space-y-3">
        {question.questions.map((q, i) => (
          <div key={i}>
            {q.header && (
              <span className="mb-1 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                {q.header}
              </span>
            )}
            <div className="mb-1.5 text-[13px] leading-snug text-text">{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const active = answers[i] === opt
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAnswer(i, opt)}
                      className={
                        'rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors ' +
                        (active
                          ? 'border-primary bg-primary/15 text-primary'
                          : 'border-border bg-surface text-text hover:bg-surface-2')
                      }
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
            )}
            <input
              type="text"
              value={answers[i]}
              onChange={(e) => setAnswer(i, e.target.value)}
              placeholder="Type your answer…"
              className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => answerQuestions(question.questionId, answers)}
          disabled={!canSubmit}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Send answers
        </button>
      </div>
    </div>
  )
}

/** These tools only exist in Cowork, so their presence marks a Cowork turn. */
const FS_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'read_file',
  'list_dir',
  'delete_file',
  'preview',
  'update_plan',
  'search_code',
  'find_files',
  'run_command',
  'spawn_agent'
])

/**
 * The live plan checklist (Cowork), pinned above the reply. The model maintains it
 * with the `update_plan` tool; each item is pending, working, or done. This is the
 * user's at-a-glance view of a multi-step task's progress — and, held on the run, it
 * survives a session switch (see useChatStore `todos`).
 */
function PlanPanel({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(false)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'done').length
  return (
    <div className="w-56 rounded-xl border border-border bg-surface/95 px-2.5 py-2 shadow-lg backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 text-[10.5px] font-medium uppercase tracking-wide text-muted transition-colors hover:text-text"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5.5 3.5h7M5.5 8h7M5.5 12.5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="2.5" cy="3.5" r="1.1" fill="currentColor" />
          <circle cx="2.5" cy="8" r="1.1" fill="currentColor" />
          <circle cx="2.5" cy="12.5" r="1.1" fill="currentColor" />
        </svg>
        Plan
        <span className="ml-auto font-mono text-[10px] normal-case tracking-normal text-muted">
          {done}/{todos.length}
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={'transition-transform ' + (collapsed ? '' : 'rotate-180')}
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {!collapsed && (
        <ul className="mt-1.5 flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[11.5px] leading-snug">
              <span className="mt-0.5 shrink-0">
                {t.status === 'done' ? (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-green-500">
                    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M5.3 8.2l1.9 1.9 3.5-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : t.status === 'in_progress' ? (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="myto-thinking text-primary">
                    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
                    <circle cx="8" cy="8" r="2.5" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-muted">
                    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2" />
                  </svg>
                )}
              </span>
              <span
                className={
                  t.status === 'done'
                    ? 'text-muted line-through'
                    : t.status === 'in_progress'
                      ? 'font-medium text-text'
                      : 'text-text'
                }
              >
                {t.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A Claude-Desktop-style collapsible group of tool steps. A turn's tool round-trips
 * are folded into ONE quiet line ("Working…" while live, "Worked for N steps" once
 * done) that the transcript keeps clean; the current action shows in the status line
 * above. Tap to expand and see each individual step. This is what keeps a long Cowork
 * run from spilling a raw "Running x / Running y / …" list down the page.
 */
function ToolActivityGroup({ tools, cowork }: { tools: ToolSegment[]; cowork: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (tools.length === 0) return null
  const running = tools.some((t) => t.result === null)
  const label = running ? 'Working…' : `Worked for ${tools.length} step${tools.length === 1 ? '' : 's'}`
  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-[12px] text-muted transition-colors hover:text-text"
      >
        <span className="grid shrink-0 place-items-center">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M10.6 3.2a2.6 2.6 0 0 0-3.3 3.3l-4.4 4.4a1 1 0 1 0 1.4 1.4l4.4-4.4a2.6 2.6 0 0 0 3.3-3.3l-1.4 1.4-1.4-.4-.4-1.4 1.4-1.4z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className={running ? 'myto-thinking font-medium' : 'font-medium'}>{label}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={'shrink-0 transition-transform ' + (expanded ? 'rotate-180' : '')}
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1 border-l border-border/60 pl-3">
          {tools.map((t, i) => (
            <ToolCard key={i} tool={t} cowork={cowork} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Format ms as m:ss (or s.s under a minute), Claude-desktop style. */
function fmtElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** A rough token estimate from character count (~4 chars/token) — no usage wire needed. */
function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.length / 4))
}

/**
 * The Claude-desktop-style meta line under a reply: elapsed time and token count.
 * While the reply streams it updates live (a 1s tick + the growing content); once
 * the turn ends it freezes at the final values. Self-contained — it times from its
 * own mount (which coincides with the reply appearing), so no store plumbing.
 */
function MessageMeta({ content, pending }: { content: string; pending: boolean }) {
  const startRef = useRef<number>(Date.now())
  const [, forceTick] = useState(0)
  const frozenRef = useRef<number | null>(null)

  useEffect(() => {
    if (!pending) {
      // Freeze elapsed at the moment streaming ended.
      if (frozenRef.current === null) frozenRef.current = Date.now() - startRef.current
      return
    }
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [pending])

  const elapsed = frozenRef.current ?? Date.now() - startRef.current
  const tokens = estimateTokens(content)
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums text-muted/70">
      <span>{fmtElapsed(elapsed)}</span>
      <span aria-hidden="true">·</span>
      <span>{tokens.toLocaleString()} tokens</span>
    </div>
  )
}

/** One block to render in an assistant reply: prose, a generated file, or a folded tool group. */
type RenderItem =
  | { kind: 'prose'; text: string }
  | { kind: 'file'; file: Extract<ReturnType<typeof parseFileBlocks>[number], { kind: 'file' }> }
  | { kind: 'toolgroup'; tools: ToolSegment[] }

function AssistantMessage({ message }: { message: ChatMessageUI }) {
  const displayContent = message.content.trimEnd()
  // Split the reply into prose and generated-file blocks so files render as
  // downloadable cards while everything else stays ordinary Markdown. A reply with
  // no file blocks yields a single prose segment — identical to rendering it whole.
  const segments = useMemo(() => parseFileBlocks(displayContent), [displayContent])
  // A turn that touched the filesystem is a Cowork turn: its tool cards render
  // borderless (the bordered/expandable style is reserved for the normal chat).
  const coworkTurn = useMemo(
    () => segments.some((s) => s.kind === 'tool' && FS_TOOL_NAMES.has(s.name ?? '')),
    [segments]
  )
  // The tool currently running (its result hasn't come back yet), if any. Its
  // friendly headline — "Listing folder", "Web search" — is what the live status
  // line shows while it runs, so tool activity appears in the same place as the
  // Thinking/Writing caption instead of only as a card badge below.
  const activeToolCaption = useMemo(() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i]
      if (s.kind === 'tool' && s.name !== 'update_plan' && s.result === null) return toolHeadline(s)
    }
    return null
  }, [segments])
  // Fold consecutive tool round-trips into one collapsible group (Claude-Desktop
  // style) so the transcript never becomes a raw "Running x / Running y" list.
  // update_plan is dropped here — it has no card; the PlanPanel above owns it.
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = []
    let group: ToolSegment[] = []
    const flush = (): void => {
      if (group.length) {
        items.push({ kind: 'toolgroup', tools: group })
        group = []
      }
    }
    for (const seg of segments) {
      if (seg.kind === 'tool') {
        if (seg.name === 'update_plan') continue
        group.push(seg)
      } else if (seg.kind === 'file') {
        flush()
        items.push({ kind: 'file', file: seg })
      } else {
        flush()
        items.push({ kind: 'prose', text: seg.text })
      }
    }
    flush()
    return items
  }, [segments])
  return (
    <div className="min-w-0 pl-4">
      {message.error && (
        <div className="mb-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {message.error}
        </div>
      )}

      {message.pending && (
        <StatusLine caption={activeToolCaption ?? statusCaption(message, displayContent)} />
      )}

      {renderItems.map((item, i) =>
        item.kind === 'file' ? (
          <FileCard key={`f${i}`} file={item.file} />
        ) : item.kind === 'toolgroup' ? (
          <ToolActivityGroup key={`g${i}`} tools={item.tools} cowork={coworkTurn} />
        ) : (
          // Myto's own reply prose is set in Georgia (serif), distinct from the UI's
          // sans — the one place the assistant's "voice" is typographically its own.
          <div key={`p${i}`} className="myto-reply font-serif">
            <Markdown content={item.text} />
          </div>
        )
      )}

      {message.pendingApproval && <ApprovalPrompt approval={message.pendingApproval} />}

      {message.pendingQuestion && <QuestionPrompt question={message.pendingQuestion} />}

      {(message.pending || displayContent.length > 0) && (
        <MessageMeta content={displayContent} pending={!!message.pending} />
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
 * mirrors the reference app), the Myto mascot and theme toggle on the right, and
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

      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </div>
  )
}

/** The four real starter leads; "Myto's choice" picks one of them at random. */
const STARTER_LEADS = [
  'Help me write ',
  'Help me understand ',
  'Help me write code to ',
  'Help me plan '
]

/**
 * The suggestion pills under the landing composer (Write / Learn / Code / Life
 * stuff / Myto's choice). Each drops a short lead into the composer and focuses
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
      label: "Myto's choice",
      lead: null,
      icon: <MytoMark size={15} />
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

/** Labels + one-line descriptions for the three Cowork permission tiers. */
const PERMISSION_MODES: { value: CoworkPermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask each time', hint: 'Confirm before every file write or code run' },
  { value: 'autoApprove', label: 'Auto-approve edits', hint: 'File edits run automatically; code still asks' },
  { value: 'bypass', label: 'Bypass permissions', hint: 'Everything runs with no prompt' }
]

/**
 * The Cowork permission-tier selector (Claude-Code style): a small popover to
 * choose Ask / Auto-approve / Bypass. Shown only in Cowork mode; the choice
 * persists in settings and governs whether side-effecting tools prompt.
 */
function CoworkPermissionMenu() {
  const mode = useAppStore((s) => s.settings.cowork.permissionMode)
  const setMode = useAppStore((s) => s.setCoworkPermissionMode)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = PERMISSION_MODES.find((m) => m.value === mode) ?? PERMISSION_MODES[0]

  // Close on any outside click while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const danger = mode === 'bypass'
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Cowork permissions"
        className={
          'flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors ' +
          (danger
            ? 'bg-red-600 text-white hover:bg-red-500'
            : 'bg-black text-white hover:bg-neutral-800')
        }
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5l5 2v4c0 3-2.2 4.8-5 5.5C5.2 12.3 3 10.5 3 7.5v-4l5-2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        {current.label}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="text-muted">
          <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-20 mb-1.5 w-60 rounded-xl border border-border bg-surface p-1 shadow-lg">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                void setMode(m.value)
                setOpen(false)
              }}
              className={
                'flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2 ' +
                (m.value === mode ? 'bg-surface-2' : '')
              }
            >
              <span
                className={
                  'text-[12.5px] font-medium ' +
                  (m.value === 'bypass' ? 'text-red-400' : 'text-text')
                }
              >
                {m.label}
                {m.value === mode ? ' ✓' : ''}
              </span>
              <span className="text-[11px] text-muted">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The reasoning-effort tiers offered in the composer, with one-line hints. */
const EFFORT_TIERS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest — quick, shallow answers' },
  { value: 'medium', label: 'Medium', hint: 'Balanced speed and depth' },
  { value: 'high', label: 'High', hint: 'Deeper thinking on hard problems' },
  { value: 'max', label: 'Max', hint: 'No compromise — the most thorough' }
]

/**
 * The reasoning-effort selector: a small popover to pick how hard the model thinks
 * before answering. The choice persists in settings and is sent to the provider as
 * `reasoning_effort` (a capable gateway maps it to the model's thinking budget).
 */
function EffortMenu() {
  const effort = useAppStore((s) => s.settings.reasoningEffort)
  const setEffort = useAppStore((s) => s.setReasoningEffort)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = EFFORT_TIERS.find((t) => t.value === effort) ?? EFFORT_TIERS[1]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Reasoning effort — how hard the model thinks"
        className="flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text/80 transition-colors hover:bg-surface-2"
      >
        {current.label}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="text-muted">
          <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-20 mb-1.5 w-56 rounded-xl border border-border bg-surface p-1 shadow-lg">
          {EFFORT_TIERS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                void setEffort(t.value)
                setOpen(false)
              }}
              className={
                'flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2 ' +
                (t.value === effort ? 'bg-surface-2' : '')
              }
            >
              <span className="text-[12.5px] font-medium text-text">
                {t.label}
                {t.value === effort ? ' ✓' : ''}
              </span>
              <span className="text-[11px] text-muted">{t.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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
  const coworkMode = useChatStore((s) => s.coworkMode)
  const setCoworkMode = useChatStore((s) => s.setCoworkMode)

  // Cowork's working folder (persisted in settings) + the picker that arms it.
  const workspaceDir = useAppStore((s) => s.settings.cowork.workspaceDir)
  const pickCoworkWorkspace = useAppStore((s) => s.pickCoworkWorkspace)

  // A model must be configured on the account before chat can send. The store's
  // modelId mirrors the account's Firestore config (and is cached in settings.json
  // so it survives offline), so gating on it degrades gracefully.
  const hasModel = useAppStore((s) => s.settings.modelId.trim().length > 0)

  // The signed-in account's given name, for the greeting — falling back to the OS
  // account name, then a friendly generic.
  const authUser = useAuthUser()
  const firstName = (authUser?.displayName?.trim() || window.myto.userName || 'there').split(
    /\s+/
  )[0]

  const [input, setInput] = useState('')
  // Files staged in the composer (already stored on disk as pending rows).
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Voice: dictation (mic) + hands-free voice mode + read-aloud. `dictating` is true
  // while the mic is capturing; `voiceMode` is the hands-free loop (read replies aloud,
  // then auto-listen); `speaking` is true while a reply is being spoken.
  const [dictating, setDictating] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const sttRef = useRef<SttSession | null>(null)
  // Composer text captured when dictation started, so partial/final transcripts append
  // to what was already typed instead of clobbering it.
  const dictationBaseRef = useRef('')
  // Whisper is preferred when an OpenAI-compatible gateway is configured; otherwise the
  // Web Speech API is used. Either way voice is only offered if some path exists.
  const preferWhisper = useAppStore(
    (s) => s.settings.activeProvider === 'gateway' && s.settings.gateway.baseUrl.trim().length > 0
  )
  const voiceInputAvailable = preferWhisper || webSpeechSupported()

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
    if (files.length === 0) return
    // Attachments need a persisted session to hang off. On a fresh landing draft
    // there's no row yet (created lazily on first send), so create one now — the
    // act of attaching is a real intent signal, same as sending. This is what lets
    // the attach button work before the first message. See canAttach below.
    let sid = useChatStore.getState().sessionId
    if (sid == null) {
      await useSessionStore.getState().create()
      sid = useChatStore.getState().sessionId
    }
    if (!sid) return
    for (const file of files) {
      try {
        const data = await fileToBase64(file)
        const mime = file.type || 'application/octet-stream'
        const attachment = await window.myto.attachments.add({
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
        console.error('[myto] failed to stage attachment:', err)
      }
    }
  }

  const removePending = (id: string): void => {
    setPending((prev) => prev.filter((p) => p.attachment.id !== id))
    void window.myto.attachments.remove(id)
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

  // Send a specific piece of text (plus any staged attachments). Shared by the composer's
  // submit and by hands-free voice mode, which submits a spoken utterance directly rather
  // than round-tripping through the input state.
  const submitText = async (text: string): Promise<void> => {
    if ((text.trim().length === 0 && pending.length === 0) || running || !hasModel) return

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

  const submit = (): Promise<void> => submitText(input)

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  // Turn a raw voice error into a short, human line for the composer hint.
  const showVoiceError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    const friendly = /permission|denied|notallowed/i.test(message)
      ? 'Microphone access was blocked. Allow it to use voice.'
      : /no-gateway|unavailable/i.test(message)
        ? 'Voice input is not available in this setup.'
        : `Voice input failed: ${message}`
    setVoiceError(friendly)
  }

  /**
   * Finalise an in-progress dictation: stop capture, get the transcript, and either drop
   * it into the composer (push-to-talk) or send it straight away (hands-free voice mode).
   */
  const finishDictation = async (submitResult: boolean): Promise<void> => {
    const session = sttRef.current
    if (!session) return
    sttRef.current = null
    setDictating(false)
    let text = ''
    try {
      text = await session.stop()
    } catch (err) {
      showVoiceError(err)
      return
    }
    const combined = dictationBaseRef.current
      ? `${dictationBaseRef.current.trim()} ${text}`.trim()
      : text.trim()
    if (submitResult) {
      if (combined) void submitText(combined)
    } else {
      setInput(combined)
    }
  }

  /** Start capturing speech. `handsFree` auto-submits on a natural pause. */
  const beginDictation = async (handsFree: boolean): Promise<void> => {
    if (sttRef.current) return
    setVoiceError('')
    dictationBaseRef.current = handsFree ? '' : input
    try {
      const session = await startDictation({
        preferWhisper,
        autoStop: handsFree,
        onPartial: (partial) => {
          const base = dictationBaseRef.current
          setInput(base ? `${base.trim()} ${partial}`.trim() : partial)
        },
        // Hands-free: a natural pause ends the utterance → finalise and submit it.
        onEnd: handsFree ? () => void finishDictation(true) : undefined
      })
      sttRef.current = session
      setDictating(true)
    } catch (err) {
      showVoiceError(err)
    }
  }

  // Push-to-talk mic: click to start, click again to stop and drop the text in the box.
  const toggleMic = (): void => {
    if (dictating) void finishDictation(false)
    else void beginDictation(false)
  }

  // Hands-free voice mode: reads replies aloud and auto-listens between them. Toggling
  // off stops any speech and cancels an in-progress listen.
  const toggleVoiceMode = (): void => {
    setVoiceError('')
    if (voiceMode) {
      setVoiceMode(false)
      ttsStop()
      setSpeaking(false)
      sttRef.current?.cancel()
      sttRef.current = null
      setDictating(false)
      return
    }
    setVoiceMode(true)
    // Start listening right away when idle; otherwise the running-reply effect picks up.
    if (!running && !dictating) void beginDictation(true)
  }

  // Drive the hands-free loop: when a reply finishes, speak it aloud and then listen for
  // the next utterance. Only the running true→false edge acts, so streaming updates to
  // `messages` don't retrigger it.
  const prevRunningRef = useRef(running)
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = running
    if (!voiceMode || !(wasRunning && !running)) return
    const last = messages[messages.length - 1]
    const toSpeak = last && last.role === 'assistant' && !last.error ? last.content : ''
    void (async () => {
      if (toSpeak && ttsSupported()) {
        setSpeaking(true)
        await ttsSpeak(toSpeak)
        setSpeaking(false)
      }
      // Still hands-free and idle after speaking? Listen for the next turn. `running` is
      // read fresh from the store because a new turn may have started while speaking.
      if (voiceMode && !useChatStore.getState().running && !sttRef.current) {
        void beginDictation(true)
      }
    })()
    // beginDictation/ttsSpeak are stable enough for this edge-triggered effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, voiceMode, messages])

  // Tidy up voice resources when the panel unmounts.
  useEffect(() => {
    return () => {
      ttsStop()
      sttRef.current?.cancel()
      sttRef.current = null
    }
  }, [])

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

  const canSend = (input.trim().length > 0 || pending.length > 0) && hasModel
  // Attaching is always allowed: stageFiles creates a session lazily if the chat is
  // still an unsaved draft, so there's no need to send a message first. sessionId is
  // still read elsewhere; referencing it here keeps the dependency explicit.
  void sessionId
  const canAttach = true
  const isEmpty = messages.length === 0

  // The live plan (Cowork): the latest assistant turn that carries a checklist. Shown
  // as a small floating panel top-right, and auto-hidden while the preview pane is open
  // so the two don't fight for the same corner.
  const previewOpen = usePreviewStore((s) => s.open)
  const planTodos = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i].todos
      if (t && t.length > 0) return t
    }
    return null
  }, [messages])

  // The working folder's leaf name, for the Cowork chip (Windows or POSIX path).
  const folderLabel = workspaceDir.split(/[\\/]/).filter(Boolean).pop() ?? ''

  // Switch to Cowork; if no folder is chosen yet, open the picker straight away so
  // the file tools have somewhere to work.
  const enableCowork = (): void => {
    setCoworkMode(true)
    if (!workspaceDir.trim()) void pickCoworkWorkspace()
  }

  /**
   * The composer card — reused by the landing hero and the pinned bottom bar. A
   * big rounded field with a control row beneath it: attach + Chat/Cowork on the
   * left; model, reasoning effort, mic and send on the right. The Chat/Cowork
   * toggle is live — Cowork switches the turn into agentic mode over the chosen
   * working folder. The effort pill and the mic/voice controls remain inert chrome
   * that mirrors the reference app; attach, the model picker and send are wired up.
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

      {/* Cowork context row — OUTSIDE and above the composer box: the working
          folder on the left, the permission tier on the right. Both are solid
          black chips with a 6px radius. */}
      {coworkMode && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void pickCoworkWorkspace()}
            title={workspaceDir || 'Choose a working folder for Cowork'}
            className="flex items-center gap-1.5 rounded-[6px] bg-black px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-neutral-800"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4.5Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <span className="max-w-[200px] truncate">{folderLabel || 'Choose folder'}</span>
          </button>

          <CoworkPermissionMenu />
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
            placeholder={
              dragging
                ? 'Drop files to attach…'
                : coworkMode
                  ? 'Give Cowork a goal to work on in your folder…'
                  : placeholder
            }
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

            {/* Chat / Cowork mode toggle. Cowork gives the model filesystem tools
                scoped to the chosen working folder + a larger agentic budget. */}
            <div className="flex items-center rounded-full border border-border bg-surface p-0.5 text-[12px]">
              <button
                type="button"
                onClick={() => setCoworkMode(false)}
                aria-pressed={!coworkMode}
                className={
                  'rounded-full px-2.5 py-1 font-medium transition-colors ' +
                  (!coworkMode ? 'bg-surface-2 text-text' : 'text-muted hover:text-text')
                }
              >
                Chat
              </button>
              <button
                type="button"
                onClick={enableCowork}
                aria-pressed={coworkMode}
                title="Cowork — work across a folder on your computer"
                className={
                  'rounded-full px-2.5 py-1 font-medium transition-colors ' +
                  (coworkMode ? 'bg-surface-2 text-text' : 'text-muted hover:text-text')
                }
              >
                Cowork
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <ModelSelector openUp />
            <EffortMenu />

            {voiceInputAvailable && (
              <button
                type="button"
                onClick={toggleMic}
                aria-label={dictating ? 'Stop dictation' : 'Dictate a message'}
                aria-pressed={dictating}
                title={dictating ? 'Stop and insert what you said' : 'Dictate — speak your message'}
                className={
                  'grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors ' +
                  (dictating
                    ? 'border-primary/60 bg-primary/10 text-primary animate-pulse'
                    : 'border-transparent text-muted hover:bg-surface-2 hover:text-text')
                }
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="6" y="1.5" width="4" height="8.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            )}

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
            ) : voiceInputAvailable ? (
              <button
                type="button"
                onClick={toggleVoiceMode}
                aria-label={voiceMode ? 'Turn off voice mode' : 'Turn on voice mode'}
                aria-pressed={voiceMode}
                title={
                  voiceMode
                    ? 'Voice mode on — reads replies aloud and listens. Click to turn off.'
                    : 'Voice mode — hands-free: reads replies aloud and listens for your reply.'
                }
                className={
                  'grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ' +
                  (voiceMode
                    ? 'bg-primary text-bg ' + (speaking || dictating ? 'animate-pulse' : '')
                    : 'bg-surface-2 text-muted hover:text-text')
                }
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 8h1.5M5 5v6M8 3v10M11 5.5v5M13.5 8H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            ) : (
              <span
                title="Voice mode (needs a configured model or browser speech support)"
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

      {!hasModel && (
        <p className="mt-2 text-center text-[12px] text-muted">
          No model configured. Add one on the Myto website → Authentication page to start chatting.
        </p>
      )}
      {(dictating || speaking || voiceError) && (
        <p className="mt-2 text-center text-[12px] text-muted">
          {voiceError
            ? voiceError
            : speaking
              ? 'Speaking…'
              : dictating
                ? 'Listening… click the mic to finish.'
                : ''}
        </p>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col bg-bg">
      <MainTopBar />

      {isEmpty ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 pb-16 pt-8">
            <MytoMark size={40} className="mb-4" />
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
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Floating plan panel, top-right — small, and auto-hidden while the
              preview pane is open (it takes over that side of the screen). */}
          {planTodos && !previewOpen && (
            <div className="pointer-events-auto absolute right-3 top-2 z-10">
              <PlanPanel todos={planTodos} />
            </div>
          )}
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
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">{renderComposer('Message Myto…')}</div>
        </div>
      )}
    </div>
  )
}
