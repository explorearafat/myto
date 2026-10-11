import { describe, it, expect } from 'vitest'
import { filterSlash } from './input'

const CMDS = [
  { name: '/model', desc: 'pick' },
  { name: '/models', desc: 'list' },
  { name: '/config', desc: 'cfg' },
  { name: '/quit', desc: 'exit' }
]

describe('filterSlash', () => {
  it('lists every command for a bare slash', () => {
    expect(filterSlash('/', CMDS).map((c) => c.name)).toEqual(['/model', '/models', '/config', '/quit'])
  })
  it('prefix-filters as you type', () => {
    expect(filterSlash('/mo', CMDS).map((c) => c.name)).toEqual(['/model', '/models'])
    expect(filterSlash('/q', CMDS).map((c) => c.name)).toEqual(['/quit'])
  })
  it('is case-insensitive', () => {
    expect(filterSlash('/MOD', CMDS).map((c) => c.name)).toEqual(['/model', '/models'])
  })
  it('closes once a space is typed (now editing args) or without a slash', () => {
    expect(filterSlash('/model ', CMDS)).toEqual([])
    expect(filterSlash('hello', CMDS)).toEqual([])
  })
  it('returns nothing when no command matches', () => {
    expect(filterSlash('/zzz', CMDS)).toEqual([])
  })
})
