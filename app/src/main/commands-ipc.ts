import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { CommandAddInput, CommandMutationResult } from '../shared/types'
import { contextManager } from './context/manager'
import {
  commandsRegistry,
  deleteCommandFile,
  globalCommandsDir,
  projectCommandsDir,
  writeCommand
} from './commands/registry'

/**
 * Registers the Commands IPC. Commands are disk-authored Markdown templates in
 * `~/.sylor/commands/*.md` (global) + `<root>/.sylor/commands/*.md` (project);
 * the composer surfaces them in the `/` menu and the engine expands a leading
 * `/<name> args` into the template body before the turn runs. This mirrors the
 * Skills IPC: the renderer lists them, authors/deletes them, and asks for a
 * re-scan after editing a `.md` by hand.
 *
 * Every handler resolves the project root from {@link contextManager} — the same
 * source the engine uses — so a project's `.sylor/commands` always resolves
 * against the session the user is actually in.
 */
export function registerCommandsIpc(): void {
  ipcMain.handle(IpcChannel.CommandsList, () => commandsRegistry.getCommands(contextManager.getRoot()))

  // Reload re-scans disk (the user may have added/edited a `.md`) and returns the
  // fresh list.
  ipcMain.handle(IpcChannel.CommandsReload, () => commandsRegistry.reload(contextManager.getRoot()))

  // Author a new command: render + write a `<name>.md` on disk, then re-scan. A
  // blank name/body or an unwritable scope comes back as a friendly error (with
  // the unchanged list) rather than throwing across the IPC bridge.
  ipcMain.handle(IpcChannel.CommandsAdd, (_event, input: CommandAddInput): CommandMutationResult => {
    const root = contextManager.getRoot()
    try {
      writeCommand(
        {
          name: input.name,
          description: input.description,
          argumentHint: input.argumentHint,
          body: input.body
        },
        input.scope,
        root
      )
      return { ok: true, commands: commandsRegistry.reload(root) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message, commands: commandsRegistry.getCommands(root) }
    }
  })

  // Remove a disk command by name: find its `.md` path, delete it, then re-scan.
  ipcMain.handle(IpcChannel.CommandsRemove, (_event, name: string) => {
    const root = contextManager.getRoot()
    const cmd = commandsRegistry.getCommands(root).find((c) => c.name === name && c.path)
    if (cmd?.path) deleteCommandFile(cmd.path)
    return commandsRegistry.reload(root)
  })

  ipcMain.handle(IpcChannel.CommandsConfigPaths, () => {
    const root = contextManager.getRoot()
    return { global: globalCommandsDir(), project: root ? projectCommandsDir(root) : null }
  })
}
