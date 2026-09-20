import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

// settings.ts imports `app` from 'electron'; the real package's entry resolves to
// a binary path (and can even trigger a download on import), so we stub it. The
// save/getSettings round-trip tests below actually hit the filesystem through this
// stubbed userData path, so it points at a per-run temp dir (unique by pid) that
// afterAll removes. `vi.hoisted` computes it without top-level-variable capture in
// the hoisted mock factory.
const { USERDATA } = vi.hoisted(() => ({
  USERDATA: `${process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp'}/sylor-settings-test-${process.pid}`
}))
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import { normalise, saveSettings, getSettings, setUserDataDir, setSettingsSavedListener } from '@main/settings'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

const BASE = DEFAULT_PROVIDER_SETTINGS

afterAll(() => {
  try {
    rmSync(USERDATA, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the temp userData dir
  }
})

describe('normalise — provider selection', () => {
  it('defaults to the baseline provider when absent or invalid', () => {
    expect(normalise({}).activeProvider).toBe(BASE.activeProvider)
    expect(normalise({ activeProvider: 'nonsense' }).activeProvider).toBe(BASE.activeProvider)
  })

  it('keeps a valid provider', () => {
    expect(normalise({ activeProvider: 'gateway' }).activeProvider).toBe('gateway')
    expect(normalise({ activeProvider: 'ollama' }).activeProvider).toBe('ollama')
  })
})

describe('normalise — theme (the only UI preference)', () => {
  it('defaults to the baseline theme when absent or invalid', () => {
    expect(normalise({}).ui.theme).toBe(BASE.ui.theme)
    expect(normalise({ ui: { theme: 'neon' } }).ui.theme).toBe(BASE.ui.theme)
  })

  it('keeps a valid theme', () => {
    expect(normalise({ ui: { theme: 'dark' } }).ui.theme).toBe('dark')
    expect(normalise({ ui: { theme: 'light' } }).ui.theme).toBe('light')
  })

  it('carries no agentic ui fields through (plain chatbot)', () => {
    const ui = normalise({
      ui: { theme: 'dark', fullAccess: true, mode: 'code', effort: 'max', workspaceRoot: '/x' }
    }).ui
    expect(ui).toEqual({ theme: 'dark' })
  })
})

describe('normalise — gateway auth', () => {
  it('defaults an invalid auth schema to the baseline', () => {
    expect(normalise({ gateway: { authSchema: 'weird' } }).gateway.authSchema).toBe(
      BASE.gateway.authSchema
    )
  })

  it('keeps a valid auth schema and a non-empty header name', () => {
    const out = normalise({
      gateway: { authSchema: 'header', authHeaderName: 'x-api-key' }
    })
    expect(out.gateway.authSchema).toBe('header')
    expect(out.gateway.authHeaderName).toBe('x-api-key')
  })

  it('falls back to the default header name when blank', () => {
    expect(normalise({ gateway: { authHeaderName: '  ' } }).gateway.authHeaderName).toBe(
      BASE.gateway.authHeaderName
    )
  })
})

describe('normalise — model fields', () => {
  it('keeps string model name/id and drops non-strings', () => {
    const out = normalise({ modelName: 'GPT-4o mini', modelId: 'gpt-4o-mini' })
    expect(out.modelName).toBe('GPT-4o mini')
    expect(out.modelId).toBe('gpt-4o-mini')

    const bad = normalise({ modelName: 42, modelId: null })
    expect(bad.modelName).toBe(BASE.modelName)
    expect(bad.modelId).toBe(BASE.modelId)
  })
})

// The on-disk round-trip through the stubbed userData path: a save normalises and
// persists, and a fresh read (cache cleared) returns exactly the saved shape.
describe('saveSettings / getSettings round-trip', () => {
  beforeEach(() => {
    // Reset the module cache so getSettings re-reads from disk.
    setUserDataDir(USERDATA)
  })

  it('persists a saved value and reads it back after the cache is cleared', () => {
    const saved = saveSettings({
      ...BASE,
      activeProvider: 'gateway',
      modelId: 'gpt-4o-mini',
      modelName: 'GPT-4o mini',
      ui: { theme: 'dark' }
    })
    expect(saved.activeProvider).toBe('gateway')
    expect(saved.ui.theme).toBe('dark')

    setUserDataDir(USERDATA) // drop the cache
    const read = getSettings()
    expect(read.activeProvider).toBe('gateway')
    expect(read.modelId).toBe('gpt-4o-mini')
    expect(read.modelName).toBe('GPT-4o mini')
    expect(read.ui.theme).toBe('dark')
  })

  it('notifies the saved-listener with the normalised value', () => {
    const seen: string[] = []
    setSettingsSavedListener((s) => seen.push(s.ui.theme))
    saveSettings({ ...BASE, ui: { theme: 'light' } })
    expect(seen).toContain('light')
    setSettingsSavedListener(null)
  })
})
