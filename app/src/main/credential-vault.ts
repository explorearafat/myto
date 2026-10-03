import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import * as electron from 'electron'
import {
  deserializeCredential,
  envForCommand,
  normalizeInput,
  serializeCredential,
  slugifySite,
  toMeta,
  type StoredCredential
} from './credential-vault-core'
import type { CredentialInput, CredentialMeta } from '../shared/types'

/**
 * The credential vault's ELECTRON half: everything the {@link credential-vault-core}
 * pure module deliberately can't touch — `safeStorage` encryption and the filesystem.
 * It stores one encrypted blob per site under the WORKSPACE's git-ignored `.data/<site>/`
 * folder, so secrets live beside the project they serve, never in the repo, and never in
 * a form the model or renderer can read (reads return {@link CredentialMeta} — names and
 * scopes only, never values).
 *
 * Security posture:
 *  - At rest, a value is only ever `safeStorage.encryptString`'d (DPAPI on Windows). The
 *    ciphertext is per-user/per-machine, so a OneDrive-synced copy on another machine is
 *    undecryptable — acceptable, and {@link ensureGitignored} keeps `.data/` out of git.
 *  - If `safeStorage.isEncryptionAvailable()` is false (e.g. Linux with no keyring),
 *    {@link saveCredential} REFUSES rather than writing plaintext — a hard fail, never a
 *    silent downgrade.
 *  - A decrypt that fails (foreign machine, corrupt blob) degrades that one credential to
 *    "absent" instead of throwing, so the vault stays usable.
 */

/**
 * Overrides where a workspace's credential store lives. Parallels settings.ts's
 * {@link setUserDataDir}: a test injects a resolver so the store lands in a temp dir of
 * its choosing; with nothing injected the store is the workspace's own `.data/` folder.
 */
let rootResolver: ((workspaceDir: string) => string) | null = null

/** Inject (or clear with null) the credential-root resolver. Test seam. */
export function setCredentialRootResolver(fn: ((workspaceDir: string) => string) | null): void {
  rootResolver = fn
}

/** The credential store root for a workspace: the injected resolver, else `<dir>/.data`. */
function credentialRoot(workspaceDir: string): string {
  return rootResolver ? rootResolver(workspaceDir) : join(workspaceDir, '.data')
}

/** The encrypted blob path for one site under a workspace's store. */
function siteFile(workspaceDir: string, site: string): string {
  return join(credentialRoot(workspaceDir), site, 'credential.enc')
}

/**
 * Crash-safe BINARY write (the ciphertext is bytes, not JSON text), mirroring
 * settings.ts's `writeJsonAtomic`: write-temp → fsync → keep a `.bak` of the last good
 * copy → atomic rename. A torn write can never leave a half-encrypted, undecryptable blob.
 */
function writeBytesAtomic(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  } catch {
    // A missing/locked backup must never block saving the real blob.
  }
  renameSync(tmp, path)
}

/** Read a blob's bytes, falling back to its `.bak`; undefined when neither is readable. */
function readBytes(path: string): Buffer | undefined {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      return readFileSync(candidate)
    } catch {
      // Try the backup next; if that also fails the caller treats it as absent.
    }
  }
  return undefined
}

/** Decrypt + parse one site's blob into a {@link StoredCredential}, or null if unreadable. */
function readCredential(workspaceDir: string, site: string): StoredCredential | null {
  const bytes = readBytes(siteFile(workspaceDir, site))
  if (!bytes) return null
  try {
    // decryptString throws on a foreign-machine or corrupt blob — degrade to "absent".
    return deserializeCredential(electron.safeStorage.decryptString(bytes))
  } catch {
    return null
  }
}

/**
 * Every stored credential for a workspace, VALUES INCLUDED — main-process-only, the input
 * to {@link resolveEnvForCommand}. Scans the store root's per-site subfolders, skipping any
 * blob that won't decrypt or parse. Sorted by site for a stable order.
 */
export function listCredentials(workspaceDir: string): StoredCredential[] {
  if (!workspaceDir) return []
  const root = credentialRoot(workspaceDir)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return [] // no store yet
  }
  const creds: StoredCredential[] = []
  for (const site of entries) {
    const cred = readCredential(workspaceDir, site)
    if (cred) creds.push(cred)
  }
  return creds.sort((a, b) => a.site.localeCompare(b.site))
}

/** The model-/renderer-safe metadata for every stored credential (no values). */
export function listCredentialMeta(workspaceDir: string): CredentialMeta[] {
  return listCredentials(workspaceDir).map(toMeta)
}

/**
 * Ensure the project's `.gitignore` ignores the credential store, so an encrypted blob
 * can never be committed. Appends `.data/` only when no existing line already covers it.
 * Best-effort: a write failure (read-only repo, permissions) never blocks saving — the
 * ciphertext is per-machine anyway, so this is defence-in-depth, not the only guard.
 */
export function ensureGitignored(workspaceDir: string): void {
  if (!workspaceDir) return
  const gitignore = join(workspaceDir, '.gitignore')
  try {
    let text = ''
    try {
      text = readFileSync(gitignore, 'utf-8')
    } catch {
      // No .gitignore yet — we'll create one with the entry below.
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    const covered = lines.some((l) => l === '.data' || l === '.data/' || l === '/.data' || l === '/.data/')
    if (covered) return
    const prefix = text.length && !text.endsWith('\n') ? '\n' : ''
    writeFileSync(gitignore, `${text}${prefix}.data/\n`, 'utf-8')
  } catch {
    // Best-effort; the per-machine ciphertext is the real at-rest guard.
  }
}

/**
 * Validate + encrypt + store one credential, then return the updated {@link CredentialMeta}
 * list. REFUSES (throws) when encryption is unavailable — never a plaintext fallback — and
 * throws a readable message when the input is invalid (no site / no usable env var). On
 * success it writes `.data/<site>/credential.enc` atomically and git-ignores the store.
 */
export function saveCredential(workspaceDir: string, input: CredentialInput): CredentialMeta[] {
  if (!workspaceDir) throw new Error('Open a working folder before saving a credential.')
  if (!electron.safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is unavailable on this system, so Myto will not save a credential in plaintext. ' +
        'On Linux this usually means no system keyring (gnome-keyring/kwallet) is running.'
    )
  }
  const normalized = normalizeInput(input)
  if ('error' in normalized) throw new Error(normalized.error)
  const bytes = electron.safeStorage.encryptString(serializeCredential(normalized))
  writeBytesAtomic(siteFile(workspaceDir, normalized.site), bytes)
  ensureGitignored(workspaceDir)
  return listCredentialMeta(workspaceDir)
}

/** Delete one site's credential (its whole `.data/<site>/` folder); return the new list. */
export function deleteCredential(workspaceDir: string, site: string): CredentialMeta[] {
  const slug = slugifySite(site)
  if (workspaceDir && slug) {
    try {
      rmSync(join(credentialRoot(workspaceDir), slug), { recursive: true, force: true })
    } catch {
      // Already gone, or locked — the subsequent list reflects reality either way.
    }
  }
  return listCredentialMeta(workspaceDir)
}

/**
 * The merged env a command should run with: the values of every stored credential whose
 * scopes match a program in `command`. Returns undefined when nothing matches, so a caller
 * can spread it (`{ ...process.env, ...resolveEnvForCommand(...) }`) with no effect in the
 * common no-credential case. This is the ONLY path a secret VALUE leaves the vault, and it
 * leaves only into the child process's env — never argv, never model-facing text.
 */
export function resolveEnvForCommand(
  workspaceDir: string,
  command: string
): NodeJS.ProcessEnv | undefined {
  if (!workspaceDir) return undefined
  const { env } = envForCommand(listCredentials(workspaceDir), command)
  return Object.keys(env).length ? env : undefined
}


