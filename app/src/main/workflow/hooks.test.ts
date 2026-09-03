import { describe, it, expect, vi } from 'vitest'
import { hookMatches, matchHooks, runHooks, DEFAULT_HOOK_TIMEOUT_MS } from '@main/workflow/hooks'
import type { HookCommandRunner } from '@main/workflow/hooks'
import type { HooksConfig } from '@shared/types'

/** A runner that returns a fixed exit code, recording every call for assertions. */
function fakeRunner(exitCode: number | null, output = ''): HookCommandRunner {
  return vi.fn(async () => ({ exitCode, output }))
}

describe('hookMatches', () => {
  it('matches every tool for an empty, absent, or wildcard matcher', () => {
    expect(hookMatches(undefined, 'write_file')).toBe(true)
    expect(hookMatches('', 'run_command')).toBe(true)
    expect(hookMatches('*', 'anything')).toBe(true)
  })

  it('treats the matcher as a regex tested against the tool name', () => {
    expect(hookMatches('write_file|edit_file', 'edit_file')).toBe(true)
    expect(hookMatches('write_file|edit_file', 'read_file')).toBe(false)
    expect(hookMatches('^run_command$', 'run_command')).toBe(true)
    expect(hookMatches('file', 'write_file')).toBe(true) // unanchored substring
  })

  it('falls back to an exact compare when the regex is invalid', () => {
    // An unbalanced group is not a valid RegExp; exact-equality keeps it usable.
    expect(hookMatches('write_file(', 'write_file(')).toBe(true)
    expect(hookMatches('write_file(', 'write_file')).toBe(false)
  })
})

describe('matchHooks', () => {
  const config: HooksConfig = {
    PreToolUse: [
      { matcher: 'write_file|edit_file', command: 'guard-writes' },
      { command: 'guard-all' } // no matcher → all tools
    ],
    Stop: [{ matcher: 'write_file', command: 'on-stop' }]
  }

  it('filters tool-event hooks by matcher against the tool name', () => {
    expect(matchHooks(config, 'PreToolUse', 'write_file').map((d) => d.command)).toEqual([
      'guard-writes',
      'guard-all'
    ])
    expect(matchHooks(config, 'PreToolUse', 'read_file').map((d) => d.command)).toEqual([
      'guard-all'
    ])
  })

  it('ignores the matcher for non-tool events (Stop/UserPromptSubmit)', () => {
    // The Stop hook has a matcher, but Stop has no tool — every Stop hook applies.
    expect(matchHooks(config, 'Stop').map((d) => d.command)).toEqual(['on-stop'])
  })

  it('returns nothing when the event has no configured hooks', () => {
    expect(matchHooks(config, 'PostToolUse', 'write_file')).toEqual([])
    expect(matchHooks(undefined, 'PreToolUse', 'write_file')).toEqual([])
  })
})

describe('runHooks — PreToolUse blocking', () => {
  const config: HooksConfig = { PreToolUse: [{ command: 'gate' }] }

  it('blocks the tool when a PreToolUse hook exits non-zero', async () => {
    const run = fakeRunner(2, 'nope: dangerous command')
    const outcome = await runHooks(config, 'PreToolUse', { env: {} }, run)
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('nope: dangerous command')
    expect(outcome.ran).toBe(1)
  })

  it('allows the tool when the PreToolUse hook exits zero', async () => {
    const outcome = await runHooks(config, 'PreToolUse', { env: {} }, fakeRunner(0))
    expect(outcome.blocked).toBe(false)
    expect(outcome.ran).toBe(1)
  })

  it('treats a null exit (timeout/abort) as a block (fail-closed)', async () => {
    const outcome = await runHooks(config, 'PreToolUse', { env: {} }, fakeRunner(null))
    expect(outcome.blocked).toBe(true)
  })

  it('synthesizes a reason from the command when the hook printed nothing', async () => {
    const outcome = await runHooks(config, 'PreToolUse', { env: {} }, fakeRunner(1, '  '))
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toContain('gate')
  })

  it('short-circuits: a blocking hook stops later pre-hooks from running', async () => {
    const run = vi
      .fn<HookCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 1, output: 'deny' })
      .mockResolvedValueOnce({ exitCode: 0, output: 'never runs' })
    const twoHooks: HooksConfig = {
      PreToolUse: [{ command: 'first' }, { command: 'second' }]
    }
    const outcome = await runHooks(twoHooks, 'PreToolUse', { env: {} }, run)
    expect(outcome.blocked).toBe(true)
    expect(outcome.ran).toBe(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('passes the base env and per-hook timeout (default when unset) to the runner', async () => {
    const run = fakeRunner(0)
    await runHooks(
      { PreToolUse: [{ command: 'gate' }, { command: 'slow', timeoutMs: 500 }] },
      'PreToolUse',
      { env: { SYLOR_TOOL_NAME: 'write_file' }, toolName: 'write_file' },
      run
    )
    expect(run).toHaveBeenNthCalledWith(
      1,
      'gate',
      { SYLOR_TOOL_NAME: 'write_file' },
      DEFAULT_HOOK_TIMEOUT_MS
    )
    expect(run).toHaveBeenNthCalledWith(2, 'slow', { SYLOR_TOOL_NAME: 'write_file' }, 500)
  })
})

describe('runHooks — non-blocking events', () => {
  it('never blocks on PostToolUse even when the hook fails', async () => {
    const run = fakeRunner(1, 'formatter error')
    const outcome = await runHooks(
      { PostToolUse: [{ command: 'prettier' }] },
      'PostToolUse',
      { toolName: 'write_file', env: {} },
      run
    )
    expect(outcome.blocked).toBe(false)
    expect(outcome.ran).toBe(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs every Stop hook and reports none blocked', async () => {
    const run = fakeRunner(3)
    const outcome = await runHooks(
      { Stop: [{ command: 'notify-a' }, { command: 'notify-b' }] },
      'Stop',
      { env: {} },
      run
    )
    expect(outcome.blocked).toBe(false)
    expect(outcome.ran).toBe(2)
  })

  it('does nothing (ran: 0) when no hooks match', async () => {
    const run = fakeRunner(1)
    const outcome = await runHooks({}, 'PreToolUse', { toolName: 'read_file', env: {} }, run)
    expect(outcome).toEqual({ blocked: false, ran: 0 })
    expect(run).not.toHaveBeenCalled()
  })
})
