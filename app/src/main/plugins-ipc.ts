import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { PluginInstallInput, PluginInstallResult } from '../shared/types'
import { contextManager } from './context/manager'
import { installPlugin, listPlugins, removePlugin } from './plugins/installer'
import { skillsRegistry } from './skills/registry'
import { commandsRegistry } from './commands/registry'

/**
 * Registers the Plugins IPC. A plugin is a git repo (or local folder) bundling
 * any of `skills/<name>/SKILL.md`, `commands/*.md`, and an `mcp.json` of
 * connectors; installing unpacks its contents into the ordinary `.sylor`
 * locations so they behave identically to hand-authored ones. This is the UI
 * path (a Settings "Plugins" section); the engine's `install_plugin` tool is the
 * in-chat path — both share {@link installPlugin}.
 *
 * After a successful install or a removal we reload the skills + commands
 * registries so the freshly (un)packed capabilities show up immediately in the
 * `/` menu and the model's directive without waiting for a restart.
 */
export function registerPluginsIpc(): void {
  ipcMain.handle(IpcChannel.PluginsList, () => listPlugins(contextManager.getRoot()))

  ipcMain.handle(
    IpcChannel.PluginsInstall,
    async (_event, input: PluginInstallInput): Promise<PluginInstallResult> => {
      const root = contextManager.getRoot()
      const outcome = await installPlugin(input, root)
      if (outcome.ok) {
        // The clone unpacked new skills/commands into `.sylor`; re-scan so they
        // are usable this session (the connectors are picked up on next reconnect).
        skillsRegistry.reload(root)
        commandsRegistry.reload(root)
      }
      return outcome
    }
  )

  ipcMain.handle(IpcChannel.PluginsRemove, (_event, name: string) => {
    const root = contextManager.getRoot()
    const remaining = removePlugin(name, root)
    // Drop the withdrawn skills/commands from the live registries too.
    skillsRegistry.reload(root)
    commandsRegistry.reload(root)
    return remaining
  })
}
