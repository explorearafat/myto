/*
 * The docked screen shell. On an interactive terminal the session runs on the
 * alternate screen buffer with a fixed layout: the face + dashboard pinned to
 * the top, a message scroll region in the middle, and the input box docked at
 * the bottom. Every update is in place — arrow keys change only the focused
 * thing, tool output scrolls inside its region, and nothing ever reprints the
 * frame. Without a TTY (pipes, CI) every function here is a no-op and callers
 * fall back to plain sequential printing.
 */
import { isTty } from './ui'

interface Layout {
  /** 1-based absolute rows. */
  faceRows: number
  regionTop: number
  regionBottom: number
  inputTop: number
  rows: number
  cols: number
}

let L: Layout | null = null
let raw = false // a modal widget (menu/editor) owns the cursor
let caret = { row: 1, col: 1 } // where the docked caret rests between writes
let redrawInput: (() => void) | null = null
const origWrite = process.stdout.write.bind(process.stdout)

const pos = (row: number, col: number): string => `\x1b[${row};${col}H`

/** The shell needs room for the frame, the input and a few message lines. */
export function supported(faceRowCount: number): boolean {
  return isTty && process.stdout.rows >= faceRowCount + 9 && process.stdout.columns >= 52
}

export function active(): boolean {
  return L !== null
}

/** Move the cursor to the message region and hand it the pen (modal widgets). */
export function focus(): void {
  if (!L) return
  raw = true
  origWrite(pos(L.regionBottom, 1))
}

/** Modal widget finished — put the caret back in the input box. */
export function unfocus(): void {
  if (!L) return
  raw = false
  origWrite(pos(caret.row, caret.col))
}

function hook(chunk: string | Uint8Array): boolean {
  if (!L || raw || typeof chunk !== 'string' || chunk.length === 0) return false
  // Spinner-style updates rewrite their own row inside the region.
  if (chunk.startsWith('\r')) {
    origWrite(pos(L.regionBottom, 1) + chunk)
    return true
  }
  origWrite(pos(L.regionBottom, 1) + chunk + pos(caret.row, caret.col))
  return true
}

/**
 * Enter the shell: alt screen, face block drawn at the top (row by row when
 * `animateMs` > 0), scroll region for messages, input docked at the bottom.
 * `drawInput` is kept and replayed on every resize.
 */
export async function enter(face: string[], drawInput: () => void, animateMs = 0): Promise<void> {
  const out = process.stdout
  const rows = out.rows || 24
  const cols = out.columns || 96
  const faceRows = face.length + 1 // + the blank spacer under it
  if (!supported(faceRows)) return
  L = { faceRows, regionTop: faceRows + 1, regionBottom: rows - 5, inputTop: rows - 4, rows, cols }
  redrawInput = drawInput
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J') // alt screen, hide cursor, clear
  if (animateMs > 0) {
    for (let i = 0; i < face.length; i++) {
      origWrite(pos(i + 1, 1) + face[i])
      await new Promise((r) => setTimeout(r, animateMs))
    }
  } else {
    out.write(face.map((l, i) => pos(i + 1, 1) + l).join(''))
  }
  applyRegion()
  drawInput()
  hookOn()
}

function applyRegion(): void {
  if (!L) return
  origWrite(`\x1b[${L.regionTop};${L.regionBottom}r`) // message scroll region
  origWrite(pos(L.regionTop, 1))
}

function hookOn(): void {
  const out = process.stdout
  ;(out as unknown as { write: (c: string | Uint8Array) => boolean }).write = (chunk: string | Uint8Array): boolean => {
    if (hook(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))) return true
    return origWrite(chunk)
  }
}

function hookOff(): void {
  ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
}

/** Redraw the face block in place (dashboard value changed, selection moved). */
export function setFace(face: string[]): void {
  if (!L) return
  const keep = raw
  raw = true
  origWrite(face.map((l, i) => pos(i + 1, 1) + l + '\x1b[K').join('') + '\n')
  raw = keep
  if (!keep) origWrite(pos(caret.row, caret.col))
}

/** Terminal resized: recompute the layout and repaint the frame. */
export function relayout(): void {
  if (!L) return
  const out = process.stdout
  const rows = out.rows || 24
  const cols = out.columns || 96
  const faceRows = L.faceRows
  L = { faceRows, regionTop: faceRows + 1, regionBottom: rows - 5, inputTop: rows - 4, rows, cols }
  origWrite('\x1b[2J')
  applyRegion()
  redrawInput?.()
}

/** Where the docked caret currently rests (set by the input editor). */
export function setInputCaret(row: number, col: number): void {
  caret = { row, col }
}

/**
 * Paint the docked input block (menu rows above the box + box + strip) at the
 * fixed bottom rows, then rest the caret. Pure redraw — nothing scrolls.
 */
export function drawInputRows(rows: string[], caretCol: number): void {
  if (!L) return
  const above = rows.length - 4 // menu rows drawn above the 3 box rows + strip
  const start = Math.max(L.regionTop, L.inputTop - Math.max(0, above))
  raw = true
  rows.forEach((r, i) => origWrite(pos(start + i, 1) + r + '\x1b[K'))
  origWrite('\x1b[K') // clear any leftover row between the block and the bottom
  caret = { row: L.inputTop + 1, col: Math.max(3, caretCol) }
  raw = false
  origWrite(pos(caret.row, caret.col))
}

/** Absolute rows of the docked input box, for the editor's painter. */
export function inputOrigin(): { top: number; rows: number; cols: number } | null {
  return L ? { top: L.inputTop, rows: L.rows, cols: L.cols } : null
}

/** Leave the shell and restore the normal screen. Safe to call twice. */
export function leave(): void {
  if (!L) return
  hookOff()
  L = null
  raw = false
  redrawInput = null
  origWrite('\x1b[r\x1b[?25h\x1b[?1049l')
}

/** Best-effort restore for hard exits (double Ctrl-C). */
export function hardExitRestore(): void {
  if (L) {
    hookOff()
    L = null
  }
  origWrite('\x1b[r\x1b[?25h\x1b[?1049l')
}
