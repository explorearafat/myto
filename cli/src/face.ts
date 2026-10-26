/*
 * The Myto agent face — the front door of the CLI, in the house style: a dotted
 * crown and floor, a hexagonal head with arc eyes `(*)`, `##` cheeks, a bold
 * blue MYTO across the middle and a slash-drawn smile. Directly under it (same
 * width) sits the dashboard box: Working Folder · Model · Effort · API Status —
 * each row selectable, so arrow keys retune the session in place instead of
 * reprinting anything. Pure string builders; tests drive them without a TTY.
 */
import { paint as c, isTty, stripAnsi } from './ui'

export interface DashRow {
  label: string
  value: string
}

/** Human effort names — the dashboard shows these, not the raw ids. */
export function effortLabel(effort: 'low' | 'medium' | 'high' | undefined): string {
  if (effort === 'low') return 'Low'
  if (effort === 'high') return 'Advanced'
  return 'Balanced'
}

/** The plain rows of the face box, dashboard included. Every row is W wide. */
export function faceRows(dash?: { rows: DashRow[]; selected?: number }): string[] {
  const W = 48
  const inner = W - 4
  const centre = (s: string, w: number): string => {
    const l = Math.floor((w - s.length) / 2)
    return ' '.repeat(l) + s + ' '.repeat(w - s.length - l)
  }
  const line = (s: string): string => s + ' '.repeat(Math.max(0, W - s.length))
  const crown = centre('·  '.repeat(14).trim(), W)
  const out: string[] = [
    crown,
    line(' \\                                   / '),
    line('  \\         ──              ──      /  '),
    line('   ##       (*)            (*)     ##  '),
    line('   ##                               ## '),
    line('   |           M  Y  T  O           |  '),
    line('   |                                |  '),
    line("    \\       \\______________/       /   "),
    line('     \\                             /   ')
  ]
  if (dash && dash.rows.length > 0) {
    out.push(` ╭${'─'.repeat(W - 3)}╮`)
    dash.rows.forEach((r, i) => {
      const on = i === dash.selected
      const label = r.label.padEnd(15)
      const maxVal = inner - 19
      const value = r.value.length > maxVal ? r.value.slice(0, Math.max(1, maxVal - 1)) + '…' : r.value
      // Left-aligned like the house style: marker · label · value.
      const body = `${on ? '▸ ' : '  '}${label}${value}`
      out.push(centre(`│ ${body.padEnd(inner - 2)}│`, W))
    })
    out.push(` ╰${'─'.repeat(W - 3)}╯`)
  }
  return out
}

/** Colour the face: violet dots, cyan eyes, blue MYTO and cheeks, gray frame. */
export function faceLines(dash?: { rows: DashRow[]; selected?: number }): string[] {
  return faceRows(dash).map((row) => {
    if (/·/.test(row) && !row.includes('│') && !row.includes('#')) return c.violet(row)
    if (row.includes('M  Y  T  O')) return row.replace('M  Y  T  O', (m) => c.bold(c.blue(m)))
    if (row.includes('##') || row.includes('(*)') || row.includes('──')) {
      return row
        .replace(/##/g, (m) => c.blue(m))
        .replace(/──/g, (m) => c.cyan(m))
        .replace(/\(\*\)/g, (m) => c.cyan(m))
    }
    if (row.includes('│')) {
      const painted = row.replace(/│([^│]*)│/, (_, body: string) => `│${paintDashBody(body)}│`)
      return painted === row ? c.gray(row) : painted
    }
    return c.gray(row)
  })
}

/** Colour one dashboard row body: selection marker, label, value. */
function paintDashBody(body: string): string {
  const m = /^ (▸ |  )(.{15})(.*?)\s*$/.exec(body)
  if (!m) return c.gray(body)
  const [, marker, label, value] = m
  const key = label.trim().toLowerCase()
  const labelColor = key.startsWith('model') ? c.green : key.startsWith('effort') ? c.cyan : c.amber
  let valueColor: (s: string) => string = (s) => s
  if (/^connected/i.test(value)) valueColor = c.green
  else if (/^not /i.test(value)) valueColor = c.red
  else if (/^(advanced|balanced|low)/i.test(value)) valueColor = c.cyan
  const selected = marker.trim().length > 0
  const wrap = selected ? c.bold : (s: string) => s
  const painted = wrap(' ' + c.cyan(marker) + labelColor(label) + valueColor(value))
  // Preserve the row's exact width: pad by VISIBLE length, not raw (ANSI codes
  // would inflate padEnd's count and break the box).
  const visible = stripAnsi(painted).length
  return painted + ' '.repeat(Math.max(0, body.length - visible))
}

/** The face, coloured, with the exact same visible text as faceRows. */
export function facePlain(dash?: { rows: DashRow[]; selected?: number }): string[] {
  return faceRows(dash)
}

/** Draw the face instantly (the docked shell animates elsewhere). */
export function printFace(dash?: { rows: DashRow[]; selected?: number }): void {
  process.stdout.write('\n' + faceLines(dash).join('\n') + '\n')
}

/** Animate the face top-to-bottom (~35ms a row) on a TTY; instant otherwise. */
export async function bootFace(delay = 35, dash?: { rows: DashRow[]; selected?: number }): Promise<void> {
  const out = process.stdout
  const lines = faceLines(dash)
  if (!isTty || delay <= 0) {
    out.write('\n' + lines.join('\n') + '\n')
    return
  }
  out.write('\n')
  for (const l of lines) {
    out.write(l + '\n')
    await new Promise((r) => setTimeout(r, delay))
  }
}
