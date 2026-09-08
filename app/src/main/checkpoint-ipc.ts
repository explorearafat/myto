import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { CheckpointInfo, RestoreResult } from '../shared/types'
import { listCheckpoints, restoreCheckpoint } from './checkpoint/checkpoints'
import { contextManager } from './context/manager'

/**
 * Checkpoint IPC — the renderer's door onto the snapshots the engine takes before
 * it changes anything (see `checkpoint/checkpoints.ts`).
 *
 * Both handlers are scoped to the **active project root**, not to a path the
 * renderer sends: a restore rewrites files, so which folder it may rewrite is a
 * decision the main process makes on its own. There is deliberately no delete
 * channel — a timeline whose entries the UI can remove is not a safety net.
 */
export function registerCheckpointIpc(): void {
  ipcMain.handle(IpcChannel.CheckpointsList, (): CheckpointInfo[] => {
    try {
      return listCheckpoints(contextManager.getRoot())
    } catch (err) {
      console.error('[sylor] failed to list checkpoints:', err)
      return []
    }
  })

  ipcMain.handle(
    IpcChannel.CheckpointsRestore,
    async (_event, id: unknown): Promise<RestoreResult> => {
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'No checkpoint was named.' }
      }
      try {
        return await restoreCheckpoint(contextManager.getRoot(), id)
      } catch (err) {
        console.error('[sylor] failed to restore a checkpoint:', err)
        return { ok: false, error: 'Restoring failed.' }
      }
    }
  )
}
