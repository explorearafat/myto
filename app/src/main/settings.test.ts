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

import { normalise, getUserProfile, appendUserProfile } from '@main/settings'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

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
