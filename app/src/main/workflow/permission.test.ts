import { describe, expect, it } from 'vitest'
import type {
  BrowserAction,
  BrowserPermissions,
  PermissionMode,
  ToolKind
} from '@shared/types'
import { DEFAULT_BROWSER_PERMISSIONS } from '@shared/defaults'
import { decideAuto, decideBrowse } from '@main/workflow/permission'

/**
 * The full permission matrix. `auto` = runs without asking (but still surfaced
 * to the UI); `ask` = pauses for an explicit user decision.
 *
 * | mode         | read | write_file | run_command | mcp_call | web_fetch/search |
 * |--------------|------|------------|-------------|----------|------------------|
 * | `ask`        | auto | ask        | ask         | ask      | ask              |
 * | `auto-edit`  | auto | auto       | ask         | ask      | ask              |
 * | `autonomous` | auto | auto       | auto        | auto     | auto             |
 */
const cases: Array<[PermissionMode, ToolKind, 'auto' | 'ask']> = [
  ['ask', 'read', 'auto'],
  ['ask', 'write_file', 'ask'],
  ['ask', 'run_command', 'ask'],
  ['ask', 'mcp_call', 'ask'],
  ['ask', 'web_fetch', 'ask'],
  ['ask', 'web_search', 'ask'],
  ['auto-edit', 'read', 'auto'],
  ['auto-edit', 'write_file', 'auto'],
  ['auto-edit', 'run_command', 'ask'],
  ['auto-edit', 'mcp_call', 'ask'],
  ['auto-edit', 'web_fetch', 'ask'],
  ['auto-edit', 'web_search', 'ask'],
  ['autonomous', 'read', 'auto'],
  ['autonomous', 'write_file', 'auto'],
  ['autonomous', 'run_command', 'auto'],
  ['autonomous', 'mcp_call', 'auto'],
  ['autonomous', 'web_fetch', 'auto'],
  ['autonomous', 'web_search', 'auto']
]

describe('decideAuto (permission matrix)', () => {
  it.each(cases)('mode=%s kind=%s → %s', (mode, kind, expected) => {
    expect(decideAuto(mode, kind)).toBe(expected)
  })

  it('never asks about a read, even in the strictest mode', () => {
    // Looking changes nothing, and a dozen approval prompts to understand one
    // file would make the agent unusable.
    const modes: PermissionMode[] = ['ask', 'auto-edit', 'autonomous']
    expect(modes.map((m) => decideAuto(m, 'read'))).toEqual(['auto', 'auto', 'auto'])
  })
})

/**
 * The browsing gate. Keyed on the RISK CLASS the engine classified the step as,
 * and authoritative over the run's permission mode — three rules cannot be
 * configured away: payment always blocks, send/delete always ask, and
 * `autonomous` may only upgrade click/fill.
 *
 * | risk     | default | allow | block | autonomous + default |
 * |----------|---------|-------|-------|----------------------|
 * | read     | auto    | auto  | block | auto                 |
 * | navigate | auto    | auto  | block | auto                 |
 * | click    | ask     | auto  | block | auto                 |
 * | fill     | ask     | auto  | block | auto                 |
 * | send     | ask     | ask   | block | ask                  |
 * | delete   | ask     | ask   | block | ask                  |
 * | payment  | block   | block | block | block                |
 */
describe('decideBrowse (browsing gate)', () => {
  /** The user's policy with one class overridden. */
  const policy = (over: Partial<BrowserPermissions>): BrowserPermissions => ({
    ...DEFAULT_BROWSER_PERMISSIONS,
    ...over
  })
  const risks: BrowserAction[] = ['read', 'navigate', 'click', 'fill', 'send', 'delete', 'payment']

  it.each([
    ['read', 'auto'],
    ['navigate', 'auto'],
    ['click', 'ask'],
    ['fill', 'ask'],
    ['send', 'ask'],
    ['delete', 'ask'],
    ['payment', 'block']
  ] as Array<[BrowserAction, 'auto' | 'ask' | 'block']>)(
    'default policy: %s → %s',
    (risk, expected) => {
      expect(decideBrowse(risk)).toBe(expected)
    }
  )

  it('falls back to the defaults when no policy has been saved yet', () => {
    expect(risks.map((r) => decideBrowse(r))).toEqual(
      risks.map((r) => decideBrowse(r, DEFAULT_BROWSER_PERMISSIONS))
    )
  })

  it('refuses payment however the policy is set, in every mode', () => {
    // Sylor never spends the user's money — not on `allow`, not hands-free.
    const modes: PermissionMode[] = ['ask', 'auto-edit', 'autonomous']
    for (const mode of modes) {
      expect(decideBrowse('payment', policy({ payment: 'allow' }), mode)).toBe('block')
    }
  })

  it('still asks before sending or deleting even when the user allowed them', () => {
    // Posting as the user or destroying their data is not something to discover
    // after the fact, so `allow` is deliberately not honoured here.
    expect(decideBrowse('send', policy({ send: 'allow' }))).toBe('ask')
    expect(decideBrowse('delete', policy({ delete: 'allow' }))).toBe('ask')
    expect(decideBrowse('send', policy({ send: 'allow' }), 'autonomous')).toBe('ask')
    expect(decideBrowse('delete', policy({ delete: 'allow' }), 'autonomous')).toBe('ask')
  })

  it('honours an explicit block on anything, including a mere read', () => {
    expect(decideBrowse('read', policy({ read: 'block' }))).toBe('block')
    expect(decideBrowse('navigate', policy({ navigate: 'block' }), 'autonomous')).toBe('block')
    expect(decideBrowse('click', policy({ click: 'block' }), 'autonomous')).toBe('block')
  })

  it('lets autonomous skip the prompt for click and fill only', () => {
    // A hands-free run has to be able to work through a site; it still cannot
    // send, delete or pay.
    expect(decideBrowse('click', DEFAULT_BROWSER_PERMISSIONS, 'autonomous')).toBe('auto')
    expect(decideBrowse('fill', DEFAULT_BROWSER_PERMISSIONS, 'autonomous')).toBe('auto')
    expect(decideBrowse('send', DEFAULT_BROWSER_PERMISSIONS, 'autonomous')).toBe('ask')
    expect(decideBrowse('delete', DEFAULT_BROWSER_PERMISSIONS, 'autonomous')).toBe('ask')
    // ...and the milder modes still ask.
    expect(decideBrowse('click', DEFAULT_BROWSER_PERMISSIONS, 'auto-edit')).toBe('ask')
    expect(decideBrowse('fill', DEFAULT_BROWSER_PERMISSIONS, 'ask')).toBe('ask')
  })

  it('treats an allowed click/fill as auto in every mode', () => {
    expect(decideBrowse('click', policy({ click: 'allow' }))).toBe('auto')
    expect(decideBrowse('fill', policy({ fill: 'allow' }), 'ask')).toBe('auto')
  })
})
