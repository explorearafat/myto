import { describe, it, expect } from 'vitest'
import { parseSlash, expandCommand } from './commands'

describe('parseSlash', () => {
  it('splits a bare `/name` into the name and an empty arg string', () => {
    expect(parseSlash('/review')).toEqual({ name: 'review', args: '' })
  })

  it('captures the argument string after the first whitespace', () => {
    expect(parseSlash('/deploy production now')).toEqual({
      name: 'deploy',
      args: 'production now'
    })
  })

  it('trims leading indentation and surrounding arg whitespace', () => {
    expect(parseSlash('   /fix   src/a.ts  ')).toEqual({ name: 'fix', args: 'src/a.ts' })
  })

  it('allows dashes and underscores in the name', () => {
    expect(parseSlash('/run-tests unit')).toEqual({ name: 'run-tests', args: 'unit' })
    expect(parseSlash('/gen_docs')).toEqual({ name: 'gen_docs', args: '' })
  })

  it('is null for non-slash text', () => {
    expect(parseSlash('hello world')).toBeNull()
  })

  it('is null for a bare slash or a slash with no name', () => {
    expect(parseSlash('/')).toBeNull()
    expect(parseSlash('/ spaced')).toBeNull()
    expect(parseSlash('//comment')).toBeNull()
  })

  it('requires the name to start with an alphanumeric', () => {
    expect(parseSlash('/-nope')).toBeNull()
    expect(parseSlash('/_nope')).toBeNull()
  })
})

describe('expandCommand (shared source of truth)', () => {
  it('substitutes $ARGUMENTS with the whole arg string', () => {
    expect(expandCommand('Deploy to $ARGUMENTS now.', 'prod')).toBe('Deploy to prod now.')
  })

  it('substitutes positional $1, $2 with whitespace-split words', () => {
    expect(expandCommand('Move $1 to $2.', 'a.txt b.txt')).toBe('Move a.txt to b.txt.')
  })

  it('appends args when the body references neither $ARGUMENTS nor $N', () => {
    expect(expandCommand('Review the diff.', 'src/foo.ts')).toBe('Review the diff.\n\nsrc/foo.ts')
  })

  it('leaves a referencing body untouched when no args are supplied', () => {
    expect(expandCommand('Summarize $ARGUMENTS.', '')).toBe('Summarize .')
  })

  it('does not append args when the body already consumed them', () => {
    expect(expandCommand('Open $1.', 'a.txt')).toBe('Open a.txt.')
  })
})
