/**
 * The launch handshake — what Chrome is told, and how we learn it is ready — with a
 * fake process, a fake profile directory, and a fake clock.
 */
import { describe, it, expect } from 'vitest'
import {
  activePortFile,
  chromeArgs,
  launchBrowser,
  launchForSignIn,
  parseActivePort,
  type LaunchedProcess
} from './launch'

const BROWSER = { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'Google Chrome' }
const PROFILE = 'C:\\Users\\A\\AppData\\Roaming\\Sylor\\sylorium-chrome'

class FakeChrome implements LaunchedProcess {
  pid = 4321
  kills = 0
  private exitListeners: Array<() => void> = []
  private exited = false

  kill(): void {
    this.kills++
  }

  on(_event: 'exit', listener: () => void): void {
    // A process that has already died still reports that to a late subscriber.
    if (this.exited) {
      listener()
      return
    }
    this.exitListeners.push(listener)
  }

  /** Pretend the browser quit. */
  exit(): void {
    this.exited = true
    for (const listener of [...this.exitListeners]) listener()
  }
}

/** A fake clock driven by the injected delay, so timeouts are deterministic. */
function clock(): { now: () => number; delay: (ms: number) => Promise<void> } {
  let t = 0
  return {
    now: () => t,
    delay: async (ms) => {
      t += ms
    }
  }
}

describe('activePortFile', () => {
  it('joins with the separator the directory already uses', () => {
    expect(activePortFile('C:\\p\\profile')).toBe('C:\\p\\profile\\DevToolsActivePort')
    expect(activePortFile('/home/a/profile')).toBe('/home/a/profile/DevToolsActivePort')
  })

  it('does not double a trailing separator', () => {
    expect(activePortFile('C:\\p\\profile\\')).toBe('C:\\p\\profile\\DevToolsActivePort')
    expect(activePortFile('/home/a/profile//')).toBe('/home/a/profile/DevToolsActivePort')
  })
})

describe('parseActivePort', () => {
  it('reads the port and the browser socket path', () => {
    expect(parseActivePort('54321\n/devtools/browser/abc-123')).toEqual({
      port: 54321,
      wsPath: '/devtools/browser/abc-123'
    })
  })

  it('tolerates CRLF and a trailing newline', () => {
    expect(parseActivePort('54321\r\n/devtools/browser/x\r\n')).toEqual({
      port: 54321,
      wsPath: '/devtools/browser/x'
    })
  })

  it('returns null while the file is half-written or nonsense', () => {
    expect(parseActivePort('')).toBeNull()
    expect(parseActivePort('54321')).toBeNull()
    expect(parseActivePort('54321\n')).toBeNull()
    expect(parseActivePort('\n/devtools/browser/x')).toBeNull()
    expect(parseActivePort('not-a-port\n/devtools/browser/x')).toBeNull()
    expect(parseActivePort('0\n/devtools/browser/x')).toBeNull()
    expect(parseActivePort('54321\ndevtools/browser/x')).toBeNull()
  })
})

describe('chromeArgs', () => {
  it('asks Chrome to pick the port and to use our own profile', () => {
    const args = chromeArgs(PROFILE)
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain(`--user-data-dir=${PROFILE}`)
    expect(args[args.length - 1]).toBe('about:blank')
  })

  it('never weakens the browser', () => {
    const args = chromeArgs(PROFILE).join(' ')
    expect(args).not.toMatch(/disable-web-security|allow-running-insecure|remote-allow-origins|remote-debugging-address/)
  })

  it('puts extra flags before the start url', () => {
    const args = chromeArgs(PROFILE, 'https://mail.google.com', ['--start-maximized'])
    expect(args.slice(-2)).toEqual(['--start-maximized', 'https://mail.google.com'])
  })

  // The whole point of the sign-in window: Google refuses to sign in to a browser
  // with a debugging port open, so that one flag — and only that one — comes off.
  it('omits the debugging port when asked for an undriven window', () => {
    const args = chromeArgs(PROFILE, 'https://accounts.google.com/', [], false)
    expect(args.join(' ')).not.toContain('--remote-debugging-port')
    expect(args).toContain(`--user-data-dir=${PROFILE}`)
    expect(args[args.length - 1]).toBe('https://accounts.google.com/')
  })
})

describe('launchForSignIn', () => {
  it('spawns the same profile with no port, and does not wait for one', () => {
    const child = new FakeChrome()
    const spawned: Array<{ path: string; args: string[] }> = []
    const process = launchForSignIn({
      browser: BROWSER,
      userDataDir: PROFILE,
      spawn: (path, args) => {
        spawned.push({ path, args })
        return child
      },
      startUrl: 'https://accounts.google.com/'
    })

    expect(process).toBe(child)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].path).toBe(BROWSER.path)
    expect(spawned[0].args.join(' ')).not.toContain('--remote-debugging-port')
    // Same profile as the driven window — that is what makes the sign-in stick.
    expect(spawned[0].args).toContain(`--user-data-dir=${PROFILE}`)
  })
})

describe('launchBrowser', () => {
  it('spawns the browser and resolves once the port file appears', async () => {
    const child = new FakeChrome()
    const spawned: Array<{ path: string; args: string[] }> = []
    let reads = 0
    const running = await launchBrowser({
      browser: BROWSER,
      userDataDir: PROFILE,
      spawn: (path, args) => {
        spawned.push({ path, args })
        return child
      },
      readFile: () => (++reads < 3 ? null : '54321\n/devtools/browser/abc'),
      ...clock()
    })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].path).toBe(BROWSER.path)
    expect(spawned[0].args).toContain(`--user-data-dir=${PROFILE}`)
    expect(running.port).toBe(54321)
    expect(running.webSocketDebuggerUrl).toBe('ws://127.0.0.1:54321/devtools/browser/abc')
    expect(running.process).toBe(child)
  })

  it('deletes the previous run’s port file before spawning', async () => {
    const removed: string[] = []
    const order: string[] = []
    await launchBrowser({
      browser: BROWSER,
      userDataDir: PROFILE,
      removeFile: (p) => {
        removed.push(p)
        order.push('remove')
      },
      spawn: () => {
        order.push('spawn')
        return new FakeChrome()
      },
      readFile: () => '1\n/devtools/browser/x',
      ...clock()
    })
    expect(removed).toEqual([`${PROFILE}\\DevToolsActivePort`])
    expect(order).toEqual(['remove', 'spawn'])
  })

  it('still launches when the stale file cannot be deleted', async () => {
    const running = await launchBrowser({
      browser: BROWSER,
      userDataDir: PROFILE,
      removeFile: () => {
        throw new Error('EPERM')
      },
      spawn: () => new FakeChrome(),
      readFile: () => '2\n/devtools/browser/y',
      ...clock()
    })
    expect(running.port).toBe(2)
  })

  it('waits through a read error (the file is being written)', async () => {
    let reads = 0
    const running = await launchBrowser({
      browser: BROWSER,
      userDataDir: PROFILE,
      spawn: () => new FakeChrome(),
      readFile: () => {
        if (++reads < 2) throw new Error('EBUSY')
        return '3\n/devtools/browser/z'
      },
      ...clock()
    })
    expect(running.port).toBe(3)
  })

  it('fails when the browser quits before it is ready', async () => {
    const child = new FakeChrome()
    await expect(
      launchBrowser({
        browser: BROWSER,
        userDataDir: PROFILE,
        spawn: () => {
          child.exit()
          return child
        },
        readFile: () => null,
        ...clock()
      })
    ).rejects.toThrow('Google Chrome closed before it was ready to be controlled.')
  })

  it('gives up and kills the browser when no port ever appears', async () => {
    const child = new FakeChrome()
    await expect(
      launchBrowser({
        browser: BROWSER,
        userDataDir: PROFILE,
        spawn: () => child,
        readFile: () => null,
        timeoutMs: 500,
        ...clock()
      })
    ).rejects.toThrow(/did not open a debugging port within 500ms/)
    expect(child.kills).toBe(1)
  })

  it('accepts a port that lands on the very last poll', async () => {
    let reads = 0
    const running = await launchBrowser({
      browser: BROWSER,
      userDataDir: PROFILE,
      spawn: () => new FakeChrome(),
      // 200ms of polling at 50ms, then the file: still inside a 250ms budget.
      readFile: () => (++reads <= 4 ? null : '9\n/devtools/browser/last'),
      timeoutMs: 250,
      ...clock()
    })
    expect(running.port).toBe(9)
  })

})


