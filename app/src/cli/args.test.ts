import { describe, it, expect } from 'vitest'
import { parseCliArgs, type ParsedArgs } from './args'

/** Narrow to a successful `run` parse or fail the test with the actual result. */
function run(argv: string[]): Extract<ParsedArgs, { kind: 'run' }> {
  const parsed = parseCliArgs(argv)
  if (parsed.kind !== 'run') throw new Error(`expected run, got ${JSON.stringify(parsed)}`)
  return parsed
}

describe('parseCliArgs — the prompt', () => {
  it('reads -p <value>', () => {
    expect(run(['-p', 'hello']).options.prompt).toBe('hello')
  })

  it('reads --print=<value> inline', () => {
    expect(run(['--print=hello world']).options.prompt).toBe('hello world')
  })

  it('joins bare positionals as the prompt when -p is absent', () => {
    expect(run(['do', 'the', 'thing']).options.prompt).toBe('do the thing')
  })

  it('errors when both -p and a positional are given', () => {
    const parsed = parseCliArgs(['-p', 'x', 'y'])
    expect(parsed.kind).toBe('error')
  })

  it('leaves the prompt empty for a bare -p (the entry then reads stdin)', () => {
    expect(run(['-p']).options.prompt).toBe('')
  })

  it('does not consume a following flag as the -p value', () => {
    const { options } = run(['-p', '--json'])
    expect(options.prompt).toBe('')
    expect(options.json).toBe(true)
  })
})

describe('parseCliArgs — defaults', () => {
  it('applies the documented defaults', () => {
    const { options } = run(['-p', 'x'])
    expect(options).toEqual({
      prompt: 'x',
      permissionMode: 'auto-edit',
      mode: 'code',
      effort: 'medium',
      root: null,
      userDataDir: null,
      json: false
    })
  })
})

describe('parseCliArgs — enum flags', () => {
  it('accepts a valid --permission-mode', () => {
    expect(run(['-p', 'x', '--permission-mode', 'autonomous']).options.permissionMode).toBe(
      'autonomous'
    )
  })

  it('rejects an invalid --permission-mode', () => {
    expect(parseCliArgs(['-p', 'x', '--permission-mode', 'nope']).kind).toBe('error')
  })

  it('accepts --mode=cowork inline', () => {
    expect(run(['-p', 'x', '--mode=cowork']).options.mode).toBe('cowork')
  })

  it('rejects an invalid --mode', () => {
    expect(parseCliArgs(['-p', 'x', '--mode', 'sideways']).kind).toBe('error')
  })

  it('accepts a valid --effort', () => {
    expect(run(['-p', 'x', '--effort', 'high']).options.effort).toBe('high')
  })

  it('rejects an invalid --effort', () => {
    expect(parseCliArgs(['-p', 'x', '--effort', 'ultra']).kind).toBe('error')
  })
})

describe('parseCliArgs — path flags', () => {
  it('accepts -C / --cwd / --root as aliases for the workspace root', () => {
    expect(run(['-p', 'x', '-C', '/a']).options.root).toBe('/a')
    expect(run(['-p', 'x', '--cwd', '/b']).options.root).toBe('/b')
    expect(run(['-p', 'x', '--root', '/c']).options.root).toBe('/c')
  })

  it('errors when the root flag has no value', () => {
    expect(parseCliArgs(['-p', 'x', '--root']).kind).toBe('error')
  })

  it('reads --user-data', () => {
    expect(run(['-p', 'x', '--user-data', '/ud']).options.userDataDir).toBe('/ud')
  })

  it('errors when --user-data has no value', () => {
    expect(parseCliArgs(['-p', 'x', '--user-data']).kind).toBe('error')
  })
})

describe('parseCliArgs — flags and help', () => {
  it('sets --json', () => {
    expect(run(['-p', 'x', '--json']).options.json).toBe(true)
  })

  it('returns help for -h and --help (even alongside other args)', () => {
    expect(parseCliArgs(['-h']).kind).toBe('help')
    expect(parseCliArgs(['--help']).kind).toBe('help')
    expect(parseCliArgs(['-p', 'x', '--help']).kind).toBe('help')
  })

  it('errors on an unknown flag', () => {
    expect(parseCliArgs(['-p', 'x', '--nope']).kind).toBe('error')
  })
})
