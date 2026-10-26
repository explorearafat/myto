/*
 * Plugins — the CLI's extension point without a runtime dependency chain. A
 * plugin is a JSON manifest in `~/.myto/plugins/` or `<workspace>/.myto/plugins/`
 * that either injects a reusable prompt (`kind: "prompt"`, surfaces as a quick
 * action) or wraps a shell command (`kind: "command"`, run with the output
 * printed). Everything is validated defensively: bad manifests are reported,
 * never thrown.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PluginManifest {
  /** Slug used for display and error reports; [a-z0-9-]. */
  name: string
  title: string
  kind: 'prompt' | 'command'
  /** For prompt plugins: the extra instruction text. */
  prompt?: string
  /** For command plugins: the shell command to run in the workspace. */
  command?: string
  description?: string
}

export type PluginValidation = { ok: true; plugin: PluginManifest } | { ok: false; error: string }

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** Validate one parsed JSON value against the manifest shape. */
export function validatePlugin(raw: unknown): PluginValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not a JSON object' }
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !SLUG.test(r.name)) return { ok: false, error: '"name" must be a slug ([a-z0-9-])' }
  if (typeof r.title !== 'string' || !r.title.trim()) return { ok: false, error: '"title" is required' }
  if (r.kind !== 'prompt' && r.kind !== 'command') return { ok: false, error: '"kind" must be "prompt" or "command"' }
  if (r.kind === 'prompt' && (typeof r.prompt !== 'string' || !r.prompt.trim())) {
    return { ok: false, error: 'prompt plugins need a non-empty "prompt"' }
  }
  if (r.kind === 'command' && (typeof r.command !== 'string' || !r.command.trim())) {
    return { ok: false, error: 'command plugins need a non-empty "command"' }
  }
  const plugin: PluginManifest = {
    name: r.name,
    title: r.title.trim(),
    kind: r.kind,
    description: typeof r.description === 'string' ? r.description : undefined,
    prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    command: typeof r.command === 'string' ? r.command : undefined
  }
  return { ok: true, plugin }
}

export interface PluginScan {
  plugins: PluginManifest[]
  errors: { path: string; error: string }[]
}

/** The directories plugin manifests are discovered in, in load order. */
export function pluginDirs(workspace: string, homeDir: string = homedir()): { dir: string; source: 'user' | 'workspace' }[] {
  return [
    { dir: join(workspace, '.myto', 'plugins'), source: 'workspace' },
    { dir: join(homeDir, '.myto', 'plugins'), source: 'user' }
  ]
}

/** Scan both plugin directories, parsing and validating every .json file. */
export function listPlugins(workspace: string, homeDir?: string): PluginScan {
  const plugins: PluginManifest[] = []
  const errors: { path: string; error: string }[] = []
  const seen = new Set<string>()
  for (const { dir } of pluginDirs(workspace, homeDir)) {
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
    } catch (err) {
      errors.push({ path: dir, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    for (const file of entries) {
      const path = join(dir, file)
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const v = validatePlugin(parsed)
        if (!v.ok) {
          errors.push({ path, error: v.error })
          continue
        }
        if (seen.has(v.plugin.name)) continue
        seen.add(v.plugin.name)
        plugins.push(v.plugin)
      } catch (err) {
        errors.push({ path, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { plugins, errors }
}

/** A starter plugin manifest body — pure so tests can assert it. */
export function pluginTemplate(name: string, title: string): string {
  return (
    JSON.stringify(
      {
        name,
        title,
        kind: 'prompt',
        description: 'What this plugin does.',
        prompt: 'Describe the task for the agent here.'
      },
      null,
      2
    ) + '\n'
  )
}

/** Write a new plugin manifest; returns the path. Throws on IO errors. */
export function savePlugin(workspace: string, name: string, body: string, source: 'user' | 'workspace' = 'user', homeDir?: string): string {
  const dir = pluginDirs(workspace, homeDir).find((d) => d.source === source)!.dir
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name.endsWith('.json') ? name : name + '.json')
  writeFileSync(path, body, 'utf8')
  return path
}
