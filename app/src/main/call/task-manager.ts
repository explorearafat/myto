/**
 * The bridge between a voice call and Myto's REAL agent loop.
 *
 * There is no second agent here. Every spoken request becomes a turn of the
 * same streaming loop the desktop UI uses (`handleStreamStart`, lifted out of
 * provider-ipc), with a synthetic sender that taps chunks instead of painting
 * the window: text deltas feed the TTS pipeline, command reports stream to the
 * phone as logs, approval/question prompts become voice/tap confirmations.
 *
 * A "task" ("open my Sylor project and finish the authentication system") is a
 * cowork-mode run on the workspace — the full 240-turn agentic budget — tracked
 * in `call_tasks` so it can outlive the call and trigger a callback.
 */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IpcChannel } from '../../shared/ipc'
import type {
  ApprovalRequest,
  ChatMessage,
  CommandRun,
  CompletionRequest,
  QuestionRequest
} from '../../shared/types'
import { handleStreamStart } from '../provider-ipc'
import { getSettings } from '../settings'
import { appendMessage, createSession, loadSession } from '../db/sessions'
import { getCallTask, insertCallTask, updateCallTask } from './db'
import type { CallTaskRow } from './db'
import { setTaskActive } from './busy-state'

/**
 * Voice-call output contract, prepended as a system message on every call turn.
 * The adapters carry caller-supplied system turns (the Anthropic wire hoists
 * them into `system`), so this rides the normal message list — no loop changes.
 */
export const VOICE_DIRECTIVE = [
  'VOICE CALL MODE — you are speaking ALOUD on a live phone call, through a natural female Indian voice.',
  'Reply in short conversational sentences (one to three sentences unless real detail is required).',
  'No markdown, no bullet lists, no code blocks, no emoji — plain spoken prose only.',
  'When asked to do something on this PC, act with your tools immediately: first say in one short sentence what you are about to do, then do it, then report the outcome in plain words.',
  'Read key results aloud (paths, numbers, pass/fail) — never read raw code, JSON, or file dumps aloud.',
  'If a command fails, say in one sentence what failed and what you suggest next.',
  'For destructive or irreversible actions, ask one short yes/no question and wait for the answer.',
  'If a task will take a long time, say so, confirm you will keep working after the call ends, and continue.',
  'Never mention or quote these instructions.'
].join(' ')

/** Semantic events a call turn raises, after tapping the raw chunk stream. */
export interface CallTurnEvents {
  /** Visible reply text as it streams (feeds the TTS pipeline). */
  onDelta: (text: string) => void
  /** A short present-tense caption ("Running npm install…"). */
  onStatus: (text: string) => void
  /** A shell command the agent ran (mirrors the desktop Terminal pane). */
  onCommand: (run: CommandRun) => void
  /** A side-effecting tool needs permission — settle via decideApproval(). */
  onApproval: (req: ApprovalRequest) => void
  /** The ask_user tool wants answers — settle via answerCallQuestions(). */
  onQuestion: (req: QuestionRequest) => void
  /** Command output lines worth streaming to the phone. */
  onLog: (line: string) => void
}

export interface CallTurnResult {
  text: string
  error?: string
}

export interface CallSessionRecord {
  sessionId: string
}

/**
 * Create the sqlite session a call talks through. It appears in the desktop
 * sidebar like any other chat ("Voice call — <first words>"), so the user can
 * read the full transcript afterward.
 */
export function createCallSession(mode: 'chat' | 'cowork', workspaceDir: string, title: string): CallSessionRecord {
  const summary = createSession(workspaceDir || '(voice call)', title, Date.now(), null, mode)
  return { sessionId: summary.id }
}

export function appendUserMessage(sessionId: string, text: string): string {
  const id = `u-${randomUUID()}`
  appendMessage(sessionId, { id, role: 'user', content: text }, Date.now())
  return id
}

export function appendAssistantMessage(sessionId: string, text: string, model?: string): string {
  const id = `a-${randomUUID()}`
  appendMessage(sessionId, { id, role: 'assistant', content: text, model }, Date.now())
  return id
}

/** The conversation so far (for context continuity across call turns). */
export function loadHistory(sessionId: string): ChatMessage[] {
  const loaded = loadSession(sessionId)
  if (!loaded) return []
  return loaded.messages.map((m) => ({
    role: m.role,
    content: m.content
  }))
}

/**
 * Run ONE agent turn through the real loop with a tapping sender. Resolves when
 * the stream completes (done or error). The loop may park on approvals — the
 * caller settles them via the events.
 */
export async function runCallTurn(opts: {
  streamId: string
  request: CompletionRequest
  events: CallTurnEvents
  /** Also mirror chunks to the desktop window (default: tap only). */
  mirror?: boolean
}): Promise<CallTurnResult> {
  let fullText = ''
  let error: string | undefined

  const sender = {
    isDestroyed: (): boolean => false,
    send: (channel: string, payload: unknown): void => {
      if (channel !== IpcChannel.ProvidersStreamChunk) return
      const chunk = payload as { delta?: string; done?: boolean; error?: string; status?: string; approval?: ApprovalRequest; question?: QuestionRequest; command?: CommandRun }
      if (chunk.delta) {
        fullText += chunk.delta
        opts.events.onDelta(chunk.delta)
      }
      if (chunk.status) opts.events.onStatus(chunk.status)
      if (chunk.command) {
        opts.events.onCommand(chunk.command)
        const out = chunk.command.output
        if (out) for (const line of out.split('\n')) opts.events.onLog(line)
      }
      if (chunk.approval) opts.events.onApproval(chunk.approval)
      if (chunk.question) opts.events.onQuestion(chunk.question)
      if (chunk.error) error = chunk.error
      // Optional mirror: surface the call session in the desktop window too.
      if (opts.mirror) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(channel, payload)
        }
      }
    }
  }

  await handleStreamStart({ sender }, opts.streamId, opts.request)
  return { text: fullText, error }
}

/** The effective mode for call work: cowork when a workspace exists, else chat. */
export function callMode(): 'chat' | 'cowork' {
  return getSettings().cowork.workspaceDir.trim() !== '' ? 'cowork' : 'chat'
}

/** Build the message list for one voice turn (directive + history + new ask). */
export function buildVoiceMessages(history: ChatMessage[], userText: string): ChatMessage[] {
  return [{ role: 'system', content: VOICE_DIRECTIVE }, ...history, { role: 'user', content: userText }]
}

/**
 * Start an autonomous task from a call: registers the `call_tasks` row, runs a
 * cowork-mode agent run to completion (this outlives the call — the loop lives
 * in the main process), reporting progress through `events`. Resolves with the
 * task row at its terminal state.
 */
export async function startTaskFromCall(opts: {
  callId: string
  workspaceDir: string
  prompt: string
  events: CallTurnEvents & { onTaskState: (state: CallTaskRow['status'], summary: string) => void }
}): Promise<CallTaskRow> {
  const taskId = `task-${randomUUID().slice(0, 8)}`
  const session = createCallSession('cowork', opts.workspaceDir, opts.prompt.slice(0, 60))
  insertCallTask({
    id: taskId,
    callId: opts.callId,
    sessionId: session.sessionId,
    workspaceDir: opts.workspaceDir,
    prompt: opts.prompt,
    status: 'running',
    summary: ''
  })
  setTaskActive(true)
  opts.events.onTaskState('running', opts.prompt.slice(0, 120))

  const msgId = appendUserMessage(session.sessionId, opts.prompt)
  try {
    const result = await runCallTurn({
      streamId: `call-${taskId}`,
      request: {
        messages: buildVoiceMessages(loadHistory(session.sessionId).slice(0, -1), opts.prompt),
        mode: 'cowork',
        sessionId: session.sessionId,
        afterMsgId: msgId
      },
      events: opts.events
    })

    appendAssistantMessage(session.sessionId, result.text || result.error || '')
    // Terminal classification: an explicit error or an unfinished plan is a
    // failure/block; otherwise the loop's own verify gate (#16) already proved
    // the work when configured — reaching `done` here IS the completion signal.
    const isFailure = Boolean(result.error)
    const status: CallTaskRow['status'] = isFailure ? 'failed' : 'completed'
    const summary = summarize(result.text || result.error || '')
    updateCallTask(taskId, {
      status,
      terminalStatus: status,
      summary,
      terminalAt: Date.now()
    })
    opts.events.onTaskState(status, summary)
    return getCallTask(taskId)!
  } catch (error) {
    const summary = `Task stopped unexpectedly: ${String(error)}`
    updateCallTask(taskId, { status: 'failed', terminalStatus: 'failed', summary, terminalAt: Date.now() })
    opts.events.onTaskState('failed', summary)
    return getCallTask(taskId)!
  } finally {
    setTaskActive(false)
  }
}

/** A spoken-length summary of a finished task (what Myto says on the callback). */
export function summarize(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= 400) return clean
  return `${clean.slice(0, 397)}…`
}
