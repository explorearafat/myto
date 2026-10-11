import { describe, it, expect } from 'vitest'
import {
  stripAnsi,
  parseMouse,
  menuIndexAfter,
  clipboardCommand,
  select,
  gradient
} from './ui'

describe('stripAnsi', () => {
  it('removes colour escapes but keeps the text', () => {
    expect(stripAnsi('\x1b[38;2;1;2;3mhi\x1b[0m')).toBe('hi')
    expect(stripAnsi('\x1b[2mdim\x1b[0m \x1b[1mbold\x1b[0m')).toBe('dim bold')
  })
  it('is a no-op on plain text', () => {
    expect(stripAnsi('nothing here')).toBe('nothing here')
  })
})

describe('parseMouse', () => {
  it('parses an SGR left-click press', () => {
    expect(parseMouse('\x1b[<0;12;7M')).toEqual({ btn: 0, x: 12, y: 7, press: true })
  })
  it('parses a release (lowercase m) and the wheel buttons', () => {
    expect(parseMouse('\x1b[<0;3;3m')?.press).toBe(false)
    expect(parseMouse('\x1b[<64;1;1M')?.btn).toBe(64)
    expect(parseMouse('\x1b[<65;1;1M')?.btn).toBe(65)
  })
  it('returns null for a non-mouse sequence', () => {
    expect(parseMouse('\x1b[A')).toBeNull()
    expect(parseMouse('q')).toBeNull()
  })
})

describe('menuIndexAfter', () => {
  it('moves and wraps around the ends', () => {
    expect(menuIndexAfter('down', 0, 3)).toBe(1)
    expect(menuIndexAfter('down', 2, 3)).toBe(0)
    expect(menuIndexAfter('up', 0, 3)).toBe(2)
    expect(menuIndexAfter('k', 1, 3)).toBe(0)
    expect(menuIndexAfter('j', 1, 3)).toBe(2)
  })
  it('jumps to the ends and ignores unknown keys', () => {
    expect(menuIndexAfter('home', 2, 3)).toBe(0)
    expect(menuIndexAfter('end', 0, 3)).toBe(2)
    expect(menuIndexAfter('x', 1, 3)).toBe(1)
  })
  it('clamps a zero-length menu', () => {
    expect(menuIndexAfter('down', 0, 0)).toBe(0)
  })
})

describe('clipboardCommand', () => {
  it('picks the native tool per platform', () => {
    expect(clipboardCommand('win32').cmd).toBe('clip')
    expect(clipboardCommand('darwin').cmd).toBe('pbcopy')
    expect(clipboardCommand('linux').cmd).toBe('wl-copy')
  })
})

describe('gradient', () => {
  it('preserves the underlying text once colour is stripped', () => {
    expect(stripAnsi(gradient('MYTO'))).toBe('MYTO')
  })
})

describe('select (non-TTY fallback)', () => {
  it('resolves to the first option without blocking when stdin is not a TTY', async () => {
    const v = await select('pick', [
      { label: 'a', value: 1 },
      { label: 'b', value: 2 }
    ])
    expect(v).toBe(1)
  })
  it('resolves to null for an empty option list', async () => {
    expect(await select('pick', [])).toBeNull()
  })
})
