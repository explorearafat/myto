/*
 * The Myto agent face — the front door of the CLI. A dot-halo, hash eyes and a
 * slash-drawn smile inside a bordered box, with MYTO set in the middle, and a
 * one-line dashboard (folder · model · provider) right under it. Nothing else:
 * the interface stays minimal. `bootFace` draws it line by line with one blink
 * on an interactive TTY, and prints it instantly everywhere else.
 */
import { paint as c, gradient, isTty, sym } from './ui'

/** The face as plain text, one row per line — pure, for tests and layout. */
export function faceRows(): string[] {
  // Every row is exactly W columns: a 40-wide box under a floating halo.
  const W = 43
  const inner = 40
  const centre = (s: string, inW: number): string => {
    const l = Math.floor((inW - s.length) / 2)
    return ' '.repeat(l) + s + ' '.repeat(inW - s.length - l)
  }
  const boxRow = (s: string): string => ` │${centre(s, inner)}│`
  const halo = '·  ·  ·  ·  ·  ·  ·  ·  ·'
  return [
    centre(halo, W),
    ` ╭${'─'.repeat(inner)}╮`,
    boxRow(''),
    boxRow('######          ######'),
    boxRow('######          ######'),
    boxRow(''),
    boxRow('M  Y  T  O'),
    boxRow('\\────────────────/'),
    boxRow(''),
    ` ╰${'─'.repeat(inner)}╯`
  ]
}

/** The face, coloured: violet halo, cyan eyes, gradient wordmark, gray frame. */
export function faceLines(): string[] {
  return faceRows().map((row) => {
    if (row.includes('·')) return c.violet(row) // halo
    if (row.includes('######')) return row.replace(/######/g, (m) => c.cyan(m)) // eyes
    if (row.includes('M  Y  T  O')) return row.replace('M  Y  T  O', (m) => c.bold(gradient(m))) // wordmark
    return c.gray(row) // border, padding, smile
  })
}

/** Blink frame — eyes closed (a thin line) for the boot beat. */
export function faceLinesBlink(): string[] {
  return faceLines().map((l) => l.replace(/######/, '  ──  ').replace(/######/, '  ──  '))
}

/**
 * One dashboard line under the face: folder · model · provider. Tilde-collapses
 * the home directory so the line stays short. Pure apart from reading HOME.
 */
export function dashboardLine(parts: { workspace: string; model: string; provider: string }): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const short = home && parts.workspace.startsWith(home) ? '~' + parts.workspace.slice(home.length) : parts.workspace
  return [
    `${c.gray(sym.dot)} ${c.cyan(short)}`,
    `${c.gray('◆')} ${parts.model ? c.cyan(parts.model) : c.amber('no model')}`,
    `${c.gray('☁')} ${c.gray(parts.provider)}`
  ].join('  ')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Draw the face: on a TTY the rows appear top-to-bottom (~40ms apart) with a
 * single blink beat, elsewhere it prints instantly. Resolves once settled.
 */
export async function bootFace(delay = 40): Promise<void> {
  const out = process.stdout
  if (!isTty) {
    out.write('\n' + faceLines().join('\n') + '\n')
    return
  }
  out.write('\n')
  const lines = faceLines()
  for (let i = 0; i < lines.length; i++) {
    // Blink beat: eyes shut on the row before the wordmark lands.
    if (i === 6) {
      out.write(faceLinesBlink()[3] + '\n')
      await sleep(90)
      out.write('\x1b[1A\r\x1b[K')
    }
    out.write(lines[i] + '\n')
    await sleep(delay)
  }
}
