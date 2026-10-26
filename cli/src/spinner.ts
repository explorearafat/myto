/*
 * The animated status spinner for the Myto CLI — a Claude-style single-line
 * "✻ Thinking… (3s · esc to interrupt)" that ticks while the agent generates or
 * executes, and is cleared the moment real output arrives. Off-TTY (pipes, CI)
 * it is a silent no-op so scripted output stays clean.
 */
import { paint as c, isTty } from './ui'

const FRAMES = ['✻', '✽', '✶', '✳', '✢', '✧']

/** The frame glyph for a tick index — pure, so tests can assert rotation. */
export function spinnerFrame(tick: number): string {
  const n = FRAMES.length
  return FRAMES[((tick % n) + n) % n]
}

export interface Spinner {
  /** Swap the verb and restart the elapsed clock (a new phase of work). */
  setVerb(verb: string): void
  /** Clear the line and stop ticking; safe to call more than once. */
  stop(): void
  /** Whether the spinner ever drew (true only on an interactive TTY). */
  readonly live: boolean
}

/** Render one spinner line — exposed for tests. */
export function spinnerLine(glyph: string, verb: string, seconds: number, hint: string): string {
  const secs = seconds > 0 ? ` ${seconds}s` : ''
  return `${c.violet(glyph)} ${c.bold(verb)}…${c.dim(` (${secs} · ${hint})`)}`
}

/**
 * Start a spinner. Only one should run at a time: it owns the cursor line and
 * `stop()` is expected before any other stdout write lands.
 */
export function startSpinner(verb = 'Thinking', hint = 'esc to interrupt'): Spinner {
  if (!isTty) return { setVerb: () => {}, stop: () => {}, live: false }
  const out = process.stdout
  let tick = 0
  let verbNow = verb
  let startedAt = Date.now()
  let timer: NodeJS.Timeout | null = null
  let drew = false
  let stopped = false

  const draw = (): void => {
    const secs = Math.floor((Date.now() - startedAt) / 1000)
    out.write('\r\x1b[K' + spinnerLine(spinnerFrame(tick++), verbNow, secs, hint))
    drew = true
  }

  timer = setInterval(draw, 90)
  draw()

  return {
    setVerb(v: string): void {
      verbNow = v
      startedAt = Date.now()
    },
    stop(): void {
      if (stopped) return
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (drew) out.write('\r\x1b[K')
    },
    get live(): boolean {
      return !stopped
    }
  }
}
