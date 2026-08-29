/**
 * Plugin installer.
 *
 * Turns a user-supplied source (a GitHub repo, a git URL, or a local folder)
 * into installed skills, commands, and connectors, and remembers exactly what it
 * wrote so an uninstall is clean. The flow, mirroring the Claude CLI's plugins:
 *
 *   normalize source → fetch (git clone / local dir) → discover contents →
 *   write each item the normal way (writeSkill / writeCommand / upsertMcpServer)
 *   → record a manifest entry → (git only) delete the temp clone.
 *
 * Artifacts and the manifest both honor the install SCOPE: a `global` install
 * lands in `~/.sylor/*` with its manifest at `~/.sylor/plugins.json`; a `project`
 * install lands in `<root>/.sylor/*` with its manifest at
 * `<root>/.sylor/plugins.json`. `listPlugins` merges the two (project wins by
 * name), exactly like the skills/commands/MCP loaders.
 *
 * Every public call is total — it resolves to a result object rather than
 * throwing — so a bad URL, a missing Git, or an empty repo surfaces as a friendly
 * message. Registry cache invalidation is the caller's job (the IPC layer reloads
 * after a successful mutation); this module only touches disk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ConfigScope,
  InstalledPlugin,
  PluginInstallInput,
  PluginInstallResult
} from '../../shared/types'
import { normalizePluginSource } from './source'
import { discoverPluginContents } from './discover'
import { writeSkill, deleteSkillFile } from '../skills/registry'
import { writeCommand, deleteCommandFile } from '../commands/registry'
import { upsertMcpServer, deleteMcpServer } from '../mcp/config'
import { isGitAvailable, gitClone } from './git'

/** A written skill/command, tracked for clean removal (display name + file path). */
interface WrittenFile {
  name: string
  path: string
}

/** One plugin's on-disk record: what it is, plus handles to undo the install. */
interface PluginManifestEntry {
  name: string
  source: string
  scope: ConfigScope
  installedAt: number
  skills: WrittenFile[]
  commands: WrittenFile[]
  /** MCP server names (removed by name via {@link deleteMcpServer}). */
  connectors: string[]
}

// --- manifest paths (beside the artifacts, per scope) ----------------------

function globalManifestPath(): string {
  return join(homedir(), '.sylor', 'plugins.json')
}
function projectManifestPath(projectRoot: string): string {
  return join(projectRoot, '.sylor', 'plugins.json')
}
function manifestPathForScope(scope: ConfigScope, projectRoot: string | null): string {
  if (scope === 'project') {
    if (!projectRoot) throw new Error('Open a project folder first to install a project plugin.')
    return projectManifestPath(projectRoot)
  }
  return globalManifestPath()
}

// --- manifest read/write (defensive) ---------------------------------------

function readManifest(path: string): PluginManifestEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const list = (parsed as { plugins?: unknown })?.plugins
    return Array.isArray(list) ? (list as PluginManifestEntry[]) : []
  } catch {
    return []
  }
}

function writeManifest(path: string, entries: PluginManifestEntry[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ plugins: entries }, null, 2)}\n`, 'utf-8')
}

/** Shapes a manifest entry into the public, display-only view. */
function toPublic(entry: PluginManifestEntry): InstalledPlugin {
  return {
    name: entry.name,
    source: entry.source,
    scope: entry.scope,
    installedAt: entry.installedAt,
    contents: {
      skills: entry.skills.map((s) => s.name),
      commands: entry.commands.map((c) => c.name),
      connectors: [...entry.connectors]
    }
  }
}

/**
 * Lists installed plugins from the global + project manifests, project winning on
 * a name clash (matching the loaders' precedence).
 */
export function listPlugins(projectRoot: string | null): InstalledPlugin[] {
  const merged = new Map<string, PluginManifestEntry>()
  for (const e of readManifest(globalManifestPath())) merged.set(e.name, e)
  if (projectRoot) {
    for (const e of readManifest(projectManifestPath(projectRoot))) merged.set(e.name, e)
  }
  return [...merged.values()].map(toPublic)
}

// --- removal ----------------------------------------------------------------

/** Deletes every artifact a manifest entry wrote (best-effort; never throws). */
function deleteArtifacts(entry: PluginManifestEntry, projectRoot: string | null): void {
  for (const s of entry.skills) {
    try {
      deleteSkillFile(s.path)
    } catch {
      /* already gone */
    }
  }
  for (const c of entry.commands) {
    try {
      deleteCommandFile(c.path)
    } catch {
      /* already gone */
    }
  }
  for (const name of entry.connectors) {
    try {
      deleteMcpServer(name, projectRoot)
    } catch {
      /* already gone */
    }
  }
}

/**
 * Uninstalls a plugin by name: deletes its skills/commands/connectors and drops
 * its manifest entry (from whichever scope holds it). Returns the remaining
 * plugins. A no-op for an unknown name.
 */
export function removePlugin(name: string, projectRoot: string | null): InstalledPlugin[] {
  const paths = [globalManifestPath(), ...(projectRoot ? [projectManifestPath(projectRoot)] : [])]
  for (const path of paths) {
    const entries = readManifest(path)
    const idx = entries.findIndex((e) => e.name === name)
    if (idx === -1) continue
    deleteArtifacts(entries[idx], projectRoot)
    entries.splice(idx, 1)
    writeManifest(path, entries)
  }
  return listPlugins(projectRoot)
}

/** Removes a temp clone dir, swallowing errors (best-effort cleanup). */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

// --- install ----------------------------------------------------------------

/**
 * Installs a plugin from `input.source` at `input.scope`. Clones a git source to
 * a temp dir (removed afterward) or reads a local folder in place, discovers its
 * skills/commands/connectors, writes each into the chosen scope, and records a
 * manifest entry so {@link removePlugin} can undo it. Reinstalling the same name
 * replaces the prior copy. Resolves `{ ok:false, error }` on any failure.
 */
export async function installPlugin(
  input: PluginInstallInput,
  projectRoot: string | null,
  signal?: AbortSignal
): Promise<PluginInstallResult> {
  const source = normalizePluginSource(input.source)
  if (!source.ok) return { ok: false, error: source.error, plugins: listPlugins(projectRoot) }

  if (input.scope === 'project' && !projectRoot) {
    return {
      ok: false,
      error: 'Open a project folder first to install a project plugin.',
      plugins: listPlugins(projectRoot)
    }
  }

  // Resolve a content directory: clone a git source, or read a local folder.
  let dir: string
  let tempClone: string | null = null
  if (source.kind === 'git') {
    if (!(await isGitAvailable())) {
      return {
        ok: false,
        error: 'Git is required to install from a repository, but it was not found on PATH.',
        plugins: listPlugins(projectRoot)
      }
    }
    tempClone = mkdtempSync(join(tmpdir(), 'sylor-plugin-'))
    dir = join(tempClone, 'repo')
    const cloned = await gitClone(source.url, dir, signal)
    if (!cloned.ok) {
      cleanup(tempClone)
      return { ok: false, error: cloned.error, plugins: listPlugins(projectRoot) }
    }
  } else {
    dir = source.path
  }

  try {
    const found = discoverPluginContents(dir, source.name)
    const total = found.skills.length + found.commands.length + found.mcpServers.length
    if (total === 0) {
      return {
        ok: false,
        error: 'No skills, commands, or connectors were found at that source.',
        plugins: listPlugins(projectRoot)
      }
    }

    // Idempotent reinstall: clear a prior copy of this name in the target scope.
    const manifestPath = manifestPathForScope(input.scope, projectRoot)
    const existing = readManifest(manifestPath)
    const prior = existing.find((e) => e.name === source.name)
    if (prior) deleteArtifacts(prior, projectRoot)
    const others = existing.filter((e) => e.name !== source.name)

    // Write each item the normal way, tracking handles for a clean uninstall.
    const written: PluginManifestEntry = {
      name: source.name,
      source: input.source.trim(),
      scope: input.scope,
      installedAt: Date.now(),
      skills: [],
      commands: [],
      connectors: []
    }
    try {
      for (const skill of found.skills) {
        written.skills.push({ name: skill.name, path: writeSkill(skill, input.scope, projectRoot) })
      }
      for (const command of found.commands) {
        written.commands.push({
          name: command.name,
          path: writeCommand(command, input.scope, projectRoot)
        })
      }
      for (const [name, config] of found.mcpServers) {
        upsertMcpServer(name, config, input.scope, projectRoot)
        written.connectors.push(name)
      }
    } catch (err) {
      // A mid-write failure → roll back the partial install, leave no orphans.
      deleteArtifacts(written, projectRoot)
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to write plugin contents.',
        plugins: listPlugins(projectRoot)
      }
    }

    writeManifest(manifestPath, [...others, written])
    return { ok: true, plugin: toPublic(written), plugins: listPlugins(projectRoot) }
  } finally {
    if (tempClone) cleanup(tempClone)
  }
}





