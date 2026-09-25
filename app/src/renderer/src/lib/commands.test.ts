import { describe, it, expect } from 'vitest'
import {
  SLASH_COMMANDS,
  matchSlashCommands,
  findCommand,
  detectTrigger,
  parseSlashInput,
  applyCompletion
} from './commands'

describe('slash command catalogue', () => {
  it('matches by typed prefix, and a bare slash lists everything', () => {
    expect(matchSlashCommands('')).toHaveLength(SLASH_COMMANDS.length)
    expect(matchSlashCommands('cl').map((c) => c.id)).toEqual(['clear'])
    expect(matchSlashCommands('zzz')).toEqual([])
  })

  it('looks up a command case-insensitively', () => {
    expect(findCommand('CLEAR')?.id).toBe('clear')
    expect(findCommand('nope')).toBeUndefined()
  })
})

describe('detectTrigger', () => {
  it('fires a slash trigger only at the very start, while typing the command word', () => {
    expect(detectTrigger('/cl', 3)).toEqual({ kind: 'slash', query: 'cl', start: 0, end: 3 })
    // Past the space → typing the argument, not the command: no popover.
    expect(detectTrigger('/verify npm test', 16)).toBeNull()
    // A slash mid-word is not a command.
    expect(detectTrigger('and/or', 6)).toBeNull()
  })

  it('fires a mention on an @ at a word boundary with no trailing space', () => {
    expect(detectTrigger('see @src/a', 10)).toEqual({ kind: 'mention', query: 'src/a', start: 4, end: 10 })
    expect(detectTrigger('@', 1)).toEqual({ kind: 'mention', query: '', start: 0, end: 1 })
    // An @ inside a token (email) is not a mention.
    expect(detectTrigger('foo@bar', 7)).toBeNull()
    // A completed mention followed by a space stops triggering.
    expect(detectTrigger('@src/a ', 7)).toBeNull()
  })
})

describe('parseSlashInput (submit fast-path)', () => {
  it('splits a whole command line into command + trimmed arg', () => {
    expect(parseSlashInput('/clear')).toMatchObject({ command: { id: 'clear' }, arg: '' })
    expect(parseSlashInput('/verify  npm run test ')).toMatchObject({
      command: { id: 'verify' },
      arg: 'npm run test'
    })
  })

  it('returns null for ordinary text and unknown commands', () => {
    expect(parseSlashInput('hello there')).toBeNull()
    expect(parseSlashInput('/nope')).toBeNull()
  })
})

describe('applyCompletion', () => {
  it('splices the replacement over the trigger range with a trailing space', () => {
    const trigger = { kind: 'mention' as const, query: 'src', start: 4, end: 8 }
    const result = applyCompletion('see @src', trigger, '@src/app.ts')
    expect(result.text).toBe('see @src/app.ts ')
    expect(result.caret).toBe(result.text.length)
  })
})
