import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import { getUserProfile, appendUserProfile } from './settings'

/**
 * Long-term memory IPC — the renderer-facing door onto the SAME global user
 * profile the Code/Cowork engine already reads and writes via `remember_user`
 * (see {@link getUserProfile} / {@link appendUserProfile} in settings.ts). It's
 * exposed here so the Sylor browser agent can share one memory with Sylor:
 * read what's already known (to act faster and more personally) and add durable
 * facts it learns while browsing (which then follow the user into every future
 * Sylor and Sylor session).
 *
 * Security: this only ever reads/appends short prose facts in userData. The
 * engine's own prompt already forbids recording secrets, keys, or one-off
 * details, and the same rule is stated to the Sylor agent — nothing sensitive
 * belongs here. Both handlers are defensive: a read failure yields '' and a write
 * failure yields false, so a persistence hiccup can never crash a run.
 */
export function registerMemoryIpc(): void {
  ipcMain.handle(IpcChannel.MemoryGet, (): string => {
    try {
      return getUserProfile()
    } catch (err) {
      console.error('[sylor] failed to read long-term memory:', err)
      return ''
    }
  })

  ipcMain.handle(IpcChannel.MemoryRemember, (_event, note: unknown): boolean => {
    if (typeof note !== 'string') return false
    try {
      return appendUserProfile(note)
    } catch (err) {
      console.error('[sylor] failed to append long-term memory:', err)
      return false
    }
  })
}
