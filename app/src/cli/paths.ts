import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolving the per-user data directory for the headless CLI.
 *
 * A `sylor -p "…"` run should read the SAME settings, model, DB, and memory the
 * installed GUI wrote, so it "just works" with whatever the user configured in
 * the app. Electron computes that folder as
 * `join(app.getPath('appData'), app.getName())`; here we reproduce the same path
 * from plain Node so the CLI needs no Electron runtime. The app name matches the
 * packaged build's `productName` (electron-builder.yml → "Sylor"), which is what
 * `app.getName()` returns in the shipped app.
 *
 * Everything is overridable: an explicit `--user-data` flag wins, then the
 * `SYLOR_USER_DATA` env var (handy for tests and CI sandboxes), then this default.
 */

/** Packaged app name (electron-builder `productName`) — the GUI's userData folder. */
export const APP_DIR_NAME = 'Sylor'

/**
 * The default per-user data directory for `platform`, computed the way Electron's
 * `app.getPath('userData')` would. Pure — all environment is passed in — so it is
 * unit-testable across every platform from one Node process.
 *
 * - win32:  `%APPDATA%\<app>`                    (Roaming)
 * - darwin: `~/Library/Application Support/<app>`
 * - linux:  `$XDG_CONFIG_HOME/<app>` else `~/.config/<app>`
 */
export function defaultUserDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  appName: string = APP_DIR_NAME
): string {
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), appName)
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', appName)
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), appName)
}

/**
 * Resolve the userData directory to use for a headless run. Precedence:
 * explicit `--user-data` flag → `SYLOR_USER_DATA` env → the Electron-matching
 * default. Never throws.
 */
export function resolveUserDataDir(explicit: string | null): string {
  if (explicit && explicit.trim()) return explicit
  const fromEnv = process.env.SYLOR_USER_DATA
  if (fromEnv && fromEnv.trim()) return fromEnv
  return defaultUserDataDir(process.platform, process.env, homedir())
}
