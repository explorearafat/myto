/*
 * The REPL's input line: a raw-mode editor with a live slash-command dropdown.
 * Type `/` and the matching commands appear and filter as you type; ↑/↓ pick,
 * Tab completes, Enter submits (the highlighted command when you're mid-slash).
 * Falls back to plain readline when stdin is not an interactive TTY.
 */
import { createInterface } from 'node:readline'
import { paint as c, colorOn, isTty } from './ui'
import { width, padEnd } from './tui'

export interface SlashCmd {
  name: string
  desc: string
}

/** Commands whose name starts with what was typed after '/'. Pure, for tests. */
export function filterSlash(input: string, commands: SlashCmd[]): SlashCmd[] {
  if (!input.startsWith('/') || input.includes(' ')) return []
  const q = input.slice(1).toLowerCase()
  return commands.filter((cmd) => cmd.name.slice(1).toLowerCase().startsWith(q))
}

/** Plain one-line read for pipes / non-TTY (scriptable, never raw). */
function simpleReadline(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(colorOn ? `\n${c.green('▌')} ` : '\n> ', (ans) => {
      rl.close()
      resolve(ans)
    })
  })
}

/** Read one task line with the live slash dropdown. Resolves null on Ctrl-C / EOF. */
export async function readTask(commands: SlashCmd[]): Promise<string | null> {
  const stdin = process.stdin
  const out = process.stdout
  if (!isTty || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return simpleReadline()

  let buf = ''
  let sel = 0
  let prevRows = 0

  const render = (): void => {
    const w = width()
    const inner = w - 4
    if (prevRows > 0) out.write(`\x1b[${prevRows - 1}A`)
    out.write('\r\x1b[0J') // back to the box's first row, clear downward
    const body = buf ? buf : c.dim('Enter a coding task or / for commands')
    out.write(c.gray('╭' + '─'.repeat(w - 2) + '╮') + '\n')
    out.write(`${c.gray('│')} ${c.green('▌')} ${padEnd(body, inner - 2)} ${c.gray('│')}\n`)
    out.write(c.gray('╰' + '─'.repeat(w - 2) + '╯'))
    let rows = 3
    const menu = filterSlash(buf, commands).slice(0, 8)
    if (sel >= menu.length) sel = Math.max(0, menu.length - 1)
    for (let i = 0; i < menu.length; i++) {
      const on = i === sel
      const name = on ? c.cyan(padEnd(menu[i].name, 10)) : padEnd(menu[i].name, 10)
      out.write(`\n ${on ? c.cyan('❯') : ' '} ${name} ${c.dim(menu[i].desc)}`)
      rows++
    }
    prevRows = rows
  }

  out.write('\x1b[?25l') // hide the real cursor; the green bar is our caret
  try {
    stdin.setRawMode(true)
  } catch {
    /* ignore */
  }
  stdin.resume()
  return new Promise<string | null>((resolve) => {
    let onData: (b: Buffer) => void = () => {}
    const finish = (v: string | null): void => {
      out.write('\x1b[?25h\n')
      try {
        stdin.setRawMode(false)
      } catch {
        /* ignore */
      }
      stdin.pause()
      stdin.removeListener('data', onData)
      resolve(v)
    }
    onData = (b: Buffer): void => {
      const s = b.toString('utf8')
      const menu = filterSlash(buf, commands)
      const pick = (): SlashCmd => menu[Math.min(sel, menu.length - 1)]
      if (s === '\r' || s === '\n') return finish(menu.length ? pick().name : buf)
      if (s === '\x03') return finish(null) // Ctrl-C
      if (s === '\x7f' || s === '\x08') {
        buf = buf.slice(0, -1)
        sel = 0
        return render()
      }
      if (s === '\t') {
        if (menu.length) {
          buf = pick().name
          sel = 0
          render()
        }
        return
      }
      if (s === '\x1b') {
        buf = ''
        sel = 0
        return render()
      }
      if (s === '\x1b[A') {
        if (menu.length) sel = (sel - 1 + menu.length) % menu.length
        return render()
      }
      if (s === '\x1b[B') {
        if (menu.length) sel = (sel + 1) % menu.length
        return render()
      }
      if (s.startsWith('\x1b')) return // ignore other escape sequences
      const clean = s.replace(/[\x00-\x1f\x7f]/g, '')
      if (clean) {
        buf += clean
        sel = 0
        render()
      }
    }
    stdin.on('data', onData)
    render()
  })
}
