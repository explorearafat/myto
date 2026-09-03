import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { APP_DIR_NAME, defaultUserDataDir, resolveUserDataDir } from './paths'

// `defaultUserDataDir` is pure — platform, env, and home are all injected — so we
// can assert every OS branch from one process. Expected paths are built with the
// same `join` the SUT uses, so the assertions hold regardless of the host
// separator (CI runs on Linux; dev is Windows).
describe('defaultUserDataDir', () => {
  it('win32 uses %APPDATA%\\<app>', () => {
    expect(defaultUserDataDir('win32', { APPDATA: 'C:\\roam' }, 'C:\\home')).toBe(
      join('C:\\roam', APP_DIR_NAME)
    )
  })

  it('win32 falls back to <home>\\AppData\\Roaming when APPDATA is unset', () => {
    expect(defaultUserDataDir('win32', {}, 'C:\\home')).toBe(
      join('C:\\home', 'AppData', 'Roaming', APP_DIR_NAME)
    )
  })

  it('darwin uses ~/Library/Application Support/<app>', () => {
    expect(defaultUserDataDir('darwin', {}, '/Users/a')).toBe(
      join('/Users/a', 'Library', 'Application Support', APP_DIR_NAME)
    )
  })

  it('linux honours $XDG_CONFIG_HOME', () => {
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/a')).toBe(
      join('/xdg', APP_DIR_NAME)
    )
  })

  it('linux falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    expect(defaultUserDataDir('linux', {}, '/home/a')).toBe(
      join('/home/a', '.config', APP_DIR_NAME)
    )
  })

  it('accepts a custom app name', () => {
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/h', 'Other')).toBe(
      join('/xdg', 'Other')
    )
  })
})

describe('resolveUserDataDir', () => {
  afterEach(() => {
    delete process.env.SYLOR_USER_DATA
  })

  it('an explicit flag wins over the env var', () => {
    process.env.SYLOR_USER_DATA = '/from-env'
    expect(resolveUserDataDir('/explicit')).toBe('/explicit')
  })

  it('falls back to SYLOR_USER_DATA when no flag is given', () => {
    process.env.SYLOR_USER_DATA = '/from-env'
    expect(resolveUserDataDir(null)).toBe('/from-env')
  })

  it('ignores a blank/whitespace explicit value', () => {
    process.env.SYLOR_USER_DATA = '/from-env'
    expect(resolveUserDataDir('   ')).toBe('/from-env')
  })

  it('falls through to the platform default when neither is set', () => {
    delete process.env.SYLOR_USER_DATA
    // Only the tail (the app folder) is stable across hosts; the base is OS-specific.
    expect(resolveUserDataDir(null).endsWith(APP_DIR_NAME)).toBe(true)
  })
})
