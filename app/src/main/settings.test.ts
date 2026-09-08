import { afterAll, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

// settings.ts imports `app` from 'electron'; the real package's entry resolves to
// a binary path (and can even trigger a download on import), so we stub it. The
// user-profile tests below actually hit the filesystem through this stubbed
// userData path, so it points at a per-run temp dir (unique by pid) that afterAll
// removes. `vi.hoisted` computes it without top-level-variable capture in the
// hoisted mock factory.
const { USERDATA } = vi.hoisted(() => ({
  USERDATA: `${process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp'}/sylor-settings-test-${process.pid}`
}))
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import {
  normalise,
  getUserProfile,
  appendUserProfile,
  saveSettings,
  fullAccessEnabled,
  autoSendEnabled
} from '@main/settings'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

const BASE = DEFAULT_PROVIDER_SETTINGS

afterAll(() => {
  try {
    rmSync(USERDATA, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the temp userData dir
  }
})

describe('normalise — workspaceRoot (requirement A)', () => {
  it('keeps a non-empty workspaceRoot string', () => {
    const out = normalise({ ui: { workspaceRoot: 'C:\\Users\\me\\proj' } })
    expect(out.ui.workspaceRoot).toBe('C:\\Users\\me\\proj')
  })

  it('drops a blank or whitespace-only workspaceRoot (Code mode stays gated)', () => {
    expect(normalise({ ui: { workspaceRoot: '' } }).ui.workspaceRoot).toBeUndefined()
    expect(normalise({ ui: { workspaceRoot: '   ' } }).ui.workspaceRoot).toBeUndefined()
  })

  it('drops a non-string workspaceRoot', () => {
    expect(normalise({ ui: { workspaceRoot: 42 } }).ui.workspaceRoot).toBeUndefined()
    expect(normalise({ ui: { workspaceRoot: null } }).ui.workspaceRoot).toBeUndefined()
  })

  it('omits workspaceRoot entirely when absent (not persisted as undefined)', () => {
    const out = normalise({ ui: {} })
    expect('workspaceRoot' in out.ui).toBe(false)
  })

  it('preserves the other ui defaults alongside a chosen workspaceRoot', () => {
    const out = normalise({ ui: { workspaceRoot: '/work' } })
    expect(out.ui).toMatchObject({
      theme: DEFAULT_PROVIDER_SETTINGS.ui.theme,
      effort: DEFAULT_PROVIDER_SETTINGS.ui.effort,
      planFirst: DEFAULT_PROVIDER_SETTINGS.ui.planFirst,
      mode: DEFAULT_PROVIDER_SETTINGS.ui.mode,
      workspaceRoot: '/work'
    })
  })
})

describe('normalise — fullAccess (opt-in full-PC access)', () => {
  it('defaults to false when absent', () => {
    expect(normalise({ ui: {} }).ui.fullAccess).toBe(false)
    expect(normalise({}).ui.fullAccess).toBe(false)
  })

  it('keeps an explicit boolean', () => {
    expect(normalise({ ui: { fullAccess: true } }).ui.fullAccess).toBe(true)
    expect(normalise({ ui: { fullAccess: false } }).ui.fullAccess).toBe(false)
  })

  it('ignores a non-boolean and falls back to the safe default', () => {
    expect(normalise({ ui: { fullAccess: 'yes' } }).ui.fullAccess).toBe(false)
    expect(normalise({ ui: { fullAccess: 1 } }).ui.fullAccess).toBe(false)
    expect(normalise({ ui: { fullAccess: null } }).ui.fullAccess).toBe(false)
  })
})

describe('normalise — autoSend (opt-in hands-free sending)', () => {
  it('defaults to false when absent', () => {
    expect(normalise({ ui: {} }).ui.autoSend).toBe(false)
    expect(normalise({}).ui.autoSend).toBe(false)
  })

  it('keeps an explicit boolean', () => {
    expect(normalise({ ui: { autoSend: true } }).ui.autoSend).toBe(true)
    expect(normalise({ ui: { autoSend: false } }).ui.autoSend).toBe(false)
  })

  it('ignores a non-boolean and falls back to the safe default', () => {
    expect(normalise({ ui: { autoSend: 'yes' } }).ui.autoSend).toBe(false)
    expect(normalise({ ui: { autoSend: 1 } }).ui.autoSend).toBe(false)
    expect(normalise({ ui: { autoSend: null } }).ui.autoSend).toBe(false)
  })

  it('is independent of fullAccess in storage (coupling lives in autoSendEnabled)', () => {
    // normalise just persists the raw switch; the "only while full access" rule is
    // enforced at read time, not by scrubbing the stored value.
    const out = normalise({ ui: { fullAccess: false, autoSend: true } })
    expect(out.ui.fullAccess).toBe(false)
    expect(out.ui.autoSend).toBe(true)
  })
})

// The read-time coupling: auto-send is a sub-permission of full access, so
// `autoSendEnabled()` is true ONLY when both switches are on. These persist through
// the real on-disk store (the stubbed userData path) and read it back.
describe('autoSendEnabled / fullAccessEnabled (read-time coupling)', () => {
  const save = (ui: Partial<(typeof BASE)['ui']>): void => {
    saveSettings({ ...BASE, ui: { ...BASE.ui, ...ui } })
  }

  it('auto-send is off unless BOTH full access and auto-send are on', () => {
    save({ fullAccess: false, autoSend: false })
    expect(autoSendEnabled()).toBe(false)

    save({ fullAccess: false, autoSend: true })
    expect(autoSendEnabled()).toBe(false) // auto-send alone is inert

    save({ fullAccess: true, autoSend: false })
    expect(autoSendEnabled()).toBe(false)

    save({ fullAccess: true, autoSend: true })
    expect(autoSendEnabled()).toBe(true)
  })

  it('fullAccessEnabled tracks just the full-access switch', () => {
    save({ fullAccess: true, autoSend: false })
    expect(fullAccessEnabled()).toBe(true)
    save({ fullAccess: false, autoSend: true })
    expect(fullAccessEnabled()).toBe(false)
  })
})

// The global, cross-project user profile: what Sylor learns about the person so
// it gets more useful over time. These run in order and share the same on-disk
// file + module cache (the store is append-only), so the assertions build on one
// another rather than resetting between cases.
describe('user profile (global cross-project memory)', () => {
  it('starts empty, records a fact, and returns it as a prompt bullet', () => {
    expect(getUserProfile()).toBe('')
    expect(appendUserProfile('Prefers clean minimal sites')).toBe(true)
    expect(getUserProfile()).toBe('- Prefers clean minimal sites')
  })

  it('dedupes case-insensitively and ignores blank notes', () => {
    expect(appendUserProfile('prefers CLEAN minimal sites')).toBe(false)
    expect(appendUserProfile('   ')).toBe(false)
    expect(getUserProfile()).toBe('- Prefers clean minimal sites')
  })

  it('collapses inner whitespace when recording a fact', () => {
    expect(appendUserProfile('Uses   a   serif\nfor headings')).toBe(true)
    expect(getUserProfile()).toBe('- Prefers clean minimal sites\n- Uses a serif for headings')
  })

  it('accumulates multiple distinct facts append-only', () => {
    expect(appendUserProfile('Name is Arafat')).toBe(true)
    expect(getUserProfile()).toBe(
      '- Prefers clean minimal sites\n- Uses a serif for headings\n- Name is Arafat'
    )
  })
})
