/*
 * The main numbered menu — Myto's front door. After the welcome screen the
 * interactive session opens on a 7-way menu (Chat, Cowork, Connector, Skills,
 * Command, Plugin, Model) driven by number keys, arrows, Enter, Esc and the
 * mouse (reusing the shared parser). Off-TTY it degrades to a printed list and
 * a plain numbered prompt so pipes and CI never hang.
 */
import { createInterface } from 'node:readline'
import { paint as c, isTty, menuIndexAfter, parseMouse, sym, colorOn } from './ui'
import * as screen from './screen'

export interface MenuItem {
  /** The number shown and the digit that selects it. */
  n: number
  label: string
  hint: string
}

/** The seven top-level destinations, in display order. */
export const MAIN_MENU: MenuItem[] = [
  { n: 1, label: 'Chat', hint: 'General-purpose AI assistant' },
  { n: 2, label: 'Cowork', hint: 'Collaborative AI workspace — Myto reads, edits and runs' },
  { n: 3, label: 'Connector', hint: 'Provider endpoints — base URL, API key, connection test' },
  { n: 4, label: 'Skills', hint: 'Skills and custom agents' },
  { n: 5, label: 'Command', hint: 'Quick actions and automation' },
  { n: 6, label: 'Plugin', hint: 'Extend functionality with local plugins' },
  { n: 7, label: 'Model', hint: 'Provider and model management' }
]

/**
 * Classify one stdin chunk for the menu — pure, so tests drive it. Returns the
 * digit pressed ('1'-'7'), 'up', 'down', 'enter' or 'cancel'; anything else is
 * 'ignore'.
 */
export function menuKey(s: string): string {
  if (/^\d$/.test(s)) return s
  if (s === '\x1b[A') return 'up'
  if (s === '\x1b[B') return 'down'
  if (s === '\r' || s === '\n') return 'enter'
  if (s === '\x1b' || s === 'q' || s === '\x03') return 'cancel'
  return 'ignore'
}

/** The numbered menu body as plain text (also the non-TTY fallback render). */
export function renderMenu(items: MenuItem[], selected = 0): string {
  const numW = String(items.length).length
  const labelW = Math.max(...items.map((i) => i.label.length))
  return items
    .map((it, i) => {
      const on = i === selected
      const num = c.gray(`${it.n}.`.padStart(numW + 1))
      const label = on ? c.cyan(c.bold(it.label.padEnd(labelW))) : c.bold(it.label.padEnd(labelW))
      const hint = on ? `  ${c.dim(it.hint)}` : c.gray(`  ${it.hint}`)
      const marker = on && colorOn ? c.cyan(sym.prompt) : ' '
      return ` ${marker} ${num} ${label}${hint}`
    })
    .join('\n')
}

/** Parse a non-TTY answer line into a menu index (0-based) or null to cancel. */
export function parseMenuAnswer(line: string, count: number): number | null {
  const t = line.trim().toLowerCase()
  if (t === '' || t === 'q' || t === 'quit' || t === 'exit') return null
  const n = Number.parseInt(t, 10)
  if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1
  return null
}

/**
 * Show the menu and resolve with the chosen item's 0-based index, or null when
 * the user cancels (Esc / q / Ctrl-C / EOF). Mouse support rides on the shared
 * SGR parser; the render rewrites a fixed block of rows like ui.select.
 */
export async function numberMenu(items: MenuItem[], title = 'What would you like to do?'): Promise<number | null> {
  const stdin = process.stdin
  const out = process.stdout
  if (!isTty || !stdin.isTTY || typeof stdin.setRawMode !== 'function' || items.length === 0) {
    // Non-interactive: print the list and read a number from stdin (EOF cancels).
    out.write(c.bold(title) + '\n' + renderMenu(items) + '\n')
    const line = await new Promise<string | null>((resolve) => {
      // Settled-guard: rl.close() fires 'close' synchronously, so resolve the
      // answer BEFORE closing or the null path wins the race.
      let settled = false
      const rl = createInterface({ input: stdin, output: out, terminal: false })
      rl.question(c.gray('Select 1-' + items.length + ' (q to quit): '), (ans) => {
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
    return line === null ? null : parseMenuAnswer(line, items.length)
  }

  const header = `${c.magenta(sym.spark)} ${c.bold(title)}`
  const hintBar = c.dim('  press 1-7 · ↑/↓ · Enter · Esc back')
  let index = 0

  // Inside the docked shell the menu owns the message region and redraws in
  // place — arrows change only the highlighted row, nothing reprints.
  screen.focus()
  try {
    try {
      stdin.setRawMode(true)
    } catch {
      /* some shells can't */
    }
    stdin.resume()
    const rows = items.length + 2
    out.write('\n'.repeat(rows) + `\x1b[${rows}A`) // reserve space, back to the top
    out.write('\x1b[?25l')

    const render = (): void => {
      out.write('\r\x1b[0J' + header + '\n' + renderMenu(items, index) + '\n' + hintBar)
    }

    return await new Promise<number | null>((resolve) => {
      let onData: (buf: Buffer) => void = () => {}
      const finish = (v: number | null): void => {
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
      onData = (buf: Buffer): void => {
        const s = buf.toString('utf8')
        const mouse = parseMouse(s)
        if (mouse) {
          if (mouse.btn === 64) index = menuIndexAfter('up', index, items.length)
          else if (mouse.btn === 65) index = menuIndexAfter('down', index, items.length)
          else if (mouse.press && mouse.btn === 0) {
            const row = mouse.y - 2 // header row + the blank row above the options
            if (row >= 0 && row < items.length) {
              index = row
              return finish(index)
            }
            return
          } else return
          return render()
        }
        const key = menuKey(s)
        if (key === 'ignore') return
        if (key === 'cancel') return finish(null)
        if (key === 'enter') return finish(index)
        const digit = Number(key)
        if (Number.isInteger(digit) && digit >= 1 && digit <= items.length) {
          index = digit - 1
          return finish(index)
        }
        if (key === 'up' || key === 'down') {
          const next = menuIndexAfter(key, index, items.length)
          if (next !== index) {
            index = next
            render()
          }
        }
      }
      stdin.on('data', onData)
      render()
    })
  } finally {
    screen.unfocus()
  }
}

/** One line summarising auth + workspace for the header above the menu. */
export function authLine(parts: { provider: string; url: string; keyMasked?: string; model: string; workspace: string; ready: boolean }): string {
  const status = parts.ready ? c.green(sym.check + ' ready') : c.amber(sym.dot + ' not configured')
  const auth = parts.keyMasked ? ` · key ${parts.keyMasked}` : ''
  return [
    `  ${status}`,
    c.gray(parts.provider + ' ' + parts.url + auth),
    c.gray('· model ' + (parts.model || '(none)')),
    c.gray('· ' + parts.workspace)
  ].join(' ')
}
