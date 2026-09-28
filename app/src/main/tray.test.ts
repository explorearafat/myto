import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * tray.ts imports several electron main-process APIs. Under vitest there's no real
 * Electron, so we stub the pieces the module touches with lightweight fakes that let us
 * assert the keep-alive lifecycle without a display: a Tray that records construct/destroy,
 * a nativeImage whose images are always "empty" (so we exercise the missing-icon fallback),
 * and an app.quit spy. State in tray.ts is module-level (a singleton tray + a `quitting`
 * latch), so each test re-imports the module fresh via resetModules for isolation.
 */
const hoisted = vi.hoisted(() => {
  const trayInstances: Array<{ destroyed: boolean }> = []
  return { trayInstances }
})

class FakeTray {
  destroyed = false
  constructor() {
    hoisted.trayInstances.push(this)
  }
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {
    this.destroyed = true
  }
}

const quitSpy = vi.fn()

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    quit: () => quitSpy()
  },
  Menu: { buildFromTemplate: (t: unknown) => ({ template: t }) },
  Tray: FakeTray,
  nativeImage: {
    // Always "empty" → drives the createEmpty() fallback path (no real asset in tests).
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
    createEmpty: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) })
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

async function freshModule() {
  vi.resetModules()
  hoisted.trayInstances.length = 0
  quitSpy.mockClear()
  return import('@main/tray')
}

describe('tray keep-alive lifecycle', () => {
  beforeEach(() => {
    hoisted.trayInstances.length = 0
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shouldKeepAlive mirrors the flag while not quitting', async () => {
    const tray = await freshModule()
    expect(tray.shouldKeepAlive(false)).toBe(false)
    expect(tray.shouldKeepAlive(true)).toBe(true)
  })

  it('applyTrayState(true) builds a tray; applyTrayState(false) tears it down', async () => {
    const tray = await freshModule()
    tray.applyTrayState(true)
    expect(hoisted.trayInstances).toHaveLength(1)
    expect(hoisted.trayInstances[0].destroyed).toBe(false)

    tray.applyTrayState(false)
    expect(hoisted.trayInstances[0].destroyed).toBe(true)
  })

  it('applyTrayState(true) is idempotent — a second call reuses the one tray', async () => {
    const tray = await freshModule()
    tray.applyTrayState(true)
    tray.applyTrayState(true)
    expect(hoisted.trayInstances).toHaveLength(1)
  })

  it('once quitting, keep-alive is refused and no tray is built', async () => {
    const tray = await freshModule()
    tray.markQuitting()
    expect(tray.isQuitting()).toBe(true)
    expect(tray.shouldKeepAlive(true)).toBe(false)
    tray.applyTrayState(true)
    expect(hoisted.trayInstances).toHaveLength(0)
  })
})
