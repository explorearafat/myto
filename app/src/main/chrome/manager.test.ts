/**
 * The manager's job is lifetime: start once, share one window, and never keep driving a
 * browser the user has closed. All of that is tested with fakes — no Chrome involved.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  ChromeManager,
  PROFILE_SETTLE_MS,
  SIGN_IN_URL,
  type ChromeStatus,
  type ManagerDeps
} from './manager'
import type { ChromePage, PageState } from './page'
import type { CdpClient } from './cdp'
import type { LaunchedProcess, RunningBrowser } from './launch'

const BROWSER = { path: '/usr/bin/google-chrome', name: 'Google Chrome' }

/** A page whose state we can push, and whose calls we can read back. */
function fakePage(): ChromePage & {
  push: (state: Partial<PageState>) => void
  log: string[]
  closes: number
} {
  const listeners = new Set<(state: PageState) => void>()
  let state: PageState = { url: 'about:blank', title: '', loading: false }
  const log: string[] = []
  const page = {
    targetId: 'T1',
    sessionId: 'S1',
    log,
    closes: 0,
    get snapshot() {
      return { ...state }
    },
    onStateChange(listener: (s: PageState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push(next: Partial<PageState>) {
      state = { ...state, ...next }
      for (const listener of [...listeners]) listener({ ...state })
    },
    navigate: async (url: string) => void log.push(`navigate ${url}`),
    evaluate: async (expression: string) => {
      log.push(`evaluate ${expression}`)
      return 'ok'
    },
    screenshot: async () => 'data:image/png;base64,AA',
    reload: async () => void log.push('reload'),
    stop: async () => void log.push('stop'),
    go: async (delta: number) => {
      log.push(`go ${delta}`)
      return true
    },
    focus: async () => void log.push('focus'),
    close: async () => {
      page.closes++
    }
  }
  return page as unknown as ChromePage & typeof page
}

/** A fake CDP client that records subscriptions so tests can fire lifecycle events. */
function fakeClient(): CdpClient & { fire: (m: string, p?: object) => void; closes: number } {
  const handlers = new Map<string, Set<(event: { method: string; params: object }) => void>>()
  const client = {
    closes: 0,
    on(method: string, handler: (event: { method: string; params: object }) => void) {
      const set = handlers.get(method) ?? new Set()
      set.add(handler)
      handlers.set(method, set)
      return () => set.delete(handler)
    },
    fire(method: string, params: object = {}) {
      for (const handler of [...(handlers.get(method) ?? [])]) handler({ method, params })
    },
    send: async () => ({}),
    close() {
      client.closes++
    }
  }
  return client as unknown as CdpClient & typeof client
}

/** A fake launched browser whose exit we can trigger. */
function fakeRunning(browser = BROWSER): RunningBrowser & { exit: () => void; kills: number } {
  const exits: Array<() => void> = []
  const running = {
    browser,
    port: 54321,
    webSocketDebuggerUrl: 'ws://127.0.0.1:54321/devtools/browser/abc',
    kills: 0,
    exit: () => {
      for (const listener of [...exits]) listener()
    },
    process: {
      pid: 1,
      // A killed browser really does exit, and the sign-in handover waits for that
      // event — so the fake has to fire it, or the wait would be untested.
      kill: () => {
        running.kills++
        running.exit()
      },
      on: (_e: 'exit', listener: () => void) => void exits.push(listener)
    }
  }
  return running as unknown as RunningBrowser & typeof running
}

/** A manager wired to fakes, with everything the tests want to inspect. */
function harness(overrides: Partial<ManagerDeps> = {}) {
  const page = fakePage()
  const client = fakeClient()
  const running = fakeRunning()
  const statuses: ChromeStatus[] = []
  const launches: string[] = []
  const deps: ManagerDeps = {
    locate: () => BROWSER,
    launch: async (browser) => {
      launches.push(browser.name)
      return running
    },
    connect: async () => client,
    open: async () => page,
    onStatus: (status) => statuses.push(status),
    ...overrides
  }
  return { manager: new ChromeManager(deps), page, client, running, statuses, launches }
}

describe('status', () => {
  it('reports an available browser before anything is started', () => {
    const { manager } = harness()
    expect(manager.status()).toEqual({
      available: true,
      browserName: 'Google Chrome',
      running: false,
      url: '',
      title: '',
      loading: false,
      signingIn: false,
      error: null
    })
  })

  it('reports nothing available when no browser is installed', () => {
    const { manager } = harness({ locate: () => null })
    expect(manager.status()).toMatchObject({ available: false, browserName: '' })
  })

  it('treats a locator that throws as "none found"', () => {
    const { manager } = harness({
      locate: () => {
        throw new Error('registry exploded')
      }
    })
    expect(manager.status().available).toBe(false)
  })

  it('mirrors the page state once running', async () => {
    const { manager, page, statuses } = harness()
    await manager.ensure()
    page.push({ url: 'https://mail.google.com/', title: 'Inbox', loading: true })
    expect(manager.status()).toMatchObject({
      running: true,
      url: 'https://mail.google.com/',
      title: 'Inbox',
      loading: true
    })
    expect(statuses[statuses.length - 1].url).toBe('https://mail.google.com/')
  })
})

describe('ensure', () => {
  it('launches once and reuses the same tab', async () => {
    const { manager, page, launches } = harness()
    expect(await manager.ensure()).toBe(page)
    expect(await manager.ensure()).toBe(page)
    expect(launches).toEqual(['Google Chrome'])
  })

  it('shares one start between parallel callers', async () => {
    const { manager, launches } = harness()
    const [a, b, c] = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(launches).toHaveLength(1)
  })

  it('passes a first url through to the tab', async () => {
    const opens: unknown[] = []
    const page = fakePage()
    const { manager } = harness({
      open: async (_client, options) => {
        opens.push(options)
        return page
      }
    })
    await manager.ensure('https://mail.google.com')
    expect(opens).toEqual([{ url: 'https://mail.google.com' }])
  })

  it('explains itself when there is no browser to drive', async () => {
    const { manager, statuses } = harness({ locate: () => null })
    await expect(manager.ensure()).rejects.toThrow(/No Chrome, Edge or Chromium was found/)
    expect(statuses[0].error).toMatch(/No Chrome, Edge or Chromium was found/)
    expect(manager.status().running).toBe(false)
  })

  it('records a launch failure and stays startable', async () => {
    let attempt = 0
    const page = fakePage()
    const { manager } = harness({
      launch: async () => {
        if (++attempt === 1) throw new Error('Chrome closed before it was ready')
        return fakeRunning()
      },
      open: async () => page
    })
    await expect(manager.ensure()).rejects.toThrow('Chrome closed before it was ready')
    expect(manager.status()).toMatchObject({
      running: false,
      error: 'Chrome closed before it was ready'
    })
    expect(await manager.ensure()).toBe(page)
    expect(manager.status().error).toBeNull()
  })
})

describe('when the browser goes away', () => {
  it('forgets the tab when the user closes the window', async () => {
    const { manager, running, statuses } = harness()
    await manager.ensure()
    running.exit()
    expect(manager.status().running).toBe(false)
    expect(statuses[statuses.length - 1].running).toBe(false)
  })

  it('forgets the tab when the debugger detaches', async () => {
    const { manager, client } = harness()
    await manager.ensure()
    client.fire('Inspector.detached', { reason: 'target_closed' })
    expect(manager.status().running).toBe(false)
  })

  it('forgets it when our own session detaches, but ignores another session', async () => {
    const { manager, client } = harness()
    await manager.ensure()
    client.fire('Target.detachedFromTarget', { sessionId: 'OTHER' })
    expect(manager.status().running).toBe(true)
    client.fire('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(manager.status().running).toBe(false)
  })

  it('stops mirroring state from the abandoned tab', async () => {
    const { manager, page, running } = harness()
    await manager.ensure()
    running.exit()
    page.push({ url: 'https://ghost.example', loading: true })
    expect(manager.status()).toMatchObject({ url: '', loading: false })
  })

  it('starts a fresh browser on the next request', async () => {
    const first = fakePage()
    const second = fakePage()
    const pages = [first, second]
    const { manager, running, launches } = harness({ open: async () => pages.shift()! })
    expect(await manager.ensure()).toBe(first)
    running.exit()
    expect(await manager.ensure()).toBe(second)
    expect(launches).toHaveLength(2)
  })
})

describe('actions', () => {
  it('starts the browser on the first action and forwards each call', async () => {
    const { manager, page, launches } = harness()
    await manager.navigate('https://mail.google.com')
    await manager.evaluate('document.title')
    await manager.reload()
    await manager.stopLoading()
    await manager.go(-1)
    await manager.focus()
    expect(launches).toHaveLength(1)
    expect(page.log).toEqual([
      'navigate https://mail.google.com',
      'evaluate document.title',
      'reload',
      'stop',
      'go -1',
      'focus'
    ])
    await expect(manager.screenshot()).resolves.toBe('data:image/png;base64,AA')
  })

  it('does not turn a page-side failure into a lifecycle error', async () => {
    const page = fakePage()
    page.evaluate = vi.fn().mockRejectedValue(new Error('TypeError: el is null'))
    const { manager } = harness({ open: async () => page })
    await expect(manager.evaluate('el.click()')).rejects.toThrow('TypeError: el is null')
    expect(manager.status()).toMatchObject({ running: true, error: null })
  })
})

describe('close', () => {
  it('closes the tab, hangs up, and kills the browser', async () => {
    const { manager, page, client, running, statuses } = harness()
    await manager.ensure()
    await manager.close()
    expect(page.closes).toBe(1)
    expect(client.closes).toBe(1)
    expect(running.kills).toBe(1)
    expect(manager.status().running).toBe(false)
    expect(statuses[statuses.length - 1].running).toBe(false)
  })

  it('is safe when nothing was ever started, and when everything is already gone', async () => {
    const { manager, running } = harness()
    await expect(manager.close()).resolves.toBeUndefined()
    await manager.ensure()
    running.exit()
    await expect(manager.close()).resolves.toBeUndefined()
  })

  it('still kills the browser when closing the tab fails', async () => {
    const page = fakePage()
    page.close = vi.fn().mockRejectedValue(new Error('target closed'))
    const { manager, running, client } = harness({ open: async () => page })
    await manager.ensure()
    await manager.close()
    expect(client.closes).toBe(1)
    expect(running.kills).toBe(1)
  })
})

/**
 * A stand-in for the clean sign-in window: no port, no CDP, just a process whose
 * exit we can fire the way Chrome would when the user closes it.
 */
function fakeSignInWindow(): LaunchedProcess & { kills: number; exit: () => void } {
  const exits: Array<() => void> = []
  const child = {
    pid: 2,
    kills: 0,
    kill: () => {
      child.kills++
    },
    on: (_event: 'exit', listener: () => void) => void exits.push(listener),
    exit: () => {
      for (const listener of [...exits]) listener()
    }
  }
  return child as unknown as LaunchedProcess & typeof child
}

/** A manager whose sign-in launcher is a fake, plus the window it hands back. */
function signInHarness(overrides: Partial<ManagerDeps> = {}) {
  const child = fakeSignInWindow()
  const signInUrls: string[] = []
  const base = harness({
    launchForSignIn: (_browser, url) => {
      signInUrls.push(url)
      return child
    },
    // No real waiting: the profile handover is timed by the exit event, and the delay
    // is only a cushion. A test that needs to prove the wait overrides this.
    wait: async () => {},
    ...overrides
  })
  return { ...base, child, signInUrls }
}

describe('signIn', () => {
  it('lets go of the browser, opens an undriven window, and says so', async () => {
    const { manager, running, page, client, signInUrls, statuses } = signInHarness()
    await manager.ensure()

    await manager.signIn()

    // The driven window has to go: a debugging port anywhere on this profile is what
    // Google refuses, so it cannot merely be backgrounded.
    expect(page.closes).toBe(1)
    expect(client.closes).toBe(1)
    expect(running.kills).toBe(1)
    expect(signInUrls).toEqual([SIGN_IN_URL])
    expect(manager.status()).toMatchObject({ signingIn: true, running: false })
    expect(statuses[statuses.length - 1].signingIn).toBe(true)
  })

  it('opens at a specific url when one is asked for', async () => {
    const { manager, signInUrls } = signInHarness()
    await manager.signIn('https://github.com/login')
    expect(signInUrls).toEqual(['https://github.com/login'])
  })

  // Chrome is single-instance per profile: a second launch while the first still holds
  // it hands over the url and exits, which reads to the user as a window that flashed
  // and vanished. So the sign-in window must not open until the driven one is gone.
  it('waits for the driven browser to release the profile', async () => {
    const running = fakeRunning()
    // A browser that has not exited yet — killing it only asks it to.
    ;(running.process as { kill: () => void }).kill = () => {
      running.kills++
    }
    const child = fakeSignInWindow()
    const signInUrls: string[] = []
    const { manager } = harness({
      launch: async () => running,
      launchForSignIn: (_browser, url) => {
        signInUrls.push(url)
        return child
      },
      // The release cap never fires, so the exit event is the only way through.
      wait: (ms) => (ms === PROFILE_SETTLE_MS ? Promise.resolve() : new Promise<void>(() => {}))
    })
    await manager.ensure()

    const pending = manager.signIn()
    await Promise.resolve()
    expect(signInUrls).toEqual([])

    running.exit()
    await pending
    expect(signInUrls).toEqual([SIGN_IN_URL])
    expect(manager.status().signingIn).toBe(true)
  })

  it('takes the profile back when the user closes that window', async () => {
    const { manager, child, launches } = signInHarness()
    await manager.signIn()
    expect(manager.status().signingIn).toBe(true)

    child.exit()
    await vi.waitFor(() => expect(manager.status().running).toBe(true))
    expect(manager.status().signingIn).toBe(false)
    expect(launches).toHaveLength(1)
  })

  it('ignores a second request while a window is already open', async () => {
    const { manager, signInUrls } = signInHarness()
    await manager.signIn()
    await manager.signIn('https://example.com/login')
    expect(signInUrls).toEqual([SIGN_IN_URL])
  })

  it('explains itself when there is no browser to sign in with', async () => {
    const { manager } = signInHarness({ locate: () => null })
    await expect(manager.signIn()).rejects.toThrow(/No Chrome, Edge or Chromium was found/)
    expect(manager.status().signingIn).toBe(false)
  })

  it('reports a build with no sign-in launcher rather than pretending', async () => {
    const { manager } = harness()
    await expect(manager.signIn()).rejects.toThrow(/not available in this build/)
  })
})

describe('finishSignIn', () => {
  // One resume path, not two: "Done" closes the window and lets its own exit handler
  // reopen the driven one, so the user closing it by hand behaves identically.
  it('closes the window, and its exit brings the driven one back', async () => {
    const { manager, child } = signInHarness()
    await manager.signIn()

    await manager.finishSignIn()
    expect(child.kills).toBe(1)
    child.exit()

    await vi.waitFor(() => expect(manager.status().running).toBe(true))
    expect(manager.status().signingIn).toBe(false)
  })

  it('just opens the browser when no sign-in window is standing', async () => {
    const { manager, launches } = signInHarness()
    await manager.finishSignIn()
    expect(launches).toEqual(['Google Chrome'])
    expect(manager.status().running).toBe(true)
  })
})

describe('shutdown', () => {
  it('leaves nothing behind — the sign-in window included', async () => {
    const { manager, child, running } = signInHarness()
    await manager.ensure()
    await manager.signIn()

    await manager.shutdown()
    expect(child.kills).toBe(1)
    expect(manager.status()).toMatchObject({ running: false, signingIn: false })
    // The driven window was already killed by signIn; shutdown must not double-kill.
    expect(running.kills).toBe(1)
  })

  it('is safe with nothing running at all', async () => {
    const { manager } = signInHarness()
    await expect(manager.shutdown()).resolves.toBeUndefined()
  })
})





