import { describe, expect, it } from 'vitest'
import type { PermissionMode, ToolKind } from '@shared/types'
import { decideAuto } from '@main/workflow/permission'

/**
 * The full permission matrix. `auto` = runs without asking (but still surfaced
 * to the UI); `ask` = pauses for an explicit user decision.
 *
 * | mode         | read | write_file | run_command | mcp_call |
 * |--------------|------|------------|-------------|----------|
 * | `ask`        | auto | ask        | ask         | ask      |
 * | `auto-edit`  | auto | auto       | ask         | ask      |
 * | `autonomous` | auto | auto       | auto        | auto     |
 */
const cases: Array<[PermissionMode, ToolKind, 'auto' | 'ask']> = [
  ['ask', 'read', 'auto'],
  ['ask', 'write_file', 'ask'],
  ['ask', 'run_command', 'ask'],
  ['ask', 'mcp_call', 'ask'],
  ['auto-edit', 'read', 'auto'],
  ['auto-edit', 'write_file', 'auto'],
  ['auto-edit', 'run_command', 'ask'],
  ['auto-edit', 'mcp_call', 'ask'],
  ['autonomous', 'read', 'auto'],
  ['autonomous', 'write_file', 'auto'],
  ['autonomous', 'run_command', 'auto'],
  ['autonomous', 'mcp_call', 'auto']
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
