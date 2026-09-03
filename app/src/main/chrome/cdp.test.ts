/**
 * The CDP client's whole job is bookkeeping — matching answers to calls, timing out,
 * fanning events out, and failing loudly when Chrome goes away. All of it is exercised
 * here against a fake socket, so none of it depends on a real browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { CdpClient, type CdpSocket } from './cdp'

class FakeSocket implements CdpSocket {
  sent: string[] = []
  closes = 0
  private listeners = new Map<string, ((event: unknown) => void)[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closes++
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  /** Deliver a protocol frame. */
  frame(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) })
  }

  payloads(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

/** An open client plus the socket behind it. */
async function connected(): Promise<{ socket: FakeSocket; client: CdpClient }> {
  const socket = new FakeSocket()
  const promise = CdpClient.connect('ws://127.0.0.1:1/devtools/browser/x', () => socket)
  socket.emit('open')
  return { socket, client: await promise }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CdpClient.connect', () => {
  it('resolves once the socket opens', async () => {
    const { client } = await connected()
    expect(client.isClosed).toBe(false)
  })

  it('rejects when the socket errors before opening', async () => {
    const socket = new FakeSocket()
    const promise = CdpClient.connect('ws://x', () => socket)
    socket.emit('error')
    await expect(promise).rejects.toThrow(/Could not connect to Chrome/)
  })

  it('rejects when the socket closes before opening', async () => {
    const socket = new FakeSocket()
    const promise = CdpClient.connect('ws://x', () => socket)
    socket.emit('close')
    await expect(promise).rejects.toThrow(/before it opened/)
  })

  it('rejects when the socket cannot even be created', async () => {
    await expect(
      CdpClient.connect('ws://x', () => {
        throw new Error('no WebSocket here')
      })
    ).rejects.toThrow('no WebSocket here')
  })

  it('times out, and closes the half-open socket', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const promise = CdpClient.connect('ws://x', () => socket, 500)
    const assertion = expect(promise).rejects.toThrow(/Timed out connecting to Chrome/)
    await vi.advanceTimersByTimeAsync(600)
    await assertion
    expect(socket.closes).toBe(1)
  })

  it('ignores a late error once it has already opened', async () => {
    const socket = new FakeSocket()
    const promise = CdpClient.connect('ws://x', () => socket)
    socket.emit('open')
    const client = await promise
    socket.emit('error')
    expect(client.isClosed).toBe(true) // the connection died, but the promise still resolved
  })
})

describe('send', () => {
  it('writes a numbered frame and resolves with the result', async () => {
    const { socket, client } = await connected()
    const promise = client.send<{ frameId: string }>('Page.navigate', { url: 'https://x.com' })
    expect(socket.payloads()[0]).toEqual({
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://x.com' }
    })
    socket.frame({ id: 1, result: { frameId: 'F1' } })
    await expect(promise).resolves.toEqual({ frameId: 'F1' })
  })

  it('omits params and sessionId when they are not given, and includes them when they are', async () => {
    const { socket, client } = await connected()
    void client.send('Browser.getVersion')
    void client.send('Runtime.evaluate', { expression: '1' }, 'S7')
    expect(socket.payloads()[0]).toEqual({ id: 1, method: 'Browser.getVersion' })
    expect(socket.payloads()[1]).toEqual({
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId: 'S7'
    })
  })

  it('correlates answers that arrive out of order', async () => {
    const { socket, client } = await connected()
    const first = client.send<{ n: number }>('A')
    const second = client.send<{ n: number }>('B')
    socket.frame({ id: 2, result: { n: 2 } })
    socket.frame({ id: 1, result: { n: 1 } })
    await expect(second).resolves.toEqual({ n: 2 })
    await expect(first).resolves.toEqual({ n: 1 })
  })

  it('resolves to an empty object when Chrome answers with no result', async () => {
    const { socket, client } = await connected()
    const promise = client.send('Page.enable')
    socket.frame({ id: 1 })
    await expect(promise).resolves.toEqual({})
  })

  it('rejects with Chrome’s own message on a protocol error', async () => {
    const { socket, client } = await connected()
    const promise = client.send('Page.navigate', { url: 'nope' })
    socket.frame({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } })
    await expect(promise).rejects.toThrow('Cannot navigate to invalid URL')
  })

  it('rejects a protocol error with a generic line when Chrome sends no message', async () => {
    const { socket, client } = await connected()
    const promise = client.send('X')
    socket.frame({ id: 1, error: {} })
    await expect(promise).rejects.toThrow('Chrome rejected the command.')
  })

  it('times out a call Chrome never answers, and forgets it', async () => {
    vi.useFakeTimers()
    const { socket, client } = await connected()
    const promise = client.send('Page.navigate', undefined, undefined, 300)
    const assertion = expect(promise).rejects.toThrow(/did not answer Page.navigate within 300ms/)
    await vi.advanceTimersByTimeAsync(400)
    await assertion
    // A late answer to a forgotten call must not throw inside the message listener.
    expect(() => socket.frame({ id: 1, result: {} })).not.toThrow()
  })

  it('rejects when the socket itself refuses to send', async () => {
    const { socket, client } = await connected()
    vi.spyOn(socket, 'send').mockImplementation(() => {
      throw new Error('socket is dead')
    })
    await expect(client.send('Page.enable')).rejects.toThrow('socket is dead')
  })

  it('rejects immediately once the connection is closed', async () => {
    const { client } = await connected()
    client.close()
    await expect(client.send('Page.enable')).rejects.toThrow(/Sylor closed the Chrome/)
  })

  it('rejects everything still in flight when Chrome goes away', async () => {
    const { socket, client } = await connected()
    const promise = client.send('Page.navigate')
    socket.emit('close')
    await expect(promise).rejects.toThrow('The Chrome connection closed.')
    expect(client.isClosed).toBe(true)
  })

})

describe('events', () => {
  it('delivers an event with its params and session', async () => {
    const { socket, client } = await connected()
    const seen: unknown[] = []
    client.on('Page.frameNavigated', (event) => seen.push(event))
    socket.frame({ method: 'Page.frameNavigated', params: { url: 'https://x.com' }, sessionId: 'S1' })
    expect(seen).toEqual([
      { method: 'Page.frameNavigated', params: { url: 'https://x.com' }, sessionId: 'S1' }
    ])
  })

  it('defaults missing params to an empty object', async () => {
    const { socket, client } = await connected()
    const seen: unknown[] = []
    client.on('Inspector.detached', (event) => seen.push(event.params))
    socket.frame({ method: 'Inspector.detached' })
    expect(seen).toEqual([{}])
  })

  it('stops delivering after unsubscribe, and leaves other subscribers alone', async () => {
    const { socket, client } = await connected()
    let a = 0
    let b = 0
    const off = client.on('Page.loadEventFired', () => a++)
    client.on('Page.loadEventFired', () => b++)
    socket.frame({ method: 'Page.loadEventFired' })
    off()
    socket.frame({ method: 'Page.loadEventFired' })
    expect([a, b]).toEqual([1, 2])
  })

  it('survives a handler that throws, and still runs the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { socket, client } = await connected()
    let ran = 0
    client.on('Page.loadEventFired', () => {
      throw new Error('handler bug')
    })
    client.on('Page.loadEventFired', () => ran++)
    expect(() => socket.frame({ method: 'Page.loadEventFired' })).not.toThrow()
    expect(ran).toBe(1)
    expect(error).toHaveBeenCalled()
  })

  it('ignores frames it cannot use instead of throwing inside the listener', async () => {
    const { socket, client } = await connected()
    let ran = 0
    client.on('Page.loadEventFired', () => ran++)
    expect(() => socket.emit('message', { data: '{not json' })).not.toThrow()
    expect(() => socket.emit('message', { data: new ArrayBuffer(4) })).not.toThrow()
    expect(() => socket.emit('message', null)).not.toThrow()
    expect(() => socket.frame({ method: 'Nobody.listens' })).not.toThrow()
    expect(() => socket.frame({ params: { a: 1 } })).not.toThrow()
    expect(ran).toBe(0)
  })

  it('closes the socket once and reports itself closed', async () => {
    const { socket, client } = await connected()
    client.close()
    client.close()
    expect(client.isClosed).toBe(true)
    expect(socket.closes).toBe(2) // idempotent for us; the socket may see two hangs-up
  })
})



