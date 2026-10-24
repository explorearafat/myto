import { create } from 'zustand'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  ChatImage,
  ChatMessage,
  ChatMode,
  CommandRun,
  EditorEvent,
  FileChange,
  GeneratedMedia,
  PersistedSession,
  PreviewTarget,
  QuestionRequest,
  TodoItem
} from '@shared/types'
import type { PromptBlock } from '@shared/types/prompt-builder'
import { takeReveal } from '../lib/reveal'
import { usePreviewStore } from './usePreviewStore'
import { auth } from '../lib/firebase'
import { saveMediaArtifact } from '../lib/artifacts'
import { useTerminalStore } from './useTerminalStore'
import { useFilesStore } from './useFilesStore'
import { useEditorStore } from './useEditorStore'
import { useAppStore } from './useAppStore'

/**
 * Turn generation output (Feature B) or rasterized document pages (A2b) into Markdown that
 * the existing reply pipeline renders and persists for free — no schema change, no rehydration
 * path. An image becomes an inline `![alt](src)` (react-markdown renders `<img>`, `data:` URIs
 * included); a video becomes a `[▶ …](src)` link, because our Markdown renderer escapes raw HTML
 * and so can't embed a `<video>` player. `src` is the inline `data:` bytes when we have them
 * (they survive the provider expiring temporary URLs) or the returned URL otherwise.
 */
function mediaToMarkdown(media: GeneratedMedia[]): string {
  const parts: string[] = []
  for (const m of media) {
    const src = m.dataBase64 ? `data:${m.mediaType};base64,${m.dataBase64}` : m.url
    if (!src) continue
    const alt = (m.prompt ?? (m.kind === 'video' ? 'video' : 'image')).replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').slice(0, 300)
    parts.push(m.kind === 'video' ? `[▶ ${alt || 'video'}](${src})` : `![${alt}](${src})`)
    // "Open folder" action for files the editing tools wrote to disk: a
    // `myto-reveal:` link the Markdown renderer turns into a button that
    // asks the main process to reveal the (re-validated) file in the OS
    // file manager. The path rides along as a workspace-relative string.
    if (m.localPath) {
      parts.push(`[Open folder](myto-reveal:${encodeURIComponent(m.localPath)})`)
    }
  }
  return parts.length ? `\n\n${parts.join('\n\n')}\n\n` : ''
}

/**
 * How often (ms) buffered stream deltas are flushed into the rendered message.
 * Appending to a growing Markdown message on every token would re-parse and
 * re-highlight the whole thing each time — O(n²) work that freezes the UI on a
 * large response. Coalescing to ~15fps keeps streaming smooth without a hang.
 *
 * It doubles as the reveal cadence: a tick shows part of whatever is queued (see
 * `lib/reveal.ts`), so text that arrived as one big delta still types out.
 */
const DELTA_FLUSH_MS = 66

/**
 * How often (ms) the still-streaming assistant reply is checkpointed to the DB.
 *
 * The assistant's prose used to be written only once, on completion. So if a run
 * was interrupted before it finished — the app reopened, a new session started, a
 * crash — the entire reply was lost and the reloaded session looked wiped (a user
 * turn with no answer). Checkpointing the prose on a ~1s cadence (in addition to
 * the final write) bounds the worst-case loss to the last second of tokens, and
 * matches how durably the user turn is already saved. Cheap: a throttled local
 * SQLite upsert.
 */
const ASSISTANT_PERSIST_MS = 1000

/**
 * One "thinking" phase of a reply — a contiguous run of the model's reasoning
 * (chain-of-thought) captured before some visible output. `at` is the offset into
 * the reply's flushed content where this phase belongs (so the renderer can slot
 * the collapsible Thinking block between the prose/tool/file segments that surround
 * it); `text` is the reasoning itself (token-counted, shown when expanded); `done`
 * flips true once the phase is sealed (the model began visible output or the turn
 * ended) so the block stops animating. A single reply can hold several phases — a
 * Cowork run reasons afresh before each tool round-trip. Transient — never persisted.
 */
export interface ThinkingPhase {
  at: number
  text: string
  done: boolean
  /** Wall-clock ms (`Date.now()`) when this phase began — lets the live block show a
   *  time-based label ("Thinking" → "Thinking some more" → "Almost done thinking")
   *  that survives re-mounts. Transient; never persisted. */
  startedAt: number
}

/** A chat message as rendered in the UI (adds id + streaming/error metadata). */
export interface ChatMessageUI {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** True while the assistant reply is still streaming. */
  pending?: boolean
  /** Set when the run ended in error. */
  error?: string
  /** Local-only 👍/👎 reaction; absent when none. Never transmitted anywhere. */
  feedback?: 'like' | 'dislike'
  /** Local-only "reported" marker the user toggled. Never transmitted. */
  flagged?: boolean
  /**
   * The live status caption shown above this reply while it streams — the model's
   * latest `<status>` (see main/status.ts), or undefined before one arrives (the
   * UI then falls back to a generic "Thinking"/"Writing"). Transient: set only on
   * the in-flight assistant turn, never persisted or transmitted.
   */
  status?: string
  /**
   * A pending Cowork approval prompt for a side-effecting tool. Set while the
   * main-process loop is blocked awaiting the user's decision; the assistant turn
   * renders an approval card. Cleared once the user answers (see decideApproval) or
   * the run ends. Transient — never persisted.
   */
  pendingApproval?: ApprovalRequest
  /**
   * A pending batch of ask_user questions Myto raised mid-turn. Set while the loop is
   * blocked awaiting answers; the assistant turn renders a question card. Cleared once
   * answered (see answerQuestions) or the run ends. Transient — never persisted.
   */
  pendingQuestion?: QuestionRequest
  /**
   * The agent's current working plan (Cowork) — the checklist the model maintains
   * with the `update_plan` tool, pinned above the reply. Set as the run streams and
   * kept after it ends so the finished plan stays visible. Transient — never persisted.
   */
  todos?: TodoItem[]
  /**
   * The reply's thinking phases (see {@link ThinkingPhase}) — the model's reasoning
   * captured as it streamed, interleaved with the visible output by offset. Grows as
   * the run reasons; kept after it ends so the finished "Thought for N tokens" blocks
   * stay collapsible. Transient — never persisted or transmitted.
   */
  thinking?: ThinkingPhase[]
  /**
   * `Date.now()` of the last time this run produced real output — any streamed delta,
   * status caption, reasoning, tool step, or plan update. Drives the streaming
   * liveness note (see lib/liveness.ts + MessageMeta): the elapsed clock keeps
   * climbing while the stream is silent, so this is what tells a live run from a hung
   * one. Set only on the in-flight turn; never persisted or transmitted.
   */
  activityAt?: number
}

/**
 * An attachment being sent with a user turn. `textContent` is the decoded body
 * for text-like files (read by the composer), inlined into the model history so
 * it can read the file; binary/image files carry only metadata and are referenced
 * by a note (images additionally ride along as native vision input — see `send`).
 */
export interface OutgoingAttachment {
  attachment: Attachment
  /** Decoded text body for text-like mimes; undefined for binary/images. */
  textContent?: string
}

/**
 * An in-flight streaming reply, tracked independently of which conversation is on
 * screen so it keeps going when the user switches sessions ("background
 * processing"). Its IPC chunk listener stays attached; each chunk is buffered
 * here and persisted to the owner session, and mirrored into the visible store
 * only while its owner session is the one being viewed. Switching back re-attaches
 * to the live `content` here (see {@link projectLiveRun}).
 */
interface LiveRun {
  runId: string
  /** The session this run writes to (persisted results land here), or null. */
  ownerSessionId: string | null
  /** The assistant message id this run streams into. */
  assistantId: string
  /** Flushed assistant prose so far (authoritative; survives session switches). */
  content: string
  /**
   * The model's latest `<status>` caption for this run (see main/status.ts), or
   * undefined before one arrives. Held here — like `content` — so switching back
   * to a background run re-attaches to its live caption, not a stale one.
   */
  status?: string
  /**
   * A pending approval prompt for this run, or undefined when none is open. Held
   * here (like `status`/`content`) so switching back to a background run that is
   * waiting on the user re-attaches to the live prompt.
   */
  pendingApproval?: ApprovalRequest
  /** A pending ask_user question batch for this run, or undefined when none is open. */
  pendingQuestion?: QuestionRequest
  /**
   * The run's current working plan (Cowork), held here — like `status`/`content` —
   * so switching back to a background run re-attaches to its live checklist.
   */
  todos?: TodoItem[]
  /**
   * The run's thinking phases (see {@link ThinkingPhase}), held here — like
   * `content`/`todos` — so switching back to a background run re-attaches to its
   * live, still-growing reasoning blocks rather than a stale snapshot.
   */
  thinking?: ThinkingPhase[]
  /** Cancels the main-process stream and detaches its chunk listener. */
  disposer: () => void
  /** Un-flushed delta text, drained by the flush timer. */
  buffer: string
  /** Pending flush timer id, or null when idle. */
  flushTimer: ReturnType<typeof setTimeout> | null
  /**
   * `Date.now()` of the last real output from this run (delta / status / reasoning /
   * tool step / plan). Seeded when the run starts and bumped on every meaningful
   * chunk; the on-screen turn mirrors it as `activityAt` so the liveness note can
   * tell a live run from a stalled one (see lib/liveness.ts).
   */
  lastActivityAt: number
  /**
   * `Date.now()` of the last time the streaming prose was checkpointed to the DB,
   * or 0 before the first checkpoint. Throttles the mid-run persistence in
   * {@link ASSISTANT_PERSIST_MS} so an interrupted run keeps its reply.
   */
  lastPersist: number
  /**
   * True once the run has ended (completed, errored, or been cancelled). Guards the
   * async disposer race: `streamCompletion` resolves its disposer on a later
   * microtask, so a run that finishes (or is cancelled) before then sets this, and
   * the resolved disposer is invoked immediately instead of being stored.
   */
  settled: boolean
}

/**
 * Live runs keyed by their owner session id. A session has at most one active
 * run (send/regenerate are blocked while `running`). Entries are removed on
 * completion/error/cancel/clear.
 */
const liveRuns = new Map<string, LiveRun>()

export interface ChatState {
  messages: ChatMessageUI[]
  /** Attachments tied to sent user messages (chips render under each message). */
  attachments: Attachment[]
  /** True while a streaming reply is active. */
  running: boolean
  /** Current run id, or null when idle. */
  runId: string | null
  /** Disposer for the active run's stream subscription. */
  disposer: (() => void) | null
  /** The persisted session this conversation is being written to, or null. */
  sessionId: string | null
  /** Project the active session is filed under (drives per-project instructions). */
  projectId: string | null
  /**
   * Ids of every session with a run still in flight — including runs owned by
   * conversations that are NOT on screen. A reactive mirror of the module-level
   * {@link liveRuns} map, which React can't subscribe to. Without it, background
   * runs were invisible: opening a New Chat mid-task left no trace of the old one
   * anywhere in the UI, so a run that was still going looked paused or lost.
   */
  liveSessionIds: string[]
  /** Prompt builder mode ('text' or 'builder'). */
  composerMode: 'text' | 'builder'
  /** Visual prompt blocks when in builder mode. */
  promptBlocks: PromptBlock[]
  /**
   * The draft's working mode — the authoritative source of truth for how the next
   * sent turn runs: `'chat'` (plain conversation), `'cowork'` (folder-scoped agent),
   * or `'research'` (the folderless professional-agent surface). A session's mode is
   * fixed at creation, so loading one restores its stored mode here. A plain UI
   * selection — it never persists on a message; it is captured at send time.
   */
  draftMode: ChatMode

  /**
   * Convenience mirror of `draftMode === 'cowork'`, kept in sync by the setters. Read
   * by the many Cowork-specific affordances (rewind, plan chip, folder chip, top-bar
   * DNA/Terminal/Preview icons, folder gate) so they light up for Cowork only and stay
   * dark for Chat and Research.
   */
  coworkMode: boolean

  /**
   * Send a user turn and start a streaming reply. No-op while already running or
   * when both text and attachments are empty. Attachments are bound to the user
   * message; text-like bodies are inlined into the model history and images ride
   * along as native vision input.
   */
  send: (text: string, attachments?: OutgoingAttachment[]) => void
  /** Cancel the active run, keeping whatever was streamed so far. */
  cancel: () => void
  /** Clear the whole conversation (cancels any active run first). */
  clear: () => void
  /**
   * Cancel the background run owned by `sessionId`, whichever conversation is on
   * screen. Used before deleting a chat: otherwise its run kept going against a
   * row that no longer exists. A no-op when that session has no run.
   */
  cancelSession: (sessionId: string) => void
  /**
   * Toggle a local like/dislike reaction on a message. Clicking the same value
   * again clears it. Local-only (persisted for reload, never transmitted).
   */
  setFeedback: (messageId: string, feedback: 'like' | 'dislike') => void
  /** Toggle the local "reported" flag on a message. Local-only. */
  toggleFlag: (messageId: string) => void
  /**
   * Rewrite/regenerate an assistant message: re-run over the history up to (but
   * not including) it, streaming into the SAME message id. Clears its content
   * first. No new user turn is appended. No-op while a run is active or if the id
   * isn't an assistant turn.
   */
  regenerate: (messageId: string) => void
  /**
   * Rehydrate the conversation from a loaded session (synchronous). Replaces
   * messages, binds to the session id, and reconciles the id counter so new ids
   * never collide with restored ones. Orchestrated by the session store.
   */
  applyLoaded: (loaded: PersistedSession) => void
  /**
   * Reset to an empty conversation (synchronous). Pass a session id to bind to a
   * freshly-created row, or `null` for an unsaved draft — the landing page shown
   * on launch and after "New chat", before the first message persists a row.
   */
  resetTo: (sessionId: string | null, projectId?: string | null) => void
  /** Switch composer between text and builder modes. */
  setComposerMode: (mode: 'text' | 'builder') => void
  /** Update the visual prompt blocks (builder mode). */
  setPromptBlocks: (blocks: PromptBlock[]) => void
  /** Set the draft's working mode directly ('chat' | 'cowork' | 'research'). */
  setDraftMode: (mode: ChatMode) => void
  /** Toggle Cowork on (Cowork) or off (Research — the new non-Cowork surface). */
  setCoworkMode: (on: boolean) => void
  /**
   * Answer a pending Cowork approval prompt. Sends the decision to the main process
   * (which resumes the blocked tool loop) and clears the prompt from the UI.
   */
  decideApproval: (approvalId: string, decision: ApprovalDecision) => void
  /** Answer a pending ask_user question batch (resumes the blocked loop). */
  answerQuestions: (questionId: string, answers: string[]) => void
}

/**
 * A salt fixed once per app launch, mixed into every id that gets persisted as a
 * DB primary key (messages). The counter below resets to 0 on every launch, so a
 * bare `msg-1` minted in a fresh session would reuse an id a PREVIOUS run already
 * wrote — and `appendMessage`'s `INSERT … ON CONFLICT(id) DO UPDATE` would then
 * overwrite that other session's row and save nothing to the new one. The
 * launch-time salt makes ids globally unique across runs, exactly like the
 * main-process generators that embed `Date.now()`. base36 keeps it compact.
 */
const ID_SALT = Date.now().toString(36)
let idCounter = 0
const nextId = (): string => `msg-${ID_SALT}-${++idCounter}`
let runCounter = 0
const nextRunId = (): string => `run-${ID_SALT}-${++runCounter}`

/**
 * After rehydrating persisted ids ('msg-7'), advance the in-memory counter past
 * the highest seen so freshly-minted ids never collide with restored ones. Ids
 * that don't match the numeric pattern are ignored.
 */
function bumpCountersFrom(ids: string[], prefix: string, set: (n: number) => void): void {
  let max = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  set(max)
}

/** Human-readable byte size for an attachment note (e.g. "12.4 KB"). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Fold outgoing attachments into a block appended to the user turn. Text-like
 * files are inlined in a fenced block (so the model can read them); binaries and
 * images become a one-line note with name/mime/size (images also ride along as
 * native vision input, so the note is the graceful fallback for a text-only
 * model). Empty when there are no attachments.
 */
function buildAttachmentContext(attachments: OutgoingAttachment[]): string {
  if (attachments.length === 0) return ''
  const parts = attachments.map(({ attachment, textContent }) => {
    if (textContent != null) {
      return `Attached file "${attachment.name}" (${attachment.mime}):\n\`\`\`\n${textContent}\n\`\`\``
    }
    return `[Attached file: ${attachment.name} (${attachment.mime}, ${formatSize(attachment.size)})]`
  })
  return parts.join('\n\n')
}

/**
 * Read each image attachment's stored bytes and decode the returned data URL into
 * the raw base64 + mime a {@link ChatImage} carries. Non-image attachments are
 * skipped (they go in as text/notes); an image that fails to read is dropped
 * rather than aborting the turn — the caption note still names it.
 */
async function collectImages(attachments: OutgoingAttachment[]): Promise<ChatImage[]> {
  const images: ChatImage[] = []
  for (const { attachment } of attachments) {
    if (!attachment.mime.startsWith('image/')) continue
    const dataUrl = await window.myto.attachments.read(attachment.id)
    if (!dataUrl) continue
    const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
    if (match) images.push({ mediaType: match[1], dataBase64: match[2] })
  }
  return images
}

/** Rehydrate UI messages from a loaded session. */
function hydrate(loaded: PersistedSession): {
  messages: ChatMessageUI[]
  attachments: Attachment[]
} {
  const messages: ChatMessageUI[] = loaded.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.error != null ? { error: m.error } : {}),
    ...(m.feedback != null ? { feedback: m.feedback } : {}),
    ...(m.flagged ? { flagged: true } : {})
  }))
  // Advance the id counter past everything restored.
  bumpCountersFrom(
    messages.map((m) => m.id),
    'msg-',
    (n) => {
      idCounter = Math.max(idCounter, n)
    }
  )
  return { messages, attachments: loaded.attachments }
}

/**
 * Overlay any live background run onto a freshly-hydrated view of `sessionId`,
 * so switching back to a session whose run is still going re-attaches to the
 * exact live stream rather than showing a stale, frozen partial. Returns the
 * transient run fields (`running`/`runId`/`disposer`) plus the messages with the
 * run's live assistant content merged in. When the session has no live run,
 * returns the base view marked idle.
 */
function projectLiveRun(
  base: { messages: ChatMessageUI[] },
  sessionId: string | null
): {
  messages: ChatMessageUI[]
  running: boolean
  runId: string | null
  disposer: (() => void) | null
} {
  const run = sessionId ? liveRuns.get(sessionId) : undefined
  if (!run) {
    return { ...base, running: false, runId: null, disposer: null }
  }

  // The assistant turn isn't finalized until the run completes, so mid-run add (or
  // refresh) it with the live, still-pending content.
  const messages = [...base.messages]
  const idx = messages.findIndex((m) => m.id === run.assistantId)
  if (idx >= 0) {
    messages[idx] = {
      ...messages[idx],
      content: run.content,
      pending: true,
      error: undefined,
      status: run.status,
      pendingApproval: run.pendingApproval,
      pendingQuestion: run.pendingQuestion,
      todos: run.todos,
      thinking: run.thinking,
      activityAt: run.lastActivityAt
    }
  } else {
    messages.push({
      id: run.assistantId,
      role: 'assistant',
      content: run.content,
      pending: true,
      status: run.status,
      pendingApproval: run.pendingApproval,
      pendingQuestion: run.pendingQuestion,
      todos: run.todos,
      thinking: run.thinking,
      activityAt: run.lastActivityAt
    })
  }

  return {
    messages,
    running: true,
    runId: run.runId,
    disposer: run.disposer
  }
}

/**
 * Conversation + streaming state. `send` appends the user turn and a pending
 * assistant turn, then streams the model's reply (via
 * `providers.streamCompletion`) into that assistant message.
 *
 * Runs are tracked in {@link liveRuns} independently of which conversation is on
 * screen, so a run started in one session keeps going — and lands its reply in
 * that session — when the user switches away (background processing).
 */
export const useChatStore = create<ChatState>((set, get) => {
  /**
   * Publish the current {@link liveRuns} keys to `liveSessionIds` so the rail can
   * badge chats that are still working. Called at every point the map is mutated.
   * Bails when the key list is unchanged, so this never triggers a re-render on
   * its own.
   */
  const syncLiveSessions = (): void => {
    const next = [...liveRuns.keys()]
    const prev = get().liveSessionIds
    if (prev.length === next.length && next.every((id, i) => prev[i] === id)) return
    set({ liveSessionIds: next })
  }

  /**
   * Launch a streaming reply into the assistant message `assistantId`, feeding the
   * model `history`. Shared by `send` (fresh user turn) and `regenerate` (re-run
   * over trimmed history into the same slot). The run is registered in
   * {@link liveRuns} under `ownerSessionId`; its chunk handler updates the visible
   * store only while that session is on screen, but always buffers content and
   * persists the reply to the owner session.
   */
  const startRun = (
    ownerSessionId: string | null,
    assistantId: string,
    history: ChatMessage[],
    mode: ChatMode,
    afterMsgId: string | null
  ): void => {
    const runId = nextRunId()

    const run: LiveRun = {
      runId,
      ownerSessionId,
      assistantId,
      content: '',
      disposer: () => {},
      buffer: '',
      flushTimer: null,
      lastPersist: 0,
      lastActivityAt: Date.now(),
      settled: false
    }

    // Create the assistant row up-front (empty), right after the user turn that was
    // just persisted in `send`. This anchors the reply even if the run is
    // interrupted before it streams any prose, so a reload never shows a user turn
    // with no answer slot. `appendMessage` upserts by id, so the regenerate path
    // (row already blanked) and the streaming checkpoints below reuse it.
    if (ownerSessionId) {
      window.myto.sessions.appendMessage(ownerSessionId, {
        id: assistantId,
        role: 'assistant',
        content: ''
      })
    }

    /** Is this run's owner session the conversation currently on screen? */
    const isVisible = (): boolean => get().sessionId === ownerSessionId

    /**
     * Drain buffered deltas into the store, if visible.
     *
     * `all` drains the queue completely, for the moment where a partial reveal
     * would be wrong rather than just slower: the end of a run must show the whole
     * reply. Everything else goes through {@link takeReveal}, which passes a live
     * token stream straight through and types out a block that arrived all at once.
     */
    const flush = (all = false): void => {
      if (run.flushTimer != null) {
        clearTimeout(run.flushTimer)
        run.flushTimer = null
      }
      const lead = all ? { shown: run.buffer, rest: '' } : takeReveal(run.buffer)
      const leadText = lead.shown
      run.buffer = lead.rest
      if (leadText) run.content += leadText
      // The prose is checkpointed to the DB on a throttled cadence so an
      // interrupted run (app reopened / new session / crash) keeps its reply.
      // Persists to the OWNER session regardless of what's on screen; the final
      // content is rewritten authoritatively on completion/error.
      if (leadText && ownerSessionId) {
        const now = Date.now()
        if (now - run.lastPersist >= ASSISTANT_PERSIST_MS) {
          run.lastPersist = now
          window.myto.sessions.appendMessage(ownerSessionId, {
            id: assistantId,
            role: 'assistant',
            content: run.content
          })
        }
      }
      // Keep the reveal ticking while text is still queued — the next tick has to
      // come from here, since no further delta may arrive to schedule one.
      if (run.buffer !== '') scheduleFlush()
      if (!leadText) return
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content + leadText, activityAt: run.lastActivityAt }
              : m
          )
        }))
      }
    }
    const scheduleFlush = (): void => {
      if (run.flushTimer == null) run.flushTimer = setTimeout(flush, DELTA_FLUSH_MS)
    }

    /**
     * Open or grow the current thinking phase with the model's latest reasoning
     * snapshot. The producer sends a monotonically growing `text`, so an in-flight
     * phase (the last one, not yet `done`) is updated in place; a phase is opened
     * only when none is live — anchored at the current flushed-content offset so the
     * renderer slots the block right where the reasoning happened.
     */
    const setThinking = (text: string): void => {
      const phases = run.thinking ?? (run.thinking = [])
      const last = phases[phases.length - 1]
      if (last && !last.done) last.text = text
      else phases.push({ at: run.content.length + run.buffer.length, text, done: false, startedAt: Date.now() })
      if (isVisible()) {
        const snapshot = phases.map((p) => ({ ...p }))
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, thinking: snapshot, activityAt: run.lastActivityAt } : m
          )
        }))
      }
    }

    /** Seal the current thinking phase so its block stops animating (turn boundary). */
    const resetThinking = (): void => {
      const phases = run.thinking
      if (!phases || phases.length === 0) return
      const last = phases[phases.length - 1]
      if (last.done) return
      last.done = true
      if (isVisible()) {
        const snapshot = phases.map((p) => ({ ...p }))
        set((state) => ({
          messages: state.messages.map((m) => (m.id === assistantId ? { ...m, thinking: snapshot } : m))
        }))
      }
    }

    /** Finalize a completed reply: persist, detach, and clear the run. */
    const finishOk = (): void => {
      if (run.settled) return
      flush(true)
      run.settled = true
      run.pendingApproval = undefined
      run.pendingQuestion = undefined
      run.disposer()
      if (ownerSessionId) liveRuns.delete(ownerSessionId)
      syncLiveSessions()
      if (ownerSessionId) {
        window.myto.sessions.appendMessage(ownerSessionId, {
          id: assistantId,
          role: 'assistant',
          content: run.content
        })
      }
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId
              ? { ...m, pending: false, pendingApproval: undefined, pendingQuestion: undefined }
              : m
          ),
          running: false,
          runId: null,
          disposer: null
        }))
      }
    }

    /** Finalize a failed reply: keep partial prose, tag the error, detach. */
    const finishError = (message: string): void => {
      if (run.settled) return
      flush(true)
      run.settled = true
      run.pendingApproval = undefined
      run.pendingQuestion = undefined
      run.disposer()
      if (ownerSessionId) liveRuns.delete(ownerSessionId)
      syncLiveSessions()
      const content = run.content || '_Request failed._'
      run.content = content
      if (ownerSessionId) {
        window.myto.sessions.appendMessage(ownerSessionId, {
          id: assistantId,
          role: 'assistant',
          content,
          error: message
        })
      }
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  pending: false,
                  pendingApproval: undefined,
                  pendingQuestion: undefined,
                  error: message,
                  content: m.content || '_Request failed._'
                }
              : m
          ),
          running: false,
          runId: null,
          disposer: null
        }))
      }
    }

    /**
     * Update the live status caption for this run. Held on the run so a session
     * switch re-attaches to it (see {@link projectLiveRun}), and mirrored onto the
     * on-screen message only while this run's session is the one being viewed.
     */
    const setStatus = (status: string): void => {
      run.status = status
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, status, activityAt: run.lastActivityAt } : m
          )
        }))
      }
    }

    /**
     * Set or clear this run's pending approval prompt. Held on the run (survives a
     * session switch) and mirrored onto the on-screen assistant turn when visible.
     */
    const setApproval = (approval: ApprovalRequest | undefined): void => {
      run.pendingApproval = approval
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, pendingApproval: approval } : m
          )
        }))
      }
    }

    /** Set or clear this run's pending ask_user questions (mirrors {@link setApproval}). */
    const setQuestion = (question: QuestionRequest | undefined): void => {
      run.pendingQuestion = question
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, pendingQuestion: question } : m
          )
        }))
      }
    }

    /**
     * Set this run's working plan (Cowork). Held on the run (survives a session
     * switch) and mirrored onto the on-screen assistant turn when visible — the same
     * shape as {@link setApproval}/{@link setStatus}. Kept after the run ends so the
     * finished checklist stays on the turn.
     */
    const setTodos = (todos: TodoItem[]): void => {
      run.todos = todos
      if (isVisible()) {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, todos, activityAt: run.lastActivityAt } : m
          )
        }))
      }
    }

    const onChunk = (chunk: {
      delta: string
      done: boolean
      error?: string
      status?: string
      approval?: ApprovalRequest
      question?: QuestionRequest
      preview?: PreviewTarget
      todos?: TodoItem[]
      command?: CommandRun
      fileChange?: FileChange
      thinking?: string
      thinkingReset?: boolean
      media?: GeneratedMedia[]
      editor?: EditorEvent
    }): void => {
      // Any chunk that carries real output is a sign of life — stamp the run so the
      // liveness note (MessageMeta) measures silence from the last actual progress,
      // not from mount. `done` alone is the turn ending, not progress; skip it.
      if (
        chunk.delta ||
        chunk.status !== undefined ||
        chunk.thinking !== undefined ||
        chunk.thinkingReset ||
        chunk.todos ||
        chunk.command ||
        chunk.fileChange ||
        chunk.preview ||
        chunk.approval ||
        chunk.question ||
        chunk.editor ||
        (chunk.media && chunk.media.length > 0)
      ) {
        run.lastActivityAt = Date.now()
      }
      // `!== undefined`, not truthiness: an empty-string status is a deliberate
      // signal to clear the caption (the main process sends it when a reasoning
      // model's derived "thinking" snippet gives way to real reply text) and hand
      // the line back to the renderer's own "Writing"/"Thinking" fallback.
      if (chunk.status !== undefined) setStatus(chunk.status)
      // The model's raw reasoning grew (reasoning models) — open/extend the live
      // thinking block; a reset seals it at the turn boundary (see main/status.ts).
      if (chunk.thinking !== undefined) setThinking(chunk.thinking)
      if (chunk.thinkingReset) resetThinking()
      // A side-effecting Cowork tool is awaiting the user's OK — raise the prompt.
      if (chunk.approval) setApproval(chunk.approval)
      // Myto asked the user clarifying questions (ask_user) — raise the question card.
      if (chunk.question) setQuestion(chunk.question)
      // Myto opened something in its preview pane — drive the (global) pane. Not
      // scoped to this run: the pane is a standalone surface, like a browser window.
      // A preview always wins its slot: show it (which pins a url/markdown target) and
      // close the other two panes so they don't stack.
      if (chunk.preview) {
        usePreviewStore.getState().show(chunk.preview)
        useTerminalStore.getState().close()
        useFilesStore.getState().close()
        useEditorStore.getState().close()
      }
      // Myto ran a shell command — append it to the Terminal pane. The right-hand panes
      // are mutually exclusive, so normally this takes the slot (reveal + close the
      // others). But while a preview OR the editor is PINNED (a live dev server / a plan
      // under review / an edit mid-play-or-bake), the continuing log must NOT steal the
      // slot: append quietly (reveal:false) and leave the pinned pane up.
      if (chunk.command) {
        const pinned = usePreviewStore.getState().pinned || useEditorStore.getState().pinned
        useTerminalStore.getState().append(chunk.command, { reveal: !pinned })
        if (!pinned) {
          usePreviewStore.getState().close()
          useFilesStore.getState().close()
          useEditorStore.getState().close()
        }
      }
      // Myto created/edited/deleted a file — upsert it into the live Working-tree pane.
      // Same no-steal rule as commands: while a preview or the editor is pinned, a
      // hot-reload write updates the tree quietly without yanking the pinned pane;
      // otherwise it takes the slot.
      if (chunk.fileChange) {
        const pinned = usePreviewStore.getState().pinned || useEditorStore.getState().pinned
        useFilesStore.getState().append(chunk.fileChange, { reveal: !pinned })
        if (!pinned) {
          usePreviewStore.getState().close()
          useTerminalStore.getState().close()
          useEditorStore.getState().close()
        }
      }
      // Myto is editing a photo/video — drive the "watch me edit" pane. A fresh edit
      // (phase 'open') takes the slot like a preview, closing the other panes; later
      // phases (script/progress/baked/error) just update it in place. The store pins the
      // slot while playing/baking so the no-steal rules above keep the editor on screen,
      // and unpins on baked/error.
      if (chunk.editor) {
        useEditorStore.getState().apply(chunk.editor)
        if (chunk.editor.phase === 'open') {
          usePreviewStore.getState().close()
          useTerminalStore.getState().close()
          useFilesStore.getState().close()
        }
      }
      // Myto published/updated its working plan — pin the live checklist on this turn.
      if (chunk.todos) setTodos(chunk.todos)
      // Generated media (Feature B) or rasterized pages (A2b): fold into the reply as
      // Markdown so it renders inline now and persists with the turn's prose (no separate
      // media store / rehydration needed). Goes through the same buffer as text deltas.
      if (chunk.media && chunk.media.length > 0) {
        run.buffer += mediaToMarkdown(chunk.media)
        // Artifacts vault: every generated image/clip is written to Firestore
        // under the signed-in uid, so the website /artifacts page and the
        // Android app show the same vault. Fire-and-forget — a vault write
        // must never break the live reply.
        const vaultUid = auth.currentUser?.uid
        if (vaultUid) {
          for (const m of chunk.media) {
            void saveMediaArtifact(vaultUid, m).catch(() => {})
          }
        }
        scheduleFlush()
      }
      if (chunk.delta) {
        run.buffer += chunk.delta
        scheduleFlush()
      }
      if (chunk.done) {
        if (chunk.error) finishError(chunk.error)
        else finishOk()
      }
    }

    // Kick off the stream. `streamCompletion` is async and resolves its disposer on
    // a later microtask; store it on the run, or invoke it at once if the run has
    // already settled (a cancel/completion beat the resolution — see LiveRun.settled).
    // sessionId + afterMsgId key the file_snapshots this run records (#1 rewind);
    // both are Cowork-only on the main side and harmless in chat.
    void window.myto.providers
      .streamCompletion(
        {
          messages: history,
          mode,
          ...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
          ...(afterMsgId ? { afterMsgId } : {})
        },
        onChunk
      )
      .then((dispose) => {
        if (run.settled) dispose()
        else run.disposer = dispose
      })

    if (ownerSessionId) liveRuns.set(ownerSessionId, run)
    syncLiveSessions()
    if (isVisible()) set({ running: true, runId, disposer: () => run.disposer() })
  }

  /** Tear down the live run owning `sessionId` (cancel + detach + drop timer). */
  const disposeRun = (sessionId: string | null): void => {
    const run = sessionId ? liveRuns.get(sessionId) : undefined
    if (run) run.settled = true
    if (run?.flushTimer != null) clearTimeout(run.flushTimer)
    // Persist the final prose before detaching. A Stop (cancel) or a clear can land
    // between checkpoints, so without this the last (<1s) of streamed text —
    // including any delta still sitting un-flushed in the buffer — would be dropped
    // from the saved turn. Fold the pending buffer in, then upsert the row by id.
    if (run?.ownerSessionId) {
      const finalContent = run.content + run.buffer
      run.buffer = ''
      run.content = finalContent
      window.myto.sessions.appendMessage(run.ownerSessionId, {
        id: run.assistantId,
        role: 'assistant',
        content: finalContent
      })
    }
    // Prefer the run's own disposer; fall back to the visible one (same when the
    // run being cancelled is the on-screen one).
    ;(run?.disposer ?? get().disposer)?.()
    if (sessionId) liveRuns.delete(sessionId)
    syncLiveSessions()
  }

  return {
    messages: [],
    attachments: [],
    running: false,
    runId: null,
    disposer: null,
    sessionId: null,
    projectId: null,
    liveSessionIds: [],
    composerMode: 'text',
    promptBlocks: [],
    draftMode: 'research',
    coworkMode: false,

    send: (text, attachments = []) => {
      const trimmed = text.trim()
      if ((!trimmed && attachments.length === 0) || get().running) return

      // Capture the mode at send time so a later toggle can't change how this
      // in-flight turn runs. draftMode is authoritative (chat | cowork | research).
      const mode: ChatMode = get().draftMode

      const userMsg: ChatMessageUI = { id: nextId(), role: 'user', content: trimmed }
      const assistantId = nextId()
      const assistantMsg: ChatMessageUI = {
        id: assistantId,
        role: 'assistant',
        content: '',
        pending: true
      }

      // History sent to the model: prior turns + this user turn. The user turn's
      // content is what was typed, augmented with attachment context (inline text
      // for text files, a note for binaries/images) so the model can see what was
      // attached — the *displayed* content stays as the user typed it.
      const historyBase: ChatMessage[] = get().messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
      const attachmentContext = buildAttachmentContext(attachments)
      const userContentForModel =
        attachmentContext === '' ? trimmed : `${trimmed}\n\n${attachmentContext}`.trim()

      // Bind the (already-stored) attachments to this user message and add them to
      // the conversation's attachment list so their chips render under the message.
      const bound: Attachment[] = attachments.map((a) => ({
        ...a.attachment,
        messageId: userMsg.id
      }))

      // Instant echo: append both turns and flip to running synchronously, before
      // the (async) image read below, so the user's message never lags their keypress.
      set((state) => ({
        messages: [...state.messages, userMsg, assistantMsg],
        attachments: [...state.attachments, ...bound],
        running: true
      }))

      // Persist the user turn immediately (fire-and-forget). The assistant turn is
      // created up-front and checkpointed as it streams (see startRun/flush), then
      // finalized on completion/error — so an interruption can't lose the reply.
      const owner = get().sessionId
      if (owner) {
        window.myto.sessions.appendMessage(owner, {
          id: userMsg.id,
          role: 'user',
          content: userMsg.content
        })
        if (bound.length > 0) {
          void window.myto.attachments.attachToMessage(
            bound.map((a) => a.id),
            userMsg.id
          )
        }
      }

      // Read any image bytes for native vision input, then start the stream. If the
      // turn was cancelled/cleared during the read (same session, no longer
      // running), abandon it rather than reviving a run the user just stopped.
      void collectImages(attachments).then((images) => {
        if (get().sessionId === owner && !get().running) return
        const userTurn: ChatMessage = {
          role: 'user',
          content: userContentForModel,
          ...(images.length > 0 ? { images } : {})
        }
        startRun(owner, assistantId, [...historyBase, userTurn], mode, userMsg.id)
      })
    },

    cancel: () => {
      disposeRun(get().sessionId)
      set((state) => ({
        messages: state.messages.map((m) =>
          m.pending ? { ...m, pending: false, pendingApproval: undefined, pendingQuestion: undefined } : m
        ),
        running: false,
        runId: null,
        disposer: null
      }))
    },

    clear: () => {
      disposeRun(get().sessionId)
      set({
        messages: [],
        attachments: [],
        running: false,
        runId: null,
        disposer: null
      })
    },

    cancelSession: (sessionId) => {
      // Guarded on `has`: disposeRun falls back to the *visible* run when the id
      // owns none, which would kill the wrong task. Only act on a real live run.
      if (!liveRuns.has(sessionId)) return
      disposeRun(sessionId)
      // If that run was the one on screen, clear the transient view state too.
      if (get().sessionId === sessionId) {
        set((state) => ({
          messages: state.messages.map((m) =>
          m.pending ? { ...m, pending: false, pendingApproval: undefined, pendingQuestion: undefined } : m
        ),
          running: false,
          runId: null,
          disposer: null
        }))
      }
    },

    setFeedback: (messageId, feedback) => {
      const { messages, sessionId } = get()
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      // Clicking the active reaction again clears it (toggle semantics).
      const next = msg.feedback === feedback ? null : feedback
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, feedback: next ?? undefined } : m
        )
      }))
      if (sessionId)
        window.myto.sessions.setFeedback(sessionId, messageId, next, msg.flagged ?? false)
    },

    toggleFlag: (messageId) => {
      const { messages, sessionId } = get()
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      const next = !msg.flagged
      set((state) => ({
        messages: state.messages.map((m) => (m.id === messageId ? { ...m, flagged: next } : m))
      }))
      if (sessionId)
        window.myto.sessions.setFeedback(sessionId, messageId, msg.feedback ?? null, next)
    },

    regenerate: (messageId) => {
      if (get().running) return
      const { messages, sessionId } = get()
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx < 0 || messages[idx].role !== 'assistant') return
      // Re-run over every turn before this assistant reply (its prompting user turn
      // included). Attachment bodies aren't re-inlined — regeneration works from the
      // displayed transcript, which is what the user sees and expects.
      const history: ChatMessage[] = messages
        .slice(0, idx)
        .map((m) => ({ role: m.role, content: m.content }))
      if (history.length === 0) return

      // Reset the assistant slot in place (same id): clear content, drop any prior
      // reaction/flag, and mark it streaming again.
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: '',
                pending: true,
                error: undefined,
                feedback: undefined,
                flagged: undefined,
                status: undefined
              }
            : m
        ),
        running: true
      }))
      // Clear the persisted copy so a reload shows only the regenerated result.
      if (sessionId) window.myto.sessions.resetMessage(sessionId, messageId)

      // The user turn this reply answers (last user row before the assistant slot) —
      // keys the file_snapshots a Cowork regenerate records, so a later rewind targets
      // the right turn.
      const answersMsgId =
        [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user')?.id ?? null

      startRun(sessionId, messageId, history, get().draftMode, answersMsgId)
    },

    applyLoaded: (loaded) => {
      const prevSession = get().sessionId
      if (prevSession && prevSession !== loaded.session.id) {
        usePreviewStore.getState().close()
      }
      // Do NOT tear down in-flight runs when switching conversations — they keep
      // running in the background and route their reply to their own session. If the
      // session being opened has a live run, re-attach to it (overlay the live
      // content and restore the running state).
      const { messages, attachments } = hydrate(loaded)
      set({
        sessionId: loaded.session.id,
        projectId: loaded.session.projectId,
        // A session is fixed to one mode at creation (Task 6): restore it so the
        // right toolset is armed and the nav toggle reflects it. Set directly (not
        // via setDraftMode) so merely opening an old chat never changes the
        // last-used mode that new drafts default to. draftMode is authoritative;
        // coworkMode mirrors it for the Cowork-only affordances.
        draftMode: loaded.session.mode,
        coworkMode: loaded.session.mode === 'cowork',
        attachments,
        ...projectLiveRun({ messages }, loaded.session.id)
      })
    },

    resetTo: (sessionId, projectId = null) => {
      if (get().sessionId && sessionId !== get().sessionId) {
        usePreviewStore.getState().close()
      }
      // A fresh session starts empty; it has no live run to re-attach to, but we
      // still route through projectLiveRun for a single, consistent projection.
      //
      // A brand-new draft (no id yet) opens in the last-used mode (Task 7), but the
      // non-Cowork surface is now Research — a persisted legacy 'chat' last-mode opens
      // as Research so the rename is complete for new drafts. When binding to a
      // freshly-created row instead, the current draftMode is already authoritative
      // (create() persisted the row with it), so it's left as-is — never remixing a
      // session's fixed mode.
      const draftMode: ChatMode =
        sessionId === null
          ? useAppStore.getState().lastMode === 'cowork'
            ? 'cowork'
            : 'research'
          : get().draftMode
      set({
        sessionId,
        projectId,
        draftMode,
        coworkMode: draftMode === 'cowork',
        attachments: [],
        ...projectLiveRun({ messages: [] }, sessionId)
      })
    },

    setComposerMode: (mode) => set({ composerMode: mode }),

    setPromptBlocks: (blocks) => set({ promptBlocks: blocks }),

    setDraftMode: (mode) => {
      set({ draftMode: mode, coworkMode: mode === 'cowork' })
      // The top-bar DNA/Terminal/Preview/Files/Editor icons are Cowork affordances;
      // leaving Cowork (to Chat or Research) would strand anything they drove with no
      // visible toggle. Tidy on the way out: drop the composer back to plain text and
      // close all four side panes (closing the preview/editor also clears their pin).
      // (Research is folderless and drives its own preview via the preview tool.)
      if (mode !== 'cowork') {
        set({ composerMode: 'text' })
        usePreviewStore.getState().close()
        useTerminalStore.getState().close()
        useFilesStore.getState().close()
        useEditorStore.getState().close()
      }
      // An explicit selection is the "last-used mode": remember it so the next new
      // chat opens here (Task 7). Fire-and-forget — the persist is best-effort and the
      // in-memory draftMode above already drives the current draft.
      void useAppStore.getState().setLastMode(mode)
    },

    // Legacy binary toggle: Cowork on, or off → Research (the renamed non-Cowork
    // surface). Kept so existing callers (rail buttons, slash commands) keep working.
    setCoworkMode: (on) => {
      get().setDraftMode(on ? 'cowork' : 'research')
    },

    decideApproval: (approvalId, decision) => {
      // Tell the main process (resumes the blocked tool loop).
      window.myto.providers.decideApproval(approvalId, decision)
      // Clear the prompt from whichever run holds it + the on-screen message.
      let assistantId: string | null = null
      for (const run of liveRuns.values()) {
        if (run.pendingApproval?.approvalId === approvalId) {
          run.pendingApproval = undefined
          assistantId = run.assistantId
        }
      }
      set((state) => ({
        messages: state.messages.map((m) =>
          m.pendingApproval?.approvalId === approvalId || (assistantId && m.id === assistantId)
            ? { ...m, pendingApproval: undefined }
            : m
        )
      }))
    },

    answerQuestions: (questionId, answers) => {
      // Tell the main process (resumes the blocked ask_user tool).
      window.myto.providers.answerQuestions(questionId, answers)
      // Clear the question card from whichever run holds it + the on-screen message.
      let assistantId: string | null = null
      for (const run of liveRuns.values()) {
        if (run.pendingQuestion?.questionId === questionId) {
          run.pendingQuestion = undefined
          assistantId = run.assistantId
        }
      }
      set((state) => ({
        messages: state.messages.map((m) =>
          m.pendingQuestion?.questionId === questionId || (assistantId && m.id === assistantId)
            ? { ...m, pendingQuestion: undefined }
            : m
        )
      }))
    }
  }
})
