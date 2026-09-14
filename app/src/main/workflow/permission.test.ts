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
 * The full permission matrix (Principle 7). `auto` = runs without asking (but still
 * surfaced to the UI); `ask` = pauses for an explicit user decision; `block` = refused
 * outright (Plan mode's read-only confinement).
 *
 * | mode         | read | write_file | run_command | mcp_call | web_fetch/search |
 * |--------------|------|------------|-------------|----------|------------------|
 * | `plan`       | auto | block      | block       | block    | block            |
 * | `ask`        | auto | ask        | ask         | ask      | ask              |
 * | `auto-edit`  | auto | auto       | ask         | ask      | ask              |
 * | `autonomous` | auto | auto       | auto        | auto     | auto             |
 *
 * These rows call `decideAuto(mode, kind)` with no command line, so `run_command`
 * takes the plain mode path (the classifier only kicks in when a command line and
 * workspace root are supplied — covered separately below).
 */
const cases: Array<[PermissionMode, ToolKind, 'auto' | 'ask' | 'block']> = [
  ['plan', 'read', 'auto'],
  ['plan', 'write_file', 'block'],
  ['plan', 'run_command', 'block'],
  ['plan', 'mcp_call', 'block'],
  ['plan', 'web_fetch', 'block'],
  ['plan', 'web_search', 'block'],
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

const ALL_MODES: PermissionMode[] = ['plan', 'ask', 'auto-edit', 'autonomous']

describe('decideAuto (permission matrix)', () => {
  it.each(cases)('mode=%s kind=%s → %s', (mode, kind, expected) => {
    expect(decideAuto(mode, kind)).toBe(expected)
  })

  it('never asks about a read, even in the strictest mode', () => {
    // Looking changes nothing, and a dozen approval prompts to understand one
    // file would make the agent unusable. True in Plan mode too — read is the
    // whole point of Plan mode.
    expect(ALL_MODES.map((m) => decideAuto(m, 'read'))).toEqual(['auto', 'auto', 'auto', 'auto'])
  })

  it('auto-approves every side effect when full access is on — except in Plan mode', () => {
    // The opt-in full-PC switch waives the prompt for writes, commands, mcp, and
    // web — in `ask` and `auto-edit` too, not just `autonomous`.
    const execModes: PermissionMode[] = ['ask', 'auto-edit', 'autonomous']
    const kinds: ToolKind[] = ['write_file', 'run_command', 'mcp_call', 'web_fetch', 'web_search']
    for (const mode of execModes) {
      for (const kind of kinds) {
        expect(decideAuto(mode, kind, true)).toBe('auto')
      }
    }
  })

  it('Plan mode blocks every mutation even with full access on', () => {
    // fullAccess waives PROMPTS, not the read-only confinement the user chose by
    // selecting Plan mode. Reads still ride through; everything else is refused.
    const kinds: ToolKind[] = ['write_file', 'run_command', 'mcp_call', 'web_fetch', 'web_search']
    for (const kind of kinds) {
      expect(decideAuto('plan', kind, true)).toBe('block')
    }
    expect(decideAuto('plan', 'read', true)).toBe('auto')
  })

  it('leaves the matrix unchanged when full access is off (explicit false)', () => {
    // Passing the flag as false must behave exactly like omitting it.
    for (const [mode, kind, expected] of cases) {
      expect(decideAuto(mode, kind, false)).toBe(expected)
    }
  })
})

/**
 * Command classification (Principle 7 #2). When a command line and workspace root
 * are supplied, `decideAuto` gates run_command by the command's RISK CLASS × mode:
 *
 *  - destructive → always `ask` (even autonomous / fullAccess), `block` in Plan
 *  - read-only   → `auto` while planning / hands-free / full-access, else `ask`
 *  - mutating    → follows the plain mode path (blocked in Plan)
 */
describe('decideAuto (command classification)', () => {
  const ROOT = '/work/project'

  it('always asks before a destructive command, even hands-free or with full access', () => {
    // Mirrors the browse delete-always-asks rule: rm -rf is never auto.
    expect(decideAuto('ask', 'run_command', false, 'rm -rf build', ROOT)).toBe('ask')
    expect(decideAuto('auto-edit', 'run_command', false, 'rm -rf build', ROOT)).toBe('ask')
    expect(decideAuto('autonomous', 'run_command', false, 'rm -rf build', ROOT)).toBe('ask')
    expect(decideAuto('autonomous', 'run_command', true, 'rm -rf build', ROOT)).toBe('ask')
  })

  it('refuses even a destructive command in Plan mode', () => {
    expect(decideAuto('plan', 'run_command', false, 'rm -rf build', ROOT)).toBe('block')
  })

  it('auto-approves a read-only command while planning, hands-free, or with full access', () => {
    // Observation changes nothing, so it rides the read path.
    expect(decideAuto('plan', 'run_command', false, 'git log --oneline', ROOT)).toBe('auto')
    expect(decideAuto('autonomous', 'run_command', false, 'ls -la', ROOT)).toBe('auto')
    expect(decideAuto('ask', 'run_command', true, 'cat package.json', ROOT)).toBe('auto')
  })

  it('still surfaces a read-only command once in the milder interactive modes', () => {
    // Running a command spawns a process, so ask/auto-edit ask the first time.
    expect(decideAuto('ask', 'run_command', false, 'ls -la', ROOT)).toBe('ask')
    expect(decideAuto('auto-edit', 'run_command', false, 'git status', ROOT)).toBe('ask')
  })

  it('gates a mutating command by the plain mode path', () => {
    // npm install changes state but is not destructive: blocked in Plan, asked in
    // ask/auto-edit, auto only hands-free or with full access.
    expect(decideAuto('plan', 'run_command', false, 'npm install', ROOT)).toBe('block')
    expect(decideAuto('ask', 'run_command', false, 'npm install', ROOT)).toBe('ask')
    expect(decideAuto('auto-edit', 'run_command', false, 'npm install', ROOT)).toBe('ask')
    expect(decideAuto('autonomous', 'run_command', false, 'npm install', ROOT)).toBe('auto')
    expect(decideAuto('ask', 'run_command', true, 'npm install', ROOT)).toBe('auto')
  })

  it('classifies diagnostics the same way when a command line is available', () => {
    // diagnostics normally arrives without a command line (plain mode path), but if
    // one is supplied it is classified like any command.
    expect(decideAuto('autonomous', 'diagnostics', false, 'tsc --noEmit', ROOT)).toBe('auto')
    expect(decideAuto('plan', 'diagnostics', false, 'tsc --noEmit', ROOT)).toBe('auto')
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

  it('full-PC access upgrades click/fill but keeps payment/send/delete gated', () => {
    // The two browser gates that survive full access: money is never spent, and
    // posting/deleting as the user still asks once. Everything milder goes auto,
    // even in `ask` mode.
    expect(decideBrowse('click', DEFAULT_BROWSER_PERMISSIONS, 'ask', true)).toBe('auto')
    expect(decideBrowse('fill', DEFAULT_BROWSER_PERMISSIONS, 'ask', true)).toBe('auto')
    expect(decideBrowse('navigate', DEFAULT_BROWSER_PERMISSIONS, 'ask', true)).toBe('auto')
    expect(decideBrowse('send', DEFAULT_BROWSER_PERMISSIONS, 'ask', true)).toBe('ask')
    expect(decideBrowse('delete', DEFAULT_BROWSER_PERMISSIONS, 'ask', true)).toBe('ask')
    expect(decideBrowse('payment', policy({ payment: 'allow' }), 'ask', true)).toBe('block')
    // An explicit block is still honoured — full access widens, it doesn't override a block.
    expect(decideBrowse('click', policy({ click: 'block' }), 'ask', true)).toBe('block')
  })

  it('auto-send (5th arg) upgrades ONLY send — delete still asks, payment still blocks', () => {
    // The opt-in hands-free-send waiver: with it on, posting/messaging/mailing as
    // the user goes auto instead of asking, in every mode. It is deliberately narrow.
    const modes: PermissionMode[] = ['ask', 'auto-edit', 'autonomous']
    for (const mode of modes) {
      // send is waived...
      expect(decideBrowse('send', DEFAULT_BROWSER_PERMISSIONS, mode, true, true)).toBe('auto')
      // ...but delete still asks and payment still blocks, even hands-free.
      expect(decideBrowse('delete', DEFAULT_BROWSER_PERMISSIONS, mode, true, true)).toBe('ask')
      expect(decideBrowse('payment', policy({ payment: 'allow' }), mode, true, true)).toBe('block')
    }
  })

  it('auto-send waives send without needing full access or a hands-free mode', () => {
    // The two flags are independent inputs to the gate; the *coupling* to full
    // access lives in `autoSendEnabled`, not here. Passed true, send goes auto even
    // in plain `ask` mode with full access off.
    expect(decideBrowse('send', DEFAULT_BROWSER_PERMISSIONS, 'ask', false, true)).toBe('auto')
  })

  it('an explicit send:block still refuses even with auto-send on', () => {
    // Auto-send widens an `ask`; it never overrides a hard block the user set.
    expect(decideBrowse('send', policy({ send: 'block' }), 'ask', true, true)).toBe('block')
  })

  it('leaves send asking when auto-send is off (default 5th arg)', () => {
    // Omitting the flag behaves exactly like passing false — the historical gate.
    expect(decideBrowse('send', DEFAULT_BROWSER_PERMISSIONS, 'autonomous', true)).toBe('ask')
    expect(decideBrowse('send', DEFAULT_BROWSER_PERMISSIONS, 'ask', true, false)).toBe('ask')
  })
})
