import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseCommand,
  expandCommand,
  commandFileName,
  writeCommand,
  loadCommands,
  deleteCommandFile
} from '@main/commands/registry'

describe('parseCommand', () => {
  it('reads description + argument-hint from frontmatter and keeps the body', () => {
    const parsed = parseCommand(
      '---\ndescription: Review a diff\nargument-hint: [path]\n---\nReview $ARGUMENTS carefully.'
    )
    expect(parsed).toEqual({
      description: 'Review a diff',
      argumentHint: '[path]',
      body: 'Review $ARGUMENTS carefully.'
    })
  })

  it('treats a file with no frontmatter as a pure body', () => {
    expect(parseCommand('Just do the thing.')).toEqual({
      description: '',
      argumentHint: '',
      body: 'Just do the thing.'
    })
  })
})

describe('expandCommand', () => {
  it('substitutes $ARGUMENTS with the whole remainder', () => {
    expect(expandCommand('Deploy to $ARGUMENTS now.', 'production')).toBe('Deploy to production now.')
  })

  it('substitutes positional $1 / $2', () => {
    expect(expandCommand('Move $1 to $2.', 'a.txt b.txt')).toBe('Move a.txt to b.txt.')
  })

  it('appends arguments when the template never references them', () => {
    expect(expandCommand('Summarize the code.', 'src/foo.ts')).toBe(
      'Summarize the code.\n\nsrc/foo.ts'
    )
  })

  it('leaves a no-argument invocation of an unreferenced template unchanged', () => {
    expect(expandCommand('Summarize the code.', '')).toBe('Summarize the code.')
  })
})

describe('commandFileName', () => {
  it('slugifies to a safe basename', () => {
    expect(commandFileName('Deploy Prod!')).toBe('deploy-prod')
  })
})

describe('writeCommand + loadCommands round-trip (project scope)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sylor-cmd-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('authors a command file that loadCommands then discovers', () => {
    const path = writeCommand(
      { name: 'Deploy', description: 'Ship it', argumentHint: '[env]', body: 'Deploy to $ARGUMENTS.' },
      'project',
      root
    )
    expect(path).toBe(join(root, '.sylor', 'commands', 'deploy.md'))

    const found = loadCommands(root).find((c) => c.name === 'deploy')
    expect(found).toMatchObject({
      name: 'deploy',
      description: 'Ship it',
      argumentHint: '[env]',
      body: 'Deploy to $ARGUMENTS.',
      source: 'project'
    })

    deleteCommandFile(path)
    expect(loadCommands(root).some((c) => c.name === 'deploy')).toBe(false)
  })

  it('rejects a blank name or body, and a project scope with no root', () => {
    expect(() => writeCommand({ name: '', body: 'x' }, 'project', root)).toThrow(/name/i)
    expect(() => writeCommand({ name: 'x', body: '' }, 'project', root)).toThrow(/prompt/i)
    expect(() => writeCommand({ name: 'x', body: 'y' }, 'project', null)).toThrow(/project/i)
  })
})
