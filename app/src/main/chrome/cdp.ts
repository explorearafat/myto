/**
 * A tiny Chrome DevTools Protocol client — enough of it to drive a real Chrome, and
 * nothing more.
 *
 * Why hand-rolled rather than puppeteer: CDP is plain JSON over a single WebSocket
 * (requests correlated by `id`, plus unsolicited events), Electron already provides a
 * global `WebSocket`, and Sylor needs roughly eight protocol methods. A browser
 * automation dependency here would be install weight without leverage.
 *
 * The socket is injected, so everything that can actually go wrong — id correlation,
 * per-call timeouts, session routing, pending calls when the connection drops — is
 * unit tested without a browser or a network.
 */

/** The slice of the WebSocket API this client uses. */
export interface CdpSocket {
  send(data: string): void
  close(): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void
  ): void
}

/** Opens a socket to `url`. Injected so tests can supply a fake. */
export type CreateSocket = (url: string) => CdpSocket

/** A CDP event: `Page.frameNavigated`, `Target.attachedToTarget`… */
export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  /** Present when the event came from an attached target's session. */
  sessionId?: string
}

/** How long one command may take before we stop waiting for its answer. */
export const CALL_TIMEOUT_MS = 20_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** The real factory. Kept behind a `globalThis` lookup so this file needs no DOM lib. */
export const webSocketFactory: CreateSocket = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => CdpSocket }).WebSocket
  if (!Ctor) throw new Error('This runtime has no WebSocket, so Sylor cannot reach Chrome.')
  return new Ctor(url)
}

/**
 * One live DevTools connection. Construct it with `CdpClient.connect`, which resolves
 * only once the socket is open, so callers never race the handshake.
 */
export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, Set<(event: CdpEvent) => void>>()
  private closed = false
  private closeError: Error | null = null

  private constructor(private readonly socket: CdpSocket) {
    socket.addEventListener('message', (event) => this.receive(event))
    socket.addEventListener('close', () => this.fail(new Error('The Chrome connection closed.')))
    socket.addEventListener('error', () => this.fail(new Error('The Chrome connection failed.')))
  }

  static connect(
    url: string,
    createSocket: CreateSocket = webSocketFactory,
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let socket: CdpSocket
      try {
        socket = createSocket(url)
      } catch (err) {
        reject(asError(err))
        return
      }
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        done(() => {
          try {
            socket.close()
          } catch {
            /* already gone */
          }
          reject(new Error(`Timed out connecting to Chrome at ${url}.`))
        })
      }, timeoutMs)
      socket.addEventListener('open', () => done(() => resolve(new CdpClient(socket))))
      socket.addEventListener('error', () =>
        done(() => reject(new Error(`Could not connect to Chrome at ${url}.`)))
      )
      socket.addEventListener('close', () =>
        done(() => reject(new Error(`Chrome closed the connection at ${url} before it opened.`)))
      )
    })
  }

  /**
   * Call a CDP method. `sessionId` addresses an attached target (a tab); without it
   * the command goes to the browser itself.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error('The Chrome connection is closed.'))
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method }
    if (params) payload.params = params
    if (sessionId) payload.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome did not answer ${method} within ${timeoutMs}ms.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.socket.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(asError(err))
      }
    })
  }

  /** Subscribe to an event. Returns the unsubscribe. */
  on(method: string, handler: (event: CdpEvent) => void): () => void {
    const set = this.handlers.get(method) ?? new Set<(event: CdpEvent) => void>()
    set.add(handler)
    this.handlers.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(method)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Hang up. Pending calls reject; further calls reject immediately. */
  close(): void {
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
    this.fail(new Error('Sylor closed the Chrome connection.'))
  }

  /** Route one frame: an answer to a pending call, or an event to its subscribers. */
  private receive(event: unknown): void {
    const data = (event as { data?: unknown } | null)?.data
    if (typeof data !== 'string') return
    let message: {
      id?: number
      result?: unknown
      error?: { message?: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      message = JSON.parse(data)
    } catch {
      return // Not our protocol; ignoring is safer than throwing inside a listener.
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return // Timed out already, or a duplicate answer.
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Chrome rejected the command.'))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (!message.method) return
    const listeners = this.handlers.get(message.method)
    if (!listeners) return
    const emitted: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      sessionId: message.sessionId
    }
    // Copy first: a handler may unsubscribe itself while we iterate.
    for (const listener of [...listeners]) {
      try {
        listener(emitted)
      } catch (err) {
        console.error('[sylor] a Chrome event handler threw:', err)
      }
    }
  }

  /** Mark the connection dead and reject everything still waiting on it. */
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.handlers.clear()
  }


}

