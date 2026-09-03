/**
 * The page adapter is what lets the existing Sylor stack drive real Chrome, so what
 * matters here is that it speaks the protocol correctly and that its mirrored state
 * (url / title / loading) tracks the events Chrome actually sends.
 */
import { describe, it, expect, vi } from 'vitest'
import { ChromePage, openPage, type PageState } from './page'
import type { CdpClient, CdpEvent } from './cdp'

class FakeClient {
  calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  answers = new Map<string, unknown>([
    ['Target.createTarget', { targetId: 'T1' }],
    ['Target.attachToTarget', { sessionId: 'S1' }],
    ['Page.getFrameTree', { frameTree: { frame: { id: 'F1', url: 'about:blank' } } }],
    ['Target.getTargetInfo', { targetInfo: { targetId: 'T1', url: 'about:blank', title: '' } }]
  ])
  private handlers = new Map<string, Set<(event: CdpEvent) => void>>()

  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.calls.push({ method, params, sessionId })
    const answer = this.answers.get(method)
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve((answer ?? {}) as T)
  }

  on(method: string, handler: (event: CdpEvent) => void): () => void {
    const set = this.handlers.get(method) ?? new Set<(event: CdpEvent) => void>()
    set.add(handler)
    this.handlers.set(method, set)
    return () => set.delete(handler)
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const handler of [...(this.handlers.get(method) ?? [])]) handler({ method, params })
  }

  methods(): string[] {
    return this.calls.map((c) => c.method)
  }

  /** The first call to `method`, without the method name — just what was sent with it. */
  call(method: string): { params?: Record<string, unknown>; sessionId?: string } | undefined {
    const found = this.calls.find((c) => c.method === method)
    return found ? { params: found.params, sessionId: found.sessionId } : undefined
  }

  as(): CdpClient {
    return this as unknown as CdpClient
  }
}

/** A fake client plus an attached page. */
async function attached(): Promise<{ client: FakeClient; page: ChromePage }> {
  const client = new FakeClient()
  return { client, page: await openPage(client.as()) }
}

describe('openPage', () => {
  it('opens a quiet tab, attaches flattened, and enables Page in that session', async () => {
    const { client, page } = await attached()
    expect(client.methods()).toEqual([
      'Target.setDiscoverTargets',
      'Target.createTarget',
      'Target.attachToTarget',
      'Page.enable',
      'Page.getFrameTree',
      'Target.getTargetInfo'
    ])
    expect(client.call('Target.createTarget')?.params).toEqual({ url: 'about:blank' })
    expect(client.call('Target.attachToTarget')?.params).toEqual({
      targetId: 'T1',
      flatten: true
    })
    expect(client.call('Page.enable')?.sessionId).toBe('S1')
    expect(page.targetId).toBe('T1')
    expect(page.sessionId).toBe('S1')
  })

  it('seeds url and title from the target info', async () => {
    const client = new FakeClient()
    client.answers.set('Target.getTargetInfo', {
      targetInfo: { targetId: 'T1', url: 'https://mail.google.com/', title: 'Inbox' }
    })
    const page = await openPage(client.as())
    expect(page.snapshot).toEqual({ url: 'https://mail.google.com/', title: 'Inbox', loading: false })
  })

  it('opens at a url when asked', async () => {
    const client = new FakeClient()
    await openPage(client.as(), { url: 'https://mail.google.com' })
    expect(client.call('Target.createTarget')?.params).toEqual({ url: 'https://mail.google.com' })
  })

  it('adopts an existing tab without creating one', async () => {
    const client = new FakeClient()
    const page = await openPage(client.as(), { targetId: 'EXISTING' })
    expect(client.methods()).not.toContain('Target.createTarget')
    expect(page.targetId).toBe('EXISTING')
  })

  it('fails loudly when Chrome opens no tab or refuses to attach', async () => {
    const noTab = new FakeClient()
    noTab.answers.set('Target.createTarget', {})
    await expect(openPage(noTab.as())).rejects.toThrow('Chrome did not open a tab.')
    const noSession = new FakeClient()
    noSession.answers.set('Target.attachToTarget', {})
    await expect(openPage(noSession.as())).rejects.toThrow(/could not attach/)
  })
})

describe('mirrored state', () => {
  it('follows url and title for its own target, and ignores other tabs', async () => {
    const { client, page } = await attached()
    client.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'T1', url: 'https://x.com/home', title: 'Home' }
    })
    expect(page.snapshot).toMatchObject({ url: 'https://x.com/home', title: 'Home' })
    client.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'OTHER', url: 'https://evil.example', title: 'Nope' }
    })
    expect(page.snapshot.url).toBe('https://x.com/home')
  })

  it('tracks loading for the main frame only', async () => {
    const { client, page } = await attached()
    client.emit('Page.frameStartedLoading', { frameId: 'IFRAME' })
    expect(page.snapshot.loading).toBe(false)
    client.emit('Page.frameStartedLoading', { frameId: 'F1' })
    expect(page.snapshot.loading).toBe(true)
    client.emit('Page.frameStoppedLoading', { frameId: 'IFRAME' })
    expect(page.snapshot.loading).toBe(true)
    client.emit('Page.frameStoppedLoading', { frameId: 'F1' })
    expect(page.snapshot.loading).toBe(false)
  })

  it('adopts the new main frame id after a cross-process navigation', async () => {
    const { client, page } = await attached()
    client.emit('Page.frameNavigated', { frame: { id: 'F2', url: 'https://mail.google.com/' } })
    expect(page.snapshot.url).toBe('https://mail.google.com/')
    client.emit('Page.frameStartedLoading', { frameId: 'F2' })
    expect(page.snapshot.loading).toBe(true)
  })

  it('ignores a subframe navigation', async () => {
    const { client, page } = await attached()
    client.emit('Page.frameNavigated', {
      frame: { id: 'SUB', parentId: 'F1', url: 'https://ads.example/frame' }
    })
    expect(page.snapshot.url).toBe('about:blank')
  })

  it('notifies subscribers on change only, and stops after unsubscribe', async () => {
    const { client, page } = await attached()
    const seen: PageState[] = []
    const off = page.onStateChange((state) => seen.push(state))
    client.emit('Page.frameStartedLoading', { frameId: 'F1' })
    client.emit('Page.frameStartedLoading', { frameId: 'F1' }) // no change → no callback
    off()
    client.emit('Page.frameStoppedLoading', { frameId: 'F1' })
    expect(seen).toEqual([{ url: 'about:blank', title: '', loading: true }])
  })

  it('survives a subscriber that throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, page } = await attached()
    page.onStateChange(() => {
      throw new Error('listener bug')
    })
    let ran = 0
    page.onStateChange(() => ran++)
    expect(() => client.emit('Page.frameStartedLoading', { frameId: 'F1' })).not.toThrow()
    expect(ran).toBe(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('actions', () => {
  it('navigates in the tab session and marks itself loading straight away', async () => {
    const { client, page } = await attached()
    const promise = page.navigate('https://mail.google.com')
    expect(page.snapshot.loading).toBe(true)
    await promise
    expect(client.call('Page.navigate')).toEqual({
      params: { url: 'https://mail.google.com' },
      sessionId: 'S1'
    })
  })

  it('reports Chrome’s own reason when a load is refused', async () => {
    const { client, page } = await attached()
    client.answers.set('Page.navigate', { errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    await expect(page.navigate('https://nope.invalid')).rejects.toThrow(
      'https://nope.invalid could not be loaded: net::ERR_NAME_NOT_RESOLVED'
    )
  })

  it('evaluates by value, awaiting promises, as a user gesture', async () => {
    const { client, page } = await attached()
    client.answers.set('Runtime.evaluate', { result: { value: { title: 'Inbox' } } })
    await expect(page.evaluate('document.title')).resolves.toEqual({ title: 'Inbox' })
    expect(client.call('Runtime.evaluate')).toEqual({
      params: {
        expression: 'document.title',
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      },
      sessionId: 'S1'
    })
  })

  it('throws a page-side exception, like the webview version does', async () => {
    const { client, page } = await attached()
    client.answers.set('Runtime.evaluate', {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: el is null' } }
    })
    await expect(page.evaluate('el.click()')).rejects.toThrow('TypeError: el is null')
  })

  it('falls back to the exception text when there is no description', async () => {
    const { client, page } = await attached()
    client.answers.set('Runtime.evaluate', { exceptionDetails: { text: 'Uncaught SyntaxError' } })
    await expect(page.evaluate('!!!')).rejects.toThrow('Uncaught SyntaxError')
  })

  it('returns a png data url, and refuses an empty capture', async () => {
    const { client, page } = await attached()
    client.answers.set('Page.captureScreenshot', { data: 'AAAB' })
    await expect(page.screenshot()).resolves.toBe('data:image/png;base64,AAAB')
    client.answers.set('Page.captureScreenshot', {})
    await expect(page.screenshot()).rejects.toThrow(/empty screenshot/)
  })

  it('reloads and stops, keeping the loading mirror honest', async () => {
    const { client, page } = await attached()
    const reloading = page.reload(true)
    expect(page.snapshot.loading).toBe(true)
    await reloading
    expect(client.call('Page.reload')?.params).toEqual({ ignoreCache: true })
    await page.stop()
    expect(page.snapshot.loading).toBe(false)
  })

  it('steps back through history by entry id', async () => {
    const { client, page } = await attached()
    client.answers.set('Page.getNavigationHistory', {
      currentIndex: 1,
      entries: [{ id: 10 }, { id: 11 }]
    })
    await expect(page.go(-1)).resolves.toBe(true)
    expect(client.call('Page.navigateToHistoryEntry')?.params).toEqual({ entryId: 10 })
    expect(page.snapshot.loading).toBe(true)
  })

  it('reports there is nowhere to go at either end of history', async () => {
    const { client, page } = await attached()
    client.answers.set('Page.getNavigationHistory', { currentIndex: 0, entries: [{ id: 10 }] })
    await expect(page.go(-1)).resolves.toBe(false)
    await expect(page.go(1)).resolves.toBe(false)
    expect(client.methods()).not.toContain('Page.navigateToHistoryEntry')
  })

  it('brings the tab to the front', async () => {
    const { client, page } = await attached()
    await page.focus()
    expect(client.call('Target.activateTarget')?.params).toEqual({ targetId: 'T1' })
  })

  it('closes the tab once, unsubscribes, and swallows a browser that is already gone', async () => {
    const { client, page } = await attached()
    client.answers.set('Target.closeTarget', new Error('target closed'))
    await page.close()
    await page.close()
    expect(client.calls.filter((c) => c.method === 'Target.closeTarget')).toHaveLength(1)
    // Events after close must not resurrect the mirrored state.
    client.emit('Page.frameStartedLoading', { frameId: 'F1' })
    expect(page.snapshot.loading).toBe(false)
  })

})



