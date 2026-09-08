import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi'

/** The exact line a Vite dev server prints, escape bytes and all. */
const VITE_LOCAL = '  ➜  Local:   http://localhost:8080/\x1b[K\r\n'

describe('stripAnsi', () => {
  it('takes out the erase-line code that was corrupting scraped dev URLs', () => {
    // The reported bug: `\x1b[K` is not an SGR colour code, so a colour-only
    // stripper left it in and the URL came out as `http://localhost:8080/[K`.
    expect(stripAnsi(VITE_LOCAL)).toBe('  ➜  Local:   http://localhost:8080/\r\n')
    expect(stripAnsi(VITE_LOCAL)).not.toContain('[K')
    expect(stripAnsi(VITE_LOCAL)).not.toContain('\x1b')
  })

  it('removes colour, cursor movement, erase and visibility sequences alike', () => {
    expect(stripAnsi('\x1b[31mFailed\x1b[0m to compile')).toBe('Failed to compile')
    expect(stripAnsi('\x1b[1;38;5;204mready\x1b[22;39m')).toBe('ready')
    expect(stripAnsi('done\x1b[2K\x1b[1Gnext')).toBe('donenext')
    expect(stripAnsi('\x1b[?25lspinning\x1b[?25h')).toBe('spinning')
    expect(stripAnsi('\x1b[2J\x1b[1;1Hcleared')).toBe('cleared')
    expect(stripAnsi('\x1b[38;2;255;0;0mtruecolor\x1b[m')).toBe('truecolor')
  })

  it('removes the string-terminated families without leaking their payload', () => {
    // A window title (BEL-terminated) and an OSC-8 hyperlink (ST-terminated); the
    // payload of both is an instruction to the terminal, not text to show.
    expect(stripAnsi('\x1b]0;npm run dev\x07building')).toBe('building')
    expect(stripAnsi('\x1b]8;;http://localhost:3000\x1b\\click\x1b]8;;\x1b\\')).toBe('click')
    expect(stripAnsi('\x1bPq#0;2;0;0;0\x1b\\pixels')).toBe('pixels')
  })

  it('removes charset selection and plain two-byte escapes', () => {
    expect(stripAnsi('\x1b(Bplain')).toBe('plain')
    expect(stripAnsi('\x1b7saved\x1b8')).toBe('saved')
    expect(stripAnsi('\x1b=app\x1b>')).toBe('app')
  })

  it('drops a sequence cut off by a chunk boundary or the output cap', () => {
    // Captured output is sliced at a byte cap and pty data arrives in chunks, so
    // the tail can be half a sequence. Half a sequence is still not text.
    expect(stripAnsi('http://localhost:5173/\x1b[')).toBe('http://localhost:5173/')
    expect(stripAnsi('listening\x1b[38;5')).toBe('listening')
    expect(stripAnsi('listening\x1b')).toBe('listening')
    expect(stripAnsi('\x1b]0;half a title')).toBe('')
  })

  it('leaves ordinary text alone, brackets included', () => {
    // `[K` and `[1m` are perfectly good text when no ESC introduced them — a
    // stripper that eats those would corrupt source code in command output.
    const plain = 'const a = arr[0]\n\t[vite] ready in 312 ms\n[K [1m [?25l\n'
    expect(stripAnsi(plain)).toBe(plain)
    expect(stripAnsi('')).toBe('')
  })

  it('keeps every printable character of a multi-line build log', () => {
    const log = '\x1b[32m✓\x1b[39m built in 1.2s\r\n\x1b[2Kdist/index.html  0.5 kB\r\n'
    expect(stripAnsi(log)).toBe('✓ built in 1.2s\r\ndist/index.html  0.5 kB\r\n')
  })
})
