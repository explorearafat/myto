import { describe, it, expect } from 'vitest'
import { escapeSendKeys, toSendKeys, psQuote, capturePath } from './computer'

describe('escapeSendKeys', () => {
  it('braces every SendKeys special character', () => {
    expect(escapeSendKeys('a+b^c%d~e(f)g{h}i[j]k')).toBe('a{+}b{^}c{%}d{~}e{(}f{)}g{\\{}h{\\}}i{[}j{]}k'.replace(/\\\{/g, '{').replace(/\\\}/g, '}'))
  })
  it('leaves plain text and bangla alone', () => {
    expect(escapeSendKeys('kemon acho ভাই')).toBe('kemon acho ভাই')
  })
})

describe('toSendKeys', () => {
  it('maps modifiers and named keys', () => {
    expect(toSendKeys('ctrl+s')).toBe('^s')
    expect(toSendKeys('ctrl+shift+end')).toBe('(^+{END})')
    expect(toSendKeys('enter')).toBe('{ENTER}')
    expect(toSendKeys('alt+f4')).toBe('%{F4}')
    expect(toSendKeys('esc')).toBe('{ESC}')
  })
  it('maps bare words to their literal keys', () => {
    expect(toSendKeys('win')).toBe('^({ESC})')
    expect(toSendKeys('tab')).toBe('{TAB}')
  })
})

describe('psQuote', () => {
  it('doubles embedded single quotes', () => {
    expect(psQuote("it's fine")).toBe("'it''s fine'")
    expect(psQuote('plain')).toBe("'plain'")
  })
})

describe('capturePath', () => {
  it('names captures with a timestamp and stays unique-ish', () => {
    const a = capturePath('C:\\captures')
    const b = capturePath('C:\\captures')
    expect(a.startsWith('C:\\captures\\capture-')).toBe(true)
    expect(a.endsWith('.png')).toBe(true)
    expect(a).not.toBe(b)
  })
})
