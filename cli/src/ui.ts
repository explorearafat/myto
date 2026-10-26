/*
 * Terminal UI kit for the Myto CLI: a small, dependency-free palette + a few
 * interactive widgets (a keyboard/mouse select menu, a confirm, clipboard copy).
 * Everything degrades to plain text when stdout is not a TTY or NO_COLOR is set,
 * so piped output stays clean and scriptable.
 */
import { spawn } from 'node:child_process'
import * as screen from './screen'

const isTtyOut = process.stdout.isTTY === true
const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== ''
export const colorOn = isTtyOut && !noColor
export const isTty = isTtyOut

/** Wrap a string in a 24-bit foreground colour (no-op when colour is off). */
function rgb(r: number, g: number, b: number) {
  return (s: string): string => (colorOn ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s)
}
function sgr(code: string) {
  return (s: string): string => (colorOn ? `\x1b[${code}m${s}\x1b[0m` : s)
}

/** The Myto terminal palette — a violet→cyan signature with warm accents. */
export const paint = {
  violet: rgb(167, 139, 250),
  magenta: rgb(232, 121, 249),
  cyan: rgb(34, 211, 238),
  amber: rgb(251, 191, 36),
  green: rgb(74, 222, 128),
  red: rgb(248, 113, 113),
  blue: rgb(96, 165, 250),
  gray: rgb(150, 150, 150),
  dim: sgr('2'),
  bold: sgr('1'),
  italic: sgr('3'),
  underline: sgr('4')
}

export const sym = {
  prompt: '❯',
  gear: '⚙',
  dot: '●',
  check: '✓',
  cross: '✗',
  arrow: '→',
  spark: '✦',
  bar: '│'
}

/** Strip every ANSI colour escape — used for width maths and in tests. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Colour each visible character along the violet→magenta→cyan signature ramp. */
export function gradient(text: string): string {
  if (!colorOn) return text
  const stops: Array<[number, number, number]> = [
    [167, 139, 250],
    [232, 121, 249],
    [34, 211, 238]
  ]
  const chars = [...text]
  const n = Math.max(chars.length - 1, 1)
  return (
    chars
      .map((ch, i) => {
        const seg = (i / n) * (stops.length - 1)
        const k = Math.min(Math.floor(seg), stops.length - 2)
        const f = seg - k
        const [r1, g1, b1] = stops[k]
        const [r2, g2, b2] = stops[k + 1]
        const r = Math.round(r1 + (r2 - r1) * f)
        const g = Math.round(g1 + (g2 - g1) * f)
        const b = Math.round(b1 + (b2 - b1) * f)
        return `\x1b[38;2;${r};${g};${b}m${ch}`
      })
      .join('') + '\x1b[0m'
  )
}

/** The startup banner — a gradient wordmark over a short, dim subtitle. */
export function banner(version: string, hint = '/help for commands'): string {
  const mark = paint.bold(gradient('M Y T O'))
  const line1 = `${paint.magenta(sym.spark)} ${mark}`
  const line2 = paint.dim('AI coding agent, right in your terminal')
  const line3 = paint.gray(`v${version}`) + paint.dim(`  ·  ${hint}`)
  return `\n${line1}\n${line2}\n${line3}\n`
}

/** A thin gradient rule across `width` columns. */
export function rule(width = 48): string {
  return gradient('─'.repeat(width))
}

/** The OS clipboard command for a platform — pure, so tests can assert the choice. */
export function clipboardCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'clip', args: [] }
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] }
  return { cmd: 'wl-copy', args: [] } // Wayland first; copyToClipboard falls back to X11 tools
}

const LINUX_CLIPBOARD: Array<{ cmd: string; args: string[] }> = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] }
]

/** Copy text to the OS clipboard. Resolves false when no clipboard tool is found. */
export function copyToClipboard(text: string): Promise<boolean> {
  const candidates =
    process.platform === 'win32'
      ? [{ cmd: 'clip', args: [] }]
      : process.platform === 'darwin'
        ? [{ cmd: 'pbcopy', args: [] }]
        : LINUX_CLIPBOARD
  return new Promise((resolve) => {
    let i = 0
    const tryNext = (): void => {
      if (i >= candidates.length) return resolve(false)
      const { cmd, args } = candidates[i++]
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        ok ? resolve(true) : tryNext()
      }
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
      child.stdin.on('error', () => {})
      child.stdin.end(text)
    }
    tryNext()
  })
}

export interface SelectOption<T> {
  label: string
  hint?: string
  value: T
}

/** Parse an SGR mouse event (ESC [ < b ; x ; y M|m). Null when the bytes aren't one. */
export function parseMouse(seq: string): { btn: number; x: number; y: number; press: boolean } | null {
  const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(seq)
  if (!m) return null
  return { btn: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === 'M' }
}

/** Pure menu reducer: given a key name, the current index and count, the next index. */
export function menuIndexAfter(key: string, index: number, count: number): number {
  if (count <= 0) return 0
  const wrap = (i: number): number => ((i % count) + count) % count
  if (key === 'up' || key === 'k') return wrap(index - 1)
  if (key === 'down' || key === 'j') return wrap(index + 1)
  if (key === 'home') return 0
  if (key === 'end') return count - 1
  return index
}

/** Ask the terminal for the cursor's current row (DSR); falls back to row 1. */
function cursorRow(): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += d.toString('utf8')
      const m = /\x1b\[(\d+);\d+R/.exec(buf)
      if (m) {
        stdin.removeListener('data', onData)
        resolve(Number(m[1]))
      }
    }
    stdin.on('data', onData)
    process.stdout.write('\x1b[6n')
    setTimeout(() => {
      stdin.removeListener('data', onData)
      resolve(1)
    }, 250)
  })
}

/**
 * An interactive single-choice menu driven by the keyboard AND the mouse:
 * ↑/↓ (or j/k, or the scroll wheel) move, Enter or a click selects, a number
 * jumps, Esc/q/Ctrl-C cancels. Falls back to the first option when stdin is not
 * an interactive TTY (pipes, CI) so scripts never hang, and restores the
 * terminal (mouse off, cursor on, cooked mode) on every exit path.
 */
export async function select<T>(title: string, options: SelectOption<T>[]): Promise<T | null> {
  const stdin = process.stdin
  if (!isTty || !stdin.isTTY || typeof stdin.setRawMode !== 'function' || options.length === 0) {
    return options.length ? options[0].value : null
  }
  // The menu owns the cursor: inside the docked shell it takes the message
  // region and redraws in place; arrows change only the highlighted row.
  screen.focus()
  try {
    return await selectInner(title, options)
  } finally {
    screen.unfocus()
  }
}

async function selectInner<T>(title: string, options: SelectOption<T>[]): Promise<T | null> {
  const stdin = process.stdin
  const out = process.stdout
  const header = `${paint.magenta(sym.spark)} ${paint.bold(title)}`
  const hintBar = paint.dim('  ↑/↓ or click · Enter to select · Esc to cancel')
  let index = 0

  try {
    stdin.setRawMode(true)
  } catch {
    /* some shells can't */
  }
  stdin.resume()
  out.write('\x1b[?1000h\x1b[?1006h') // mouse: button events + SGR coordinates
  const rows = options.length + 2
  out.write('\n'.repeat(rows) + `\x1b[${rows}A`) // reserve space, back to the top
  const topRow = await cursorRow()

  const render = (): void => {
    out.write('\x1b[?25l' + `\x1b[${topRow};1H\x1b[0J` + header + '\n')
    options.forEach((o, i) => {
      const on = i === index
      const bg = on && colorOn ? '\x1b[48;2;38;38;54m' : ''
      const marker = on ? paint.cyan(sym.prompt) : ' '
      const label = on ? paint.cyan(paint.bold(o.label)) : o.label
      const hint = o.hint ? paint.dim(`  ${o.hint}`) : ''
      out.write(`${bg} ${marker} ${paint.gray(`${i + 1}.`)} ${label}${hint}  \x1b[0m\n`)
    })
    out.write(hintBar)
  }

  return new Promise<T | null>((resolve) => {
    let onData: (buf: Buffer) => void = () => {}
    const finish = (v: T | null): void => {
      out.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\n') // mouse off, cursor on
      try {
        stdin.setRawMode(false)
      } catch {
        /* ignore */
      }
      stdin.pause()
      stdin.removeListener('data', onData)
      resolve(v)
    }
    onData = (buf: Buffer): void => {
      const s = buf.toString('utf8')
      const mouse = parseMouse(s)
      if (mouse) {
        if (mouse.btn === 64) index = menuIndexAfter('up', index, options.length)
        else if (mouse.btn === 65) index = menuIndexAfter('down', index, options.length)
        else if (mouse.press && mouse.btn === 0) {
          const row = mouse.y - (topRow + 1) // options begin one row below the header
          if (row >= 0 && row < options.length) {
            index = row
            return finish(options[index].value)
          }
          return
        } else return
        return render()
      }
      if (s === '\r' || s === '\n') return finish(options[index].value)
      if (s === '\x1b' || s === 'q' || s === '\x03') return finish(null)
      if (/^[1-9]$/.test(s)) {
        const n = Number(s) - 1
        if (n < options.length) {
          index = n
          return finish(options[index].value)
        }
      }
      const key =
        s === '\x1b[A' ? 'up' : s === '\x1b[B' ? 'down' : s === '\x1b[H' ? 'home' : s === '\x1b[F' ? 'end' : s
      const next = menuIndexAfter(key, index, options.length)
      if (next !== index) {
        index = next
        render()
      }
    }
    stdin.on('data', onData)
    render()
  })
}

/** A yes/no confirm built on the select menu. Cancelling (Esc) resolves to false. */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const yes: SelectOption<boolean> = { label: 'Yes', value: true }
  const no: SelectOption<boolean> = { label: 'No', value: false }
  const v = await select(question, defaultYes ? [yes, no] : [no, yes])
  return v ?? false
}
