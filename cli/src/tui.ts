/*
 * Rich two-pane TUI rendering for the Myto CLI — the welcome dashboard, the live
 * run view (plan · steps · diffs · results) and the status sidebar. Pure string
 * composition: every function returns text, so rendering stays testable (strip
 * the colour, assert structure) and degrades to clean plain text when stdout is
 * not a TTY. The layout is adapted from the desktop app's Build pane.
 */
import { paint as c, gradient, stripAnsi, sym, colorOn } from './ui'

/** Clamp the usable width to a comfortable band regardless of the real terminal. */
export function width(): number {
  const cols = process.stdout.columns || 96
  return Math.max(76, Math.min(cols, 104))
}

/** Visible length (ANSI stripped) — good enough for the ASCII-ish content here. */
export function vlen(s: string): number {
  return stripAnsi(s).length
}

/** Pad a (possibly coloured) string with spaces on the right to a visible width. */
export function padEnd(s: string, w: number): string {
  const pad = w - vlen(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

/** Right-align a (possibly coloured) string within width w. */
export function padStart(s: string, w: number): string {
  const pad = w - vlen(s)
  return pad > 0 ? ' '.repeat(pad) + s : s
}

/** Centre a (possibly coloured) label within width w. */
export function center(s: string, w: number): string {
  const pad = Math.max(0, w - vlen(s))
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + s + ' '.repeat(pad - left)
}

/** The window-chrome strip: traffic lights, a centred title, a gradient rule. */
export function chrome(title: string): string {
  const w = width()
  const lights = `${c.red('●')} ${c.amber('●')} ${c.green('●')}`
  const rest = w - vlen(lights) - 1
  return `${lights} ${center(c.dim(title), rest)}\n${gradient('─'.repeat(w))}`
}

/** The interlocking-loops monogram (3 lines), gradient-tinted. */
export function logoLines(): string[] {
  return [' _   _', '/ \\_/ \\', '\\_/ \\_/'].map((l) => gradient(l))
}

/** Big-ish gradient wordmark for the header. */
export function wordmark(): string {
  return c.bold(gradient('myto'))
}

/** A filled status pill, e.g. BYOK / Active. Falls back to [brackets] without colour. */
export function badge(text: string, rgbTriplet: [number, number, number] = [74, 222, 128]): string {
  if (!colorOn) return `[${text}]`
  const [r, g, b] = rgbTriplet
  return `\x1b[48;2;${r};${g};${b}m\x1b[38;2;18;18;20m ${text} \x1b[0m`
}

/** An outlined chip for an agent / quick action. */
export function pill(label: string, icon = ''): string {
  const inner = icon ? `${icon} ${label}` : label
  return `${c.gray('(')} ${inner} ${c.gray(')')}`
}

/** A horizontal progress bar: filled green, remainder dim, with a count suffix. */
export function progressBar(done: number, total: number, w = 24): string {
  const t = Math.max(total, 1)
  const filled = Math.max(0, Math.min(w, Math.round((done / t) * w)))
  return `${c.green('█'.repeat(filled))}${c.gray('░'.repeat(w - filled))} ${c.dim(`${done}/${total}`)}`
}

/** The leading glyph for a run step by state. */
export function stepGlyph(state: 'done' | 'active' | 'pending' | 'fail'): string {
  if (state === 'done') return c.green('●')
  if (state === 'active') return c.cyan('◉')
  if (state === 'fail') return c.red(sym.cross)
  return c.gray('○')
}

export interface BoxOpts {
  lines: string[]
  width: number
  title?: string
  titleRight?: string
  accent?: (s: string) => string
}

/** A rounded box with an optional title (left) and status (right) on the top edge. */
export function box(o: BoxOpts): string[] {
  const accent = o.accent ?? c.gray
  const textW = o.width - 4
  const titleStr = o.title ? ` ${c.bold(o.title)} ` : ''
  const rightStr = o.titleRight ? ` ${o.titleRight} ` : ''
  const fill = Math.max(0, o.width - 4 - vlen(titleStr) - vlen(rightStr))
  const top = accent('╭─') + titleStr + accent('─'.repeat(fill)) + rightStr + accent('─╮')
  const body = o.lines.map((l) => `${accent('│')} ${padEnd(l, textW)} ${accent('│')}`)
  const bottom = accent('╰' + '─'.repeat(o.width - 2) + '╯')
  return [top, ...body, bottom]
}

/** Compose a main column and a right sidebar with a continuous vertical divider. */
export function twoColumn(left: string[], right: string[], leftW: number): string[] {
  const n = Math.max(left.length, right.length)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`${padEnd(left[i] ?? '', leftW)} ${c.gray('│')} ${right[i] ?? ''}`)
  }
  return out
}

export interface PanelSection {
  icon?: string
  title: string
  lines: string[]
}

/** The status sidebar: icon + UPPERCASE heading, then body lines, blank between. */
export function panel(sections: PanelSection[]): string[] {
  const out: string[] = []
  sections.forEach((s, i) => {
    if (i) out.push('')
    out.push(`${s.icon ? c.gray(s.icon) + ' ' : ''}${c.gray(s.title.toUpperCase())}`)
    for (const l of s.lines) out.push(l)
  })
  return out
}

/** A featherweight syntax tint for context lines (keywords + numbers). */
function tint(s: string): string {
  if (!colorOn) return s
  return s
    .replace(
      /\b(const|let|var|function|return|import|from|export|async|await|if|else|for|while|class|new|type|interface|def|public|private)\b/g,
      (m) => c.magenta(m)
    )
    .replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => c.amber(m))
}

export interface DiffLine {
  n?: number
  type: 'ctx' | 'add' | 'del'
  text: string
}

/** A code/diff viewer: a boxed file header with +/- counts, line numbers, tinted rows. */
export function diffBlock(file: string, lines: DiffLine[], w = width()): string[] {
  const add = lines.filter((l) => l.type === 'add').length
  const del = lines.filter((l) => l.type === 'del').length
  const counts = `${c.green('+' + add)} ${c.red('-' + del)}`
  const avail = w - 4 - 6 // box padding + "NNN s " gutter
  const rows = lines.map((l) => {
    const plain = l.text.replace(/\t/g, '  ')
    const shown = plain.length > avail ? plain.slice(0, Math.max(0, avail - 1)) + '…' : plain
    const num = c.gray(String(l.n ?? '').padStart(3))
    const sign = l.type === 'add' ? c.green('+') : l.type === 'del' ? c.red('-') : ' '
    const body = l.type === 'add' ? c.green(shown) : l.type === 'del' ? c.red(shown) : tint(shown)
    return `${num} ${sign} ${body}`
  })
  return box({ title: file, titleRight: counts, lines: rows, width: w, accent: c.gray })
}

/** One run step: glyph · label (left) … meta · expander (right). */
export function stepLine(
  state: 'done' | 'active' | 'pending' | 'fail',
  label: string,
  meta = '',
  w = width()
): string {
  const left = `  ${stepGlyph(state)} ${state === 'pending' ? c.gray(label) : label}`
  const right = `${meta ? c.gray(meta) + '  ' : ''}${c.gray('›')}`
  const gap = Math.max(1, w - vlen(left) - vlen(right))
  return left + ' '.repeat(gap) + right
}

export interface SidebarState {
  version: string
  provider: string
  providerUrl?: string
  model: string
  models?: string[]
  ready?: boolean
  workspace?: string
}

/** The welcome screen — Freebuff × Claude hybrid: block wordmark, tips, status bar, input. */
export function welcome(state: SidebarState, suggest: string[]): string {
  const provider = state.provider + (state.providerUrl ? c.dim('  ' + state.providerUrl) : '')
  return [
    '',
    ...blockWordmark(),
    '',
    `${c.bold('Myto')} ${c.gray('will run commands on your behalf to help you build.')}`,
    '',
    `${c.gray('Directory')}  ${c.dim(state.workspace ?? process.cwd())}`,
    `${c.gray('Model')}  ${state.model ? c.cyan(state.model) : c.red('(none)')}   ${c.gray('Provider')}  ${provider}`,
    '',
    suggestions(suggest),
    '',
    statusBar(`● myto · ${state.model || 'no model set'}`, 'type a task  ·  / for commands  ·  Ctrl-C to exit'),
    ''
  ].join('\n')
}

export interface RunState {
  version: string
  task: string
  model: string
  fallback?: string
  workspace: string
  byok?: boolean
}

/** The run header — Freebuff style: a rule, then the task echoed with a time + green bar. */
export function runHeader(s: RunState): string {
  const w = width()
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const task = s.task.length > w - 4 ? s.task.slice(0, w - 5) + '…' : s.task
  return [
    '',
    gradient('─'.repeat(w)),
    `${c.gray('[' + time + ']')}  ${c.gray(s.model)} ${s.byok ? badge('BYOK', [167, 139, 250]) : ''}${s.fallback ? c.dim('  ↳ ' + s.fallback) : ''}`,
    `${c.green('▌')} ${c.bold(task)}`,
    c.dim(s.workspace),
    ''
  ].join('\n')
}

export interface SummaryState {
  files: number
  add: number
  del: number
  turns: number
  tests?: string
}

/** The run footer — a rule, then a done bullet with the changes tally. */
export function summary(s: SummaryState): string {
  const w = width()
  const lines = ['', gradient('─'.repeat(w))]
  if (s.tests) lines.push(`${c.green(sym.check)} ${c.bold('Tests passed')} ${c.dim('· ' + s.tests)}`)
  lines.push(
    `${c.green(sym.spark)} ${c.bold('Done')}   ${c.bold(String(s.files))} ${c.gray('files')}  ${c.green('+' + s.add)} ${c.red('-' + s.del)}  ${c.gray(s.turns + ' turns')}`,
    ''
  )
  return lines.join('\n')
}

/** The chunky 5-row block wordmark, tinted green→white top-to-bottom (the glow). */
const MYTO_ROWS = [
  '█   █ █   █ █████ █████',
  '██ ██  █ █    █   █   █',
  '█ █ █   █     █   █   █',
  '█   █   █     █   █   █',
  '█   █   █     █   █████'
]
export function blockWordmark(): string[] {
  if (!colorOn) return MYTO_ROWS
  const n = MYTO_ROWS.length - 1
  return MYTO_ROWS.map((row, i) => {
    const t = i / n
    const r = Math.round(74 + (240 - 74) * t)
    const g = Math.round(222 + (246 - 222) * t)
    const b = Math.round(128 + (252 - 128) * t)
    return `\x1b[1m\x1b[38;2;${r};${g};${b}m${row}\x1b[0m`
  })
}

/** A full-width inverse status strip: left label, right actions. */
export function statusBar(left: string, right: string): string {
  const w = width()
  const l = ` ${left}`
  const r = `${right} `
  const mid = Math.max(1, w - vlen(l) - vlen(r))
  const text = l + ' '.repeat(mid) + r
  return colorOn ? `\x1b[48;2;30;31;38m\x1b[38;2;205;205;212m${text}\x1b[0m` : text
}

/** A rounded input box with a green cursor and a dim placeholder. */
export function inputBox(placeholder: string): string {
  const w = width()
  const inner = w - 4
  const line = `${c.green('▌')} ${c.dim(placeholder)}`
  return [
    c.gray('╭' + '─'.repeat(w - 2) + '╮'),
    `${c.gray('│')} ${padEnd(line, inner)} ${c.gray('│')}`,
    c.gray('╰' + '─'.repeat(w - 2) + '╯')
  ].join('\n')
}

/** "Try one of these:" with green arrow suggestions. */
export function suggestions(items: string[]): string {
  return [c.gray('Try one of these:'), ...items.map((s) => `${c.green('→')} ${s}`)].join('\n')
}

/** A Claude-style activity bullet: • Title, with optional dim/italic body. */
export function bullet(title: string, body = '', kind: 'think' | 'act' | 'done' | 'fail' = 'act'): string {
  const dot = kind === 'think' ? c.gray('•') : kind === 'fail' ? c.red('•') : kind === 'done' ? c.green('•') : c.cyan('•')
  const head = `${dot} ${kind === 'think' ? c.gray(title) : c.bold(title)}`
  if (!body) return head
  const lines = body.split('\n').map((l) => `  ${c.dim(l)}`)
  return [head, ...lines].join('\n')
}

/** A TODO checklist bullet, mirroring the plan the agent is working through. */
export function todos(items: { done: boolean; text: string }[]): string {
  const head = `${c.cyan('•')} ${c.bold('TODOs')}`
  const rows = items.map((t) => `  ${t.done ? c.green('☑') : c.gray('☐')} ${t.done ? c.dim(t.text) : t.text}`)
  return [head, ...rows].join('\n')
}

// __TUI_APPEND__

