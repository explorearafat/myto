import { describe, it, expect } from 'vitest'
import { MAIN_MENU, menuKey, renderMenu, parseMenuAnswer, authLine } from './menu'
import { stripAnsi } from './ui'

describe('MAIN_MENU', () => {
  it('has the seven numbered destinations', () => {
    expect(MAIN_MENU.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(MAIN_MENU.map((m) => m.label)).toEqual([
      'Chat',
      'Cowork',
      'Connector',
      'Skills',
      'Command',
      'Plugin',
      'Model'
    ])
  })
})

describe('menuKey', () => {
  it('classifies digits, arrows, enter and cancel', () => {
    expect(menuKey('1')).toBe('1')
    expect(menuKey('7')).toBe('7')
    expect(menuKey('0')).toBe('0')
    expect(menuKey('\x1b[A')).toBe('up')
    expect(menuKey('\x1b[B')).toBe('down')
    expect(menuKey('\r')).toBe('enter')
    expect(menuKey('\x1b')).toBe('cancel')
    expect(menuKey('q')).toBe('cancel')
    expect(menuKey('\x03')).toBe('cancel')
    expect(menuKey('x')).toBe('ignore')
    // Arrow escape prefixes arrive as multi-byte chunks; a lone Esc is cancel.
    expect(menuKey('\x1bC')).toBe('ignore')
  })
})

describe('renderMenu', () => {
  it('shows numbers, labels and hints as plain text without colour', () => {
    const out = stripAnsi(renderMenu(MAIN_MENU.slice(0, 3)))
    expect(out).toContain('1. Chat')
    expect(out).toContain('2. Cowork')
    expect(out).toContain('3. Connector')
    expect(out).toContain('General-purpose AI assistant')
  })
})

describe('parseMenuAnswer', () => {
  const count = 7
  it('parses a valid number to a 0-based index', () => {
    expect(parseMenuAnswer('1', count)).toBe(0)
    expect(parseMenuAnswer(' 7 ', count)).toBe(6)
  })
  it('rejects out-of-range or non-numeric answers', () => {
    expect(parseMenuAnswer('0', count)).toBeNull()
    expect(parseMenuAnswer('8', count)).toBeNull()
    expect(parseMenuAnswer('cowork', count)).toBeNull()
  })
  it('treats empty and quit words as cancel', () => {
    expect(parseMenuAnswer('', count)).toBeNull()
    expect(parseMenuAnswer('q', count)).toBeNull()
    expect(parseMenuAnswer('quit', count)).toBeNull()
  })
})

describe('authLine', () => {
  it('marks a ready gateway with a masked key', () => {
    const out = stripAnsi(
      authLine({
        provider: 'gateway',
        url: 'https://api.example.com/v1',
        keyMasked: '····ab12',
        model: 'gpt-4o-mini',
        workspace: 'C:\\proj',
        ready: true
      })
    )
    expect(out).toContain('ready')
    expect(out).toContain('gateway https://api.example.com/v1')
    expect(out).toContain('key ····ab12')
    expect(out).toContain('model gpt-4o-mini')
    expect(out).toContain('C:\\proj')
  })
  it('flags an unconfigured setup without inventing a key', () => {
    const out = stripAnsi(
      authLine({ provider: 'gateway', url: '(no base URL)', model: '', workspace: 'C:\\proj', ready: false })
    )
    expect(out).toContain('not configured')
    expect(out).toContain('model (none)')
  })
})
