/*
 * The REPL's input line: a raw-mode editor with a live slash-command dropdown
 * and prompt history. Type `/` and the matching commands appear and filter as
 * you type; ↑/↓ pick (or recall earlier prompts when the menu is closed), Tab
 * completes, Enter submits (the highlighted command when you're mid-slash).
 * Falls back to plain readline when stdin is not an interactive TTY.
 */
import { createInterface } from 'node:readline'
import { paint as c, colorOn, isTty } from './ui'
import { width, padEnd } from './tui'
import * as screen from './screen'

export interface SlashCmd {
  name: string
  desc: string
}

export interface ReadOpts {
  /** Previous prompts, oldest first — ↑ recalls, ↓ returns. */
  history?: string[]
  /** Dim placeholder shown on an empty box. */
  placeholder?: string
  /** Dim status line rendered under the box (cwd · model · hints). */
  hint?: string
  /** Dim strip rendered under the box — mode affordances (⇧⇥ permissions · ⌃E effort). */
  strip?: () => string
  /** Extra raw-key handlers, checked before editing keys (e.g. Shift+Tab, Ctrl-E). */
  hotkeys?: { seq: string; run: () => void }[]
  /**
   * Dashboard focus: on an empty buffer, ↑/↓ move the dashboard selection and
   * ←/→ change the selected value — in place, nothing reprints. 'blur' fires
   * when typing takes focus back. Return true when the key was consumed.
   */
  onDashboard?: (dir: 'up' | 'down' | 'left' | 'right' | 'blur') => boolean
}

/** Commands whose name starts with what was typed after '/'. Pure, for tests. */
export function filterSlash(input: string, commands: SlashCmd[]): SlashCmd[] {
  if (!input.startsWith('/') || input.includes(' ')) return []
  const q = input.slice(1).toLowerCase()
  return commands.filter((cmd) => cmd.name.slice(1).toLowerCase().startsWith(q))
}

/**
 * History recall over the buffered input — pure, for tests. Given the current
 * index into `history` (-1 = the live buffer) and a direction, the next state.
 */
export function recallHistory(
  buffer: string,
  history: string[],
  index: number,
  dir: 'up' | 'down'
): { buf: string; index: number } | null {
  if (history.length === 0) return null
  if (dir === 'up') {
    const next = index === -1 ? history.length - 1 : Math.max(0, index - 1)
    return next === index ? null : { buf: history[next], index: next }
  }
  if (index === -1) return null
  const next = index + 1
  if (next >= history.length) return { buf: buffer, index: -1 }
  return { buf: history[next], index: next }
}

/** Plain one-line read for pipes / non-TTY (scriptable, never raw). */
function simpleReadline(): Promise<string | null> {
  return new Promise((resolve) => {
    // Settled-guard: on EOF the question callback never fires, and rl.close()
    // emits 'close' synchronously — resolve before closing, null on EOF.
    let settled = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(colorOn ? `\n${c.cyan('❯')} ` : '\n> ', (ans) => {
      if (settled) return
      settled = true
      resolve(ans)
      rl.close()
    })
    rl.on('close', () => {
      if (settled) return
      settled = true
      resolve(null)
    })
  })
}

/** Read one task line with the live slash dropdown + history. Resolves null on Ctrl-C / EOF. */
export async function readTask(commands: SlashCmd[], opts: ReadOpts = {}): Promise<string | null> {
  const stdin = process.stdin
  const out = process.stdout
  if (!isTty || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return simpleReadline()

  const history = opts.history ?? []
  const placeholder = opts.placeholder ?? 'Ask Myto…'
  let buf = ''
  let sel = 0
  let histIdx = -1
  let prevRows = 0

  /** The docked painter: absolute-positioned rows inside the shell. */
  const renderDocked = (): void => {
    const frame = screen.inputOrigin()
    if (!frame) return
    const w = Math.min(frame.cols, 104)
    const menu = filterSlash(buf, commands).slice(0, 8)
    const body = buf ? buf + c.cyan('█') : c.dim(placeholder)
    const rows: string[] = menu.map((m, i) => {
      const on = i === Math.min(sel, menu.length - 1)
      const name = on ? c.cyan(padEnd(m.name, 13)) : padEnd(m.name, 13)
      return ` ${on ? c.cyan('❯') : ' '} ${name} ${c.dim(m.desc)}`
    })
    rows.push(
      c.gray('╭' + '─'.repeat(w - 2) + '╮'),
      `${c.gray('│')} ${padEnd(body, w - 4)} ${c.gray('│')}`,
      c.gray('╰' + '─'.repeat(w - 2) + '╯')
    )
    if (opts.strip) rows.push(` ${c.gray(opts.strip())}`)
    screen.drawInputRows(rows, 3 + buf.length)
  }

  const render = (): void => {
    if (screen.active()) {
      renderDocked()
      return
    }
    const w = width()
    const inner = w - 4
    if (prevRows > 0) out.write(`\x1b[${prevRows - 1}A`)
    out.write('\r\x1b[0J') // back to the box's first row, clear downward
    const body = buf ? buf : c.dim(placeholder)
    out.write(c.gray('╭' + '─'.repeat(w - 2) + '╮') + '\n')
    out.write(`${c.gray('│')} ${c.cyan('❯')} ${padEnd(body, inner - 2)} ${c.gray('│')}\n`)
    out.write(c.gray('╰' + '─'.repeat(w - 2) + '╯'))
    let rows = 3
    const menu = filterSlash(buf, commands).slice(0, 8)
    if (sel >= menu.length) sel = Math.max(0, menu.length - 1)
    for (let i = 0; i < menu.length; i++) {
      const on = i === sel
      const name = on ? c.cyan(padEnd(menu[i].name, 13)) : padEnd(menu[i].name, 13)
      out.write(`\n ${on ? c.cyan('❯') : ' '} ${name} ${c.dim(menu[i].desc)}`)
      rows++
    }
    if (opts.hint) {
      out.write(`\n ${c.gray(opts.hint)}`)
      rows++
    }
    if (opts.strip) {
      out.write(`\n ${c.gray(opts.strip())}`)
      rows++
    }
    prevRows = rows
  }

  out.write('\x1b[?25l') // hide the real cursor; the cyan ❯ is our caret
  try {
    stdin.setRawMode(true)
  } catch {
    /* ignore */
  }
  stdin.resume()
  return new Promise<string | null>((resolve) => {
    let onData: (b: Buffer) => void = () => {}
    const finish = (v: string | null): void => {
      out.write(screen.active() ? '\x1b[?25h' : '\x1b[?25h\n') // hide/show handled; no newline inside the docked shell
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
      const hot = opts.hotkeys?.find((h) => h.seq === s)
      if (hot) {
        hot.run()
        return render()
      }
      const menu = filterSlash(buf, commands)
      const pick = (): SlashCmd => menu[Math.min(sel, menu.length - 1)]
      if (s === '\r' || s === '\n') return finish(menu.length ? pick().name : buf)
      if (s === '\x03') return finish(null) // Ctrl-C
      if (s === '\x7f' || s === '\x08') {
        buf = buf.slice(0, -1)
        sel = 0
        histIdx = -1
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
        histIdx = -1
        if (screen.active()) opts.onDashboard?.('blur')
        return render()
      }
      if (s === '\x1b[A' || s === '\x1b[B' || s === '\x1b[D' || s === '\x1b[C') {
        const dir = s === '\x1b[A' ? 'up' : s === '\x1b[B' ? 'down' : s === '\x1b[D' ? 'left' : 'right'
        // With an empty buffer on the docked shell, the arrows tune the
        // dashboard in place; typing takes focus back first.
        if (!buf && screen.active() && opts.onDashboard?.(dir)) return
        if (dir === 'up' || dir === 'down') {
          if (menu.length) {
            sel = (sel + (dir === 'up' ? -1 : 1) + menu.length) % menu.length
            return render()
          }
          const rec = recallHistory(buf, history, histIdx, dir)
          if (rec) {
            buf = rec.buf
            histIdx = rec.index
            render()
          }
        }
        return
      }
      if (s.startsWith('\x1b')) return // ignore other escape sequences
      const clean = s.replace(/[\x00-\x1f\x7f]/g, '')
      if (clean) {
        if (screen.active()) opts.onDashboard?.('blur') // typing takes focus back
        buf += clean
        sel = 0
        histIdx = -1
        render()
      }
    }
    stdin.on('data', onData)
    render()
  })
}
