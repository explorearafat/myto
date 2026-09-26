import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Folder-selection-free Cowork: a default working folder so the agent can start
 * building the moment the user asks, without first walking them through the native
 * folder picker.
 *
 * Cowork's filesystem tools are still sandboxed to ONE folder (see tools/fs.ts) —
 * this just supplies that folder when the user hasn't chosen a specific one. It
 * lives under the user's Documents so anything Myto creates is easy to find, owned
 * by the user, and well outside the app install. The picker (the composer's folder
 * chip) remains as an explicit override: choosing a folder points Cowork somewhere
 * else, e.g. an existing project they want worked on.
 *
 * The path derivation is a pure function ({@link defaultWorkspaceIn}) so it can be
 * unit-tested without Electron; {@link defaultWorkspaceDir} and
 * {@link ensureDefaultWorkspace} are the thin runtime wrappers that read the real
 * Documents path and create the folder on demand.
 */

/** Leaf name of Myto's default working folder. */
export const DEFAULT_WORKSPACE_NAME = 'Myto'

/** Pure: Myto's default working folder inside a given documents directory. */
export function defaultWorkspaceIn(documentsDir: string): string {
  return join(documentsDir, DEFAULT_WORKSPACE_NAME)
}

/** Myto's default Cowork working folder: `<Documents>/Myto`. */
export function defaultWorkspaceDir(): string {
  return defaultWorkspaceIn(app.getPath('documents'))
}

/**
 * Ensure the default working folder exists and return its absolute path. Creates
 * `<Documents>/Myto` (recursively, a no-op if it already exists) so the caller can
 * hand it straight to the sandboxed fs tools.
 */
export async function ensureDefaultWorkspace(): Promise<string> {
  const dir = defaultWorkspaceDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Fallback leaf name when the user asks Myto to name the folder itself but gives no
 * usable name (blank, or all-illegal characters). Distinct from
 * {@link DEFAULT_WORKSPACE_NAME} so a named-but-unusable answer still lands in its own
 * folder rather than silently colliding with the Documents default.
 */
export const FALLBACK_WORKSPACE_NAME = 'Myto Project'

/** Windows names that can never be a folder leaf, whatever the extension. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

/**
 * Turn a model- or user-supplied folder name into one safe to create on Windows (the
 * strictest target): strip the characters Windows forbids in a path segment
 * (`<>:"/\|?*` and control chars), collapse whitespace, drop the trailing dots/spaces
 * Explorer silently trims, cap the length, and dodge the reserved device names. Pure so
 * it can be unit-tested without Electron. Always returns a non-empty, creatable leaf —
 * {@link FALLBACK_WORKSPACE_NAME} when nothing usable survives.
 */
export function sanitizeWorkspaceName(name: string): string {
  const cleaned = (name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .replace(/[.\s]+$/g, '')
    .trim()
  if (!cleaned) return FALLBACK_WORKSPACE_NAME
  if (RESERVED_NAMES.has(cleaned.toLowerCase())) return FALLBACK_WORKSPACE_NAME
  return cleaned
}

/** Pure: the sanitized workspace folder inside a given desktop directory. */
export function workspaceOnDesktop(desktopDir: string, name: string): string {
  return join(desktopDir, sanitizeWorkspaceName(name))
}

/**
 * The user's real Desktop. `app.getPath('desktop')` honours OneDrive Known-Folder-Move,
 * so on this machine it resolves to `C:\Users\ARAFAT\OneDrive\Desktop` — the folder the
 * user actually sees — not the non-existent `%USERPROFILE%\Desktop`.
 */
export function desktopDir(): string {
  return app.getPath('desktop')
}

/**
 * Create `<Desktop>/<sanitized name>` (recursively; a no-op if it already exists) and
 * return its absolute path. This is the "Myto names and creates the folder itself"
 * path: the agent asks the user for a name and permission, then drops the project on
 * the Desktop where it's immediately visible, no native folder picker involved.
 */
export async function ensureWorkspaceOnDesktop(name: string): Promise<string> {
  const dir = workspaceOnDesktop(desktopDir(), name)
  await mkdir(dir, { recursive: true })
  return dir
}
