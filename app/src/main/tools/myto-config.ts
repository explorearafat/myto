import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * `.myto` project configuration — Myto's per-project config files, read from
 * `<workspace>/.myto/`:
 *
 *   launch.json         — named run configurations: how the project runs (the
 *                         command, its working folder, the port). The `run_launch`
 *                         tool starts one; the system prompt advertises the names.
 *   settings.local.json — local permissions. `permissions.allow` entries in the
 *                         `Bash(command-pattern)` style (with `:*` wildcards, like
 *                         agent settings files everywhere) auto-approve matching
 *                         shell commands so the agent stops re-asking for work the
 *                         user has already blessed.
 *   codebase-map.md     — a persisted map of the codebase (written by the
 *                         `map_codebase` tool), injected into the system prompt so
 *                         a big repo is READ ONCE and remembered across sessions.
 *
 * All reads are best-effort: a missing or malformed file simply means "no config".
 */

export interface LaunchConfig {
  name: string
  cwd?: string
  runtimeExecutable: string
  runtimeArgs: string[]
  port?: number
  autoPort?: boolean
}

function mytoDir(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.myto')
}

/** Parse `.myto/launch.json`; [] when missing or malformed. */
export function readLaunchConfigs(workspaceDir: string): LaunchConfig[] {
  try {
    const file = join(mytoDir(workspaceDir), 'launch.json')
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(raw?.configurations) ? raw.configurations : []
    const out: LaunchConfig[] = []
    for (const c of list) {
      if (!c || typeof c !== 'object') continue
      const name = typeof c.name === 'string' ? c.name.trim() : ''
      const exe = typeof c.runtimeExecutable === 'string' ? c.runtimeExecutable.trim() : ''
      if (!name || !exe) continue
      out.push({
        name,
        cwd: typeof c.cwd === 'string' && c.cwd.trim() ? c.cwd.trim() : undefined,
        runtimeExecutable: exe,
        runtimeArgs: Array.isArray(c.runtimeArgs)
          ? c.runtimeArgs.filter((a: unknown): a is string => typeof a === 'string')
          : [],
        port: typeof c.port === 'number' ? c.port : undefined,
        autoPort: typeof c.autoPort === 'boolean' ? c.autoPort : undefined
      })
    }
    return out
  } catch {
    return []
  }
}

export function findLaunchConfig(workspaceDir: string, name: string): LaunchConfig | undefined {
  const needle = name.trim().toLowerCase()
  if (!needle) return undefined
  return readLaunchConfigs(workspaceDir).find((c) => c.name.toLowerCase() === needle)
}

/**
 * The `permissions.allow` patterns from `.myto/settings.local.json`, or [].
 * Entries look like `Bash(npm run dev:*)`; the `Bash(...)` wrapper and `:*`
 * wildcard follow the convention agent config files use everywhere.
 */
export function readAllowPatterns(workspaceDir: string): string[] {
  try {
    const file = join(mytoDir(workspaceDir), 'settings.local.json')
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = raw?.permissions?.allow
    if (!Array.isArray(list)) return []
    return list.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * True when `command` matches one of the allow patterns. Only shell-style
 * entries are considered (`Bash(...)`); anything else (Skill(...), etc.) is
 * ignored — this gates exec tools. `*` is a wildcard; `:*` at the end means
 * "this command plus any arguments", the same way agent settings files mean it.
 * Pure — unit-tested.
 */
export function commandAllowedByPatterns(patterns: string[], command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  for (const raw of patterns) {
    const m = raw.match(/^Bash\(([\s\S]*)\)\s*$/)
    if (!m) continue
    let pat = m[1].trim()
    // Unescape the \( \) \\ forms the settings format uses for literal brackets.
    pat = pat.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
    const wildcard = pat.endsWith(':*')
    if (wildcard) pat = pat.slice(0, -2)
    const rx = new RegExp(
      '^' + pat.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '[\\s\\S]*' : `\\${ch}`)) + (wildcard ? '(?:[\\s\\S]*)' : '') + '$',
      'i'
    )
    if (rx.test(cmd)) return true
  }
  return false
}

/** Convenience: is this command approved by the project's settings.local.json? */
export function commandAllowedBySettings(workspaceDir: string, command: string): boolean {
  if (!workspaceDir) return false
  return commandAllowedByPatterns(readAllowPatterns(workspaceDir), command)
}

/** The cached raw content of `<workspace>/.myto/codebase-map.md`, or ''. */
export function readCodebaseMap(workspaceDir: string, cap = 10_000): string {
  try {
    const file = join(mytoDir(workspaceDir), 'codebase-map.md')
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8')
    return text.length > cap ? text.slice(0, cap) + '\n…[map truncated]' : text
  } catch {
    return ''
  }
}

/** Write (or update) the codebase map. Best-effort; returns success. */
export function writeCodebaseMap(workspaceDir: string, content: string): boolean {
  try {
    const dir = mytoDir(workspaceDir)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'codebase-map.md'), content, 'utf8')
    return true
  } catch {
    return false
  }
}

/** The system-prompt line advertising the launch configs, or '' when none. */
export function launchConfigsPrompt(workspaceDir: string): string {
  const configs = readLaunchConfigs(workspaceDir)
  if (configs.length === 0) return ''
  return (
    'RUN CONFIGURATIONS — this project defines .myto/launch.json entries. To run the app/dev ' +
    'server, call run_launch with {"name": "..."} (it starts the server and opens the preview) ' +
    'instead of guessing the command:\n' +
    configs
      .map(
        (c) =>
          `- ${c.name}: ${c.runtimeExecutable} ${c.runtimeArgs.join(' ')}${c.port ? ` (port ${c.port})` : ''}${
            c.cwd ? ` (cwd: ${c.cwd})` : ''
          }`
      )
      .join('\n')
  )
}

/** Resolve a launch config's cwd (relative entries are anchored at the workspace). */
export function resolveLaunchCwd(workspaceDir: string, config: LaunchConfig): string {
  if (!config.cwd) return resolve(workspaceDir)
  return resolve(workspaceDir, config.cwd)
}
