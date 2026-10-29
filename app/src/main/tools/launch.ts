import { join, resolve } from 'node:path'
import { fsAvailable } from './fs'
import type { ToolDef } from './registry'
import {
  findLaunchConfig,
  readLaunchConfigs,
  resolveLaunchCwd,
  type LaunchConfig
} from './myto-config'
import { startDevServer } from './devServer'

/**
 * `run_launch` — start a run configuration from the project's `.myto/launch.json`.
 *
 * The launch file declares HOW the project runs (command, working folder, port) as
 * named configurations, so the agent never has to guess `npm run dev` vs
 * `npm run preview` vs a nested app's port. Starting a config goes through the same
 * background machinery as `run_dev_server`: the process keeps running after the turn,
 * output streams to the Terminal pane, and a detected localhost URL opens the preview.
 * With `autoPort: true` (or unspecified), a busy port is bumped to the next free one
 * and the chosen port is appended as `--port N`.
 */

async function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve_) => {
    const { createConnection } = require('node:net') as typeof import('node:net')
    const socket = createConnection({ port, host: '127.0.0.1' })
    const settle = (busy: boolean) => {
      socket.destroy()
      resolve_(busy)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    // A port with no listener hangs the probe — decide after a beat.
    setTimeout(() => settle(false), 700)
  })
}

/** Build the shell command string for a launch config, quoting args that need it. */
export function launchCommand(config: LaunchConfig, port?: number): string {
  const args = [...config.runtimeArgs]
  if (port != null) args.push('--port', String(port))
  const quote = (a: string) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return [config.runtimeExecutable, ...args.map(quote)].join(' ')
}

export const runLaunchTool: ToolDef = {
  name: 'run_launch',
  description:
    'Start a named run configuration from the project\'s .myto/launch.json (e.g. {"name": "site"}) ' +
    '— the declared way to run THIS project\'s app/dev server. The process keeps running in the ' +
    'background, its output streams to the Terminal pane, and a detected localhost URL opens the ' +
    'preview automatically. Call it with no name ({"name": ""}) to list the available configurations.',
  usage: '{"name": "site"}',
  sideEffect: 'exec',
  available: fsAvailable,
  async run(input, ctx) {
    const cwd = ctx.workspaceDir ? resolve(ctx.workspaceDir) : undefined
    if (!cwd) return 'run_launch: no working folder is set.'
    const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).name : undefined
    const name = typeof raw === 'string' ? raw.trim() : ''

    const configs = readLaunchConfigs(cwd)
    if (configs.length === 0) {
      return (
        'run_launch: no .myto/launch.json in this project (no named run configurations). ' +
        'Use run_dev_server or run_command instead, or create .myto/launch.json with a ' +
        '{"version":"0.0.1","configurations":[...]} block.'
      )
    }
    if (!name) {
      return (
        'Available run configurations:\n' +
        configs
          .map(
            (c) =>
              `- ${c.name}: ${c.runtimeExecutable} ${c.runtimeArgs.join(' ')}${c.port ? ` (port ${c.port}${c.autoPort === false ? '' : ', auto'})` : ''}`
          )
          .join('\n') +
        '\nCall run_launch again with {"name": "<name>"} to start one.'
      )
    }
    const config = findLaunchConfig(cwd, name)
    if (!config) {
      return `run_launch: no configuration named "${name}". Available: ${configs.map((c) => c.name).join(', ')}.`
    }

    // Port: honor the declared port; bump to the next free one when auto is on
    // (default) and the port is already taken.
    let port: number | undefined = config.port
    if (port != null && config.autoPort !== false && (await isPortBusy(port))) {
      let candidate = port + 1
      for (let tries = 0; tries < 25 && (await isPortBusy(candidate)); tries++) candidate++
      port = candidate
    }

    const launchCwd = resolveLaunchCwd(cwd, config)
    const command = launchCommand(config, port)
    const note = await startDevServer(command, launchCwd, ctx)
    const where = port != null ? ` (port ${port})` : ''
    return `Started launch config "${config.name}"${where}: ${command}\n${note}\nProject root: ${join(cwd, '.myto')} defines this configuration.`
  }
}
