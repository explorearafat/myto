import { ipcMain } from 'electron'
import { app } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannel } from '../shared/ipc'
import type { PersistedMessage, PersistedSession, PersistedToolOp, SessionSummary } from '../shared/types'
import { contextManager } from './context/manager'
import {
  appendMessage,
  appendTerminalChunk,
  appendToolOp,
  createSession,
  deleteSession,
  getActiveSession,
  listSessions,
  loadSession,
  mostRecentSession,
  renameSession,
  resetMessageForRegenerate,
  searchSessions,
  setActiveSession,
  setMessageFeedback,
  updateMessage
} from './db/sessions'

/**
 * Wires the Phase 5 session-persistence IPC. Query-style ops use handle/invoke;
 * high-frequency appends use on/send (fire-and-forget, no round-trip) — the same
 * split as terminal vs providers. Reads (list/search/most-recent) are GLOBAL —
 * history is one flat, cross-folder list so switching workspaces never hides
 * chats; only a new session is stamped with the active project root via
 * {@link contextManager}. Every append is defensively wrapped so a DB fault
 * degrades to a log line instead of breaking the live chat or terminal.
 *
 * Loading or creating a session also marks it {@link setActiveSession active} so
 * the terminal choke point knows where to append pty output.
 */
export function registerSessionIpc(): void {
  ipcMain.handle(IpcChannel.SessionsList, (_event, projectId?: string | null): SessionSummary[] => {
    return listSessions(projectId)
  })

  ipcMain.handle(IpcChannel.SessionsCreate, (_event, projectId?: string | null): SessionSummary => {
    const summary = createSession(
      contextManager.getRoot(),
      'New session',
      Date.now(),
      projectId ?? null
    )
    setActiveSession(summary.id)
    return summary
  })

  ipcMain.handle(IpcChannel.SessionsLoad, (_event, id: string): PersistedSession | null => {
    const loaded = loadSession(id)
    if (loaded) setActiveSession(id)
    return loaded
  })

  ipcMain.handle(IpcChannel.SessionsRename, (_event, id: string, title: string): void => {
    renameSession(id, title, Date.now())
  })

  ipcMain.handle(IpcChannel.SessionsRemove, (_event, id: string): void => {
    deleteSession(id)
    if (getActiveSession() === id) setActiveSession(null)
    // Best-effort: remove the session's attachment files (DB rows already
    // cascaded). The directory name is our own id (no user path), and we stay
    // strictly under userData/attachments/.
    try {
      rmSync(join(app.getPath('userData'), 'attachments', id), { recursive: true, force: true })
    } catch (err) {
      console.error('[sylor] attachment cleanup on session delete failed:', err)
    }
  })

  ipcMain.handle(IpcChannel.SessionsMostRecent, (): string | null => {
    return mostRecentSession()
  })

  ipcMain.handle(
    IpcChannel.SessionsSearch,
    (_event, query: string, projectId?: string | null): SessionSummary[] => {
      return searchSessions(query, projectId)
    }
  )

  // Fire-and-forget appends. Wrapped so a DB error never propagates to the UI.
  ipcMain.on(
    IpcChannel.SessionsAppendMessage,
    (_event, sessionId: string, msg: PersistedMessage) => {
      safe(() => appendMessage(sessionId, msg, Date.now()))
    }
  )

  ipcMain.on(
    IpcChannel.SessionsUpdateMessage,
    (_event, _sessionId: string, id: string, content: string, error?: string) => {
      safe(() => updateMessage(id, content, error, Date.now()))
    }
  )

  ipcMain.on(
    IpcChannel.SessionsSetFeedback,
    (
      _event,
      _sessionId: string,
      id: string,
      feedback: 'like' | 'dislike' | null,
      flagged: boolean
    ) => {
      safe(() => setMessageFeedback(id, feedback, flagged))
    }
  )

  ipcMain.on(IpcChannel.SessionsResetMessage, (_event, _sessionId: string, id: string) => {
    safe(() => resetMessageForRegenerate(id))
  })

  ipcMain.on(IpcChannel.SessionsAppendToolOp, (_event, sessionId: string, op: PersistedToolOp) => {
    safe(() => appendToolOp(sessionId, op, Date.now()))
  })

  ipcMain.on(IpcChannel.SessionsAppendTerminal, (_event, sessionId: string, data: string) => {
    safe(() => appendTerminalChunk(sessionId, data))
  })
}

/** Run a DB write, swallowing errors to a console line (persistence is best-effort). */
function safe(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error('[sylor] session persistence write failed:', err)
  }
}
