import { ipcMain } from 'electron'
import { app } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannel } from '../shared/ipc'
import type {
  ChatMode,
  PersistedMessage,
  PersistedSession,
  RewindResult,
  SessionSummary
} from '../shared/types'
import { getSettings } from './settings'
import {
  appendMessage,
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
  setMessageFeedback
} from './db/sessions'
import { rewindSession } from './rewind'
import { findSnapshotBefore } from './db/snapshots'

/**
 * Wires the session-persistence IPC. Query-style ops use handle/invoke;
 * high-frequency appends use on/send (fire-and-forget, no round-trip) so the live
 * chat never blocks. Reads (list/search/most-recent) are GLOBAL — history is one
 * flat, cross-folder list so switching projects never hides chats. Every append is
 * defensively wrapped so a DB fault degrades to a log line instead of breaking the
 * live chat.
 *
 * Loading or creating a session also marks it {@link setActiveSession active}.
 */
export function registerSessionIpc(): void {
  ipcMain.handle(IpcChannel.SessionsList, (_event, projectId?: string | null): SessionSummary[] => {
    return listSessions(projectId)
  })

  ipcMain.handle(
    IpcChannel.SessionsCreate,
    (_event, projectId?: string | null, mode?: ChatMode): SessionSummary => {
      const summary = createSession('', 'New session', Date.now(), projectId ?? null, mode ?? 'chat')
      setActiveSession(summary.id)
      return summary
    }
  )

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
      console.error('[myto] attachment cleanup on session delete failed:', err)
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
      safe(() => appendMessage(sessionId, stampModel(msg), Date.now()))
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

  // Rewind (#1): reverse-replay file snapshots + truncate the chat. Invoke-style —
  // the renderer awaits the summary and reloads the session on success.
  ipcMain.handle(
    IpcChannel.SessionsRewind,
    (_event, sessionId: string, afterMsgId: string): RewindResult => {
      try {
        return rewindSession(sessionId, afterMsgId, Date.now())
      } catch (err) {
        console.error('[myto] rewind failed:', err)
        return {
          ok: false,
          filesRestored: 0,
          filesDeleted: 0,
          messagesRemoved: 0,
          reason: err instanceof Error ? err.message : 'Rewind failed.'
        }
      }
    }
  )

  // Snapshot diff base (#5): the pre-change bytes for a file card's overwrite diff.
  // Content-addressed lookup (see findSnapshotBefore) — null means a fresh create,
  // so the card falls back to its all-additions view. Read-only; never throws.
  ipcMain.handle(
    IpcChannel.SessionsSnapshotBefore,
    (_event, sessionId: string, after: string): string | null => {
      try {
        return findSnapshotBefore(sessionId, after)
      } catch (err) {
        console.error('[myto] snapshotBefore failed:', err)
        return null
      }
    }
  )
}

/**
 * Record which model produced an assistant turn, so the dashboard's "favourite
 * model" is real history rather than whatever happens to be selected today.
 *
 * The renderer never sees the model id — it lives in main's provider settings —
 * so main stamps it here, on the up-front (empty) assistant insert that starts
 * every run. The DB keeps the value from that first write, so the streaming
 * re-upserts can't overwrite it. User turns and an unconfigured model are left
 * alone (a blank label would be worse than none).
 */
function stampModel(msg: PersistedMessage): PersistedMessage {
  if (msg.role !== 'assistant' || msg.model) return msg
  const { modelName, modelId } = getSettings()
  const label = (modelName || modelId).trim()
  return label ? { ...msg, model: label } : msg
}

/** Run a DB write, swallowing errors to a console line (persistence is best-effort). */
function safe(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error('[myto] session persistence write failed:', err)
  }
}
