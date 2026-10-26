import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * A resident PowerShell host — the Assistant's fast hands on Windows.
 *
 * Spawning powershell.exe per action costs 200-600ms of process start alone,
 * which would blow the <0.5s action budget before doing any work. So the host
 * spawns ONE powershell reading commands from stdin (`-Command -`) and keeps it
 * warm; every action ships a script + a sentinel line and resolves when the
 * sentinel comes back on stdout. Warm round-trips land around 20-80ms.
 *
 * Requests are strictly serialised (one in flight — the shell is a single
 * stream), each with its own timeout; a dead or wedged host is transparently
 * restarted once for the next request. Everything here is Windows-only: on any
 * other platform `run()` resolves an `unsupported` result so callers degrade
 * gracefully instead of spawning nothing.
 */

export interface HostResult {
  ok: boolean
  /** The action's own output (stdout between the markers), trimmed. */
  out: string
  /** Error text from PowerShell's stderr, when the action reported one. */
  err?: string
  /** Wall-clock round trip in milliseconds (warm actions: usually < 100). */
  ms: number
  /** 'unsupported' on non-Windows platforms; 'timeout' when the action hung. */
  why?: 'unsupported' | 'timeout' | 'crashed'
}

const SENTINEL = '__MYTO_PS_DONE__'

export interface PsHostOptions {
  timeoutMs?: number
  /** Injectable spawner for tests. */
  spawnFn?: typeof spawn
}

interface Pending {
  resolve: (r: HostResult) => void
  script: string
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  out: string[]
  err: string[]
  /** The sentinel ticket this request waits for — matched on arrival. */
  ticket: number
}

export class PsHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending: Pending | null = null
  private queue: Array<() => void> = []
  private seq = 0
  private busy = false
  private readonly timeoutMs: number
  private readonly spawnFn: typeof spawn
  /** Set once the first no-op round-trip lands — warm actions start here. */
  private warm = false

  constructor(opts: PsHostOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 4000
    this.spawnFn = opts.spawnFn ?? spawn
  }

  get isWarm(): boolean {
    return this.warm && this.child !== null && !this.child.killed
  }

  /** Platform gate — callers surface a readable message instead of spawning. */
  static get supported(): boolean {
    return process.platform === 'win32'
  }

  /** Spin the host up and prime .NET so the first real action is warm. */
  async start(): Promise<void> {
    if (!PsHost.supported) return
    if (this.child) return
    this.child = this.spawnFn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      if (this.pending) this.pending.err.push(chunk)
    })
    this.child.on('exit', () => this.onExit())
    this.child.on('error', () => this.onExit())
    // Prime: load the Win32 input assembly + .NET once, outside the action path.
    try {
      await this.run(MOUSE_PRELUDE, { timeoutMs: 15_000 })
      this.warm = true
    } catch {
      this.warm = false
    }
  }

  /**
   * Run one PowerShell snippet and resolve with its printed result. The script
   * MUST print a single line beginning with `RESULT:` carrying the payload —
   * helpers in computer.ts build that shape. Everything else on stdout before
   * the sentinel is captured as `out`.
   */
  async run(script: string, opts?: { timeoutMs?: number }): Promise<HostResult> {
    if (!PsHost.supported) {
      return { ok: false, out: '', err: 'Assistant automation is Windows-only right now.', ms: 0, why: 'unsupported' }
    }
    if (!this.child) await this.start()
    const ticket = ++this.seq
    return new Promise<HostResult>((resolve) => {
      const enqueue = (): void => {
        this.pending = {
          resolve,
          script,
          startedAt: Date.now(),
          timer: setTimeout(() => this.onTimeout(ticket), opts?.timeoutMs ?? this.timeoutMs),
          out: [],
          err: [],
          ticket
        }
        try {
          this.child?.stdin.write(script + `\nWrite-Output '${SENTINEL}:${ticket}'\n`)
        } catch {
          this.onExit()
          this.resolvePending({ ok: false, out: '', err: 'the automation host died', ms: 0, why: 'crashed' })
          void this.start()
        }
      }
      if (this.busy) this.queue.push(enqueue)
      else {
        this.busy = true
        enqueue()
      }
    })
  }

  /** Serialize one async job against the same queue as run() — for actions that compose several scripts. */
  async exclusive<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      const take = (): void => {
        void job().then((v) => {
          this.next()
          resolve(v)
        })
      }
      if (this.busy) this.queue.push(take as unknown as () => void)
      else {
        this.busy = true
        take()
      }
    })
  }

  private next(): void {
    const job = this.queue.shift()
    if (job) job()
    else this.busy = false
  }

  private onStdout(chunk: string): void {
    if (!this.pending) return
    this.pending.out.push(chunk)
    const buffered = this.pending.out.join('')
    const m = new RegExp(`${SENTINEL}:(\\d+)\\r?\\n`).exec(buffered)
    // Match the PENDING ticket, not the global counter: a queued request was
    // already counted in the sequence before its turn came.
    if (!m || Number(m[1]) !== this.pending.ticket) return
    const result = buffered.slice(0, m.index)
    const errLine = /RESULT-ERROR:(.*)/.exec(result)?.[1]
    this.resolvePending({
      ok: !errLine,
      out: result.replace(/RESULT-ERROR:.*\r?\n?/g, '').trim(),
      err: errLine?.trim() || this.pending.err.join('').trim() || undefined,
      ms: Date.now() - this.pending.startedAt
    })
  }

  private resolvePending(r: HostResult): void {
    const p = this.pending
    if (!p) return
    clearTimeout(p.timer)
    this.pending = null
    this.next()
    p.resolve(r)
  }

  private onTimeout(ticket: number): void {
    if (!this.pending || ticket !== this.seq) return
    this.kill()
    this.resolvePending({
      ok: false,
      out: '',
      err: `the action took over ${this.timeoutMs}ms and was stopped`,
      ms: this.timeoutMs,
      why: 'timeout'
    })
    void this.start()
  }

  private onExit(): void {
    if (this.pending) {
      this.resolvePending({ ok: false, out: '', err: 'the automation host exited unexpectedly', ms: 0, why: 'crashed' })
    }
    this.child = null
    this.warm = false
  }

  /** Stop the host — turning the assistant off or closing the app must release it. */
  kill(): void {
    try {
      this.child?.stdin.end()
      this.child?.kill()
    } catch {
      /* already gone */
    }
    this.child = null
    this.warm = false
  }
}

/** One-time Add-Type for mouse control (compiled into the primed AppDomain). */
export const MOUSE_PRELUDE = `
if (-not ('MytoMouse' -as [type])) {
  Add-Type -Namespace Myto -Name Mouse -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
'@
}
`
