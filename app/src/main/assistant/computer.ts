import { PsHost, type HostResult } from './pshost'

/**
 * The Assistant's computer actions on top of the resident PowerShell host.
 * Every action ships a compact script that prints a `RESULT:` line (usually
 * JSON) so the caller gets structured data back. Pure helpers — the SendKeys
 * escaper, the combo mapper and the script builders — are exported for tests;
 * the spawn-based reality is exercised by computer.live.test.ts on Windows.
 */

export type ComputerAction =
  | 'open'
  | 'key'
  | 'type'
  | 'paste'
  | 'click'
  | 'doubleclick'
  | 'rightclick'
  | 'move'
  | 'scroll'
  | 'clipboard-get'
  | 'clipboard-set'
  | 'window-list'
  | 'window-focus'
  | 'active-window'

export interface ActionResult {
  ok: boolean
  detail: string
  ms: number
  /** Extra payload — e.g. the clipboard text, the window list, a screenshot path. */
  data?: unknown
  why?: HostResult['why']
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Escape a literal string for WScript.Shell SendKeys — specials become {x}. */
export function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}[\]])/g, (_m, c: string) => `{${c}}`)
}

const KEY_NAMES: Record<string, string> = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  space: ' ',
  win: '^({ESC})'
}

/** Map a human combo ("ctrl+shift+end", "enter", "alt+f4") to SendKeys syntax. */
export function toSendKeys(combo: string): string {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return ''
  let mods = ''
  let keyPart = ''
  for (const p of parts) {
    const lower = p.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') mods += '^'
    else if (lower === 'alt') mods += '%'
    else if (lower === 'shift') mods += '+'
    else if (p.length === 1) keyPart += p
    else if (KEY_NAMES[lower]) keyPart = KEY_NAMES[lower]
    else if (/^f\d{1,2}$/.test(lower)) keyPart = `{${p.toUpperCase()}}`
    else keyPart += escapeSendKeys(p)
  }
  if (!keyPart) return mods
  // Multi-char literal keys need braces; single chars go bare.
  const wrapped = keyPart.length > 1 && !/^\{.*\}$/.test(keyPart) && /^[a-zA-Z0-9]+$/.test(keyPart)
    ? `{${keyPart}}`
    : keyPart
  return mods.length > 1 ? `(${mods}${wrapped})` : mods + wrapped
}

/** Quote one string for embedding in a single-quoted PowerShell literal. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** The screenshot path convention under the assistant's capture folder. */
export function capturePath(dir: string, stamp = new Date()): string {
  const t = stamp.toISOString().replace(/[:T]/g, '-').slice(0, 19)
  return `${dir}\\capture-${t}-${Math.floor(Math.random() * 1e4)}.png`
}

// ── The controller ───────────────────────────────────────────────────────────

export class Computer {
  private host: PsHost

  constructor(host?: PsHost) {
    this.host = host ?? new PsHost()
  }

  get ready(): boolean {
    return this.host.isWarm
  }

  async warmup(): Promise<void> {
    await this.host.start()
  }

  stop(): void {
    this.host.kill()
  }

  private async act(script: string, timeoutMs?: number): Promise<HostResult> {
    return this.host.run(script, timeoutMs ? { timeoutMs } : undefined)
  }

  private static toAction(r: HostResult, data?: unknown): ActionResult {
    return { ok: r.ok, detail: r.ok ? r.out : r.err || r.out || 'the action failed', ms: r.ms, data, why: r.why }
  }

  /** Open an app name, URL, or file path with the OS handler. */
  async open(target: string): Promise<ActionResult> {
    const r = await this.act(`Start-Process ${psQuote(target)}; Write-Output 'RESULT:opened ${psQuote(target)}'`, 6000)
    return Computer.toAction(r)
  }

  /** Press a key combo ("ctrl+s", "enter", "alt+f4"). */
  async key(combo: string): Promise<ActionResult> {
    const keys = toSendKeys(combo)
    if (!keys) return { ok: false, detail: `unknown key combo "${combo}"`, ms: 0 }
    const r = await this.act(`(New-Object -ComObject WScript.Shell).SendKeys(${psQuote(keys)}); Write-Output 'RESULT:pressed ${psQuote(combo)}'`)
    return Computer.toAction(r)
  }

  /** Type literal text into the focused control (SendKeys; use paste for long text). */
  async type(text: string): Promise<ActionResult> {
    const r = await this.act(`(New-Object -ComObject WScript.Shell).SendKeys(${psQuote(escapeSendKeys(text))}); Write-Output 'RESULT:typed'`)
    return Computer.toAction(r)
  }

  /**
   * Paste long text FAST and unicode-safe: clipboard set, then Ctrl+V. A 500-
   * word message "types" in ~40ms instead of seconds and never drops accents.
   */
  async paste(text: string, pressEnter = false): Promise<ActionResult> {
    const enter = pressEnter ? "(New-Object -ComObject WScript.Shell).SendKeys('{ENTER}'); " : ''
    const r = await this.act(
      `Set-Clipboard -Value ${psQuote(text)}; (New-Object -ComObject WScript.Shell).SendKeys('^v'); ${enter}Write-Output 'RESULT:pasted'`
    )
    return Computer.toAction(r)
  }

  async click(x: number, y: number, kind: 'left' | 'double' | 'right' = 'left'): Promise<ActionResult> {
    const down = kind === 'right' ? 8 : 2
    const up = kind === 'right' ? 16 : 4
    const twice = kind === 'double' ? '[Myto.Mouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Myto.Mouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero); ' : ''
    const script =
      `[Myto.Mouse]::SetCursorPos(${Math.round(x)},${Math.round(y)}); ` +
      '[Start-Sleep -Milliseconds 30]; ' +
      '[Myto.Mouse]::mouse_event(' + down + ',0,0,0,[UIntPtr]::Zero); ' +
      '[Myto.Mouse]::mouse_event(' + up + ',0,0,0,[UIntPtr]::Zero); ' +
      twice +
      "Write-Output 'RESULT:clicked'"
    const r = await this.act(script)
    return Computer.toAction(r)
  }

  async move(x: number, y: number): Promise<ActionResult> {
    const r = await this.act(`[Myto.Mouse]::SetCursorPos(${Math.round(x)},${Math.round(y)}); Write-Output 'RESULT:moved'`)
    return Computer.toAction(r)
  }

  async scroll(notches: number): Promise<ActionResult> {
    const amount = 0x78 * Math.round(notches) // one wheel notch = 120
    const r = await this.act(`[Myto.Mouse]::mouse_event(0x800,0,0,${amount},[UIntPtr]::Zero); Write-Output 'RESULT:scrolled'`)
    return Computer.toAction(r)
  }

  async clipboardSet(text: string): Promise<ActionResult> {
    const r = await this.act(`Set-Clipboard -Value ${psQuote(text)}; Write-Output 'RESULT:clipboard set'`)
    return Computer.toAction(r)
  }

  async clipboardGet(): Promise<ActionResult> {
    const r = await this.act(`Write-Output ('RESULT:' + (Get-Clipboard -Raw))`)
    return Computer.toAction(r, r.out)
  }

  /** List windows with titles (the picker for "which app are we talking in?"). */
  async windowList(): Promise<ActionResult> {
    const script =
      "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 40 | " +
      "ForEach-Object { Write-Output ('RESULT-W:' + $_.MainWindowTitle) }; Write-Output 'RESULT:listed'"
    const r = await this.act(script)
    const windows = (r.out.match(/RESULT-W:(.*)/g) ?? []).map((l) => l.replace('RESULT-W:', '').trim()).filter(Boolean)
    return { ok: r.ok, detail: r.ok ? `${windows.length} window(s)` : r.err || 'failed', ms: r.ms, data: windows, why: r.why }
  }

  /** Bring a window whose title contains `title` to the foreground. */
  async windowFocus(title: string): Promise<ActionResult> {
    const script =
      `(New-Object -ComObject WScript.Shell).AppActivate(${psQuote(title)}); ` +
      "Write-Output 'RESULT:focused'"
    const r = await this.act(script, 3000)
    return Computer.toAction(r)
  }

  /** Title of the foreground window — the "what am I looking at" probe. */
  async activeWindow(): Promise<ActionResult> {
    const script =
      '$h=[Myto.Mouse]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512; ' +
      '[Myto.Mouse]::GetWindowText($h,$sb,512) | Out-Null; Write-Output ("RESULT:" + $sb.ToString())'
    const r = await this.act(script)
    return Computer.toAction(r)
  }
}

// Re-exports for callers that only want the action surface.
export { PsHost } from './pshost'
